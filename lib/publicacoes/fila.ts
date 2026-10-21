/**
 * Publicações nas redes — a rodada da fila (chamada pelo cron `publicacoes`).
 *
 * Cada rodada:
 *   1. reivindica os posts vencidos (`fn_publicacoes_reivindicar`, SKIP LOCKED),
 *      pulando organização parada (a régua `idsDeOrgsParadas`);
 *   2. assina as URLs da mídia (a rede baixa de fora; 1h basta para ela buscar);
 *   3. pede ao ADAPTER da conta que publique — a feature pergunta se a conta
 *      sabe publicar (`publicarConteudo`), nunca qual rede ela é;
 *   4. grava o desfecho: publicado, ainda processando (volta para a fila com o
 *      container guardado), erro passageiro (volta com espera crescente) ou
 *      falha definitiva (aviso na Central).
 *
 * Toda leitura e escrita leva `organization_id` À MÃO: o cliente é de serviço.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { getAdapter } from "@/lib/channels";
import { ErroDePublicacao } from "@/lib/channels/publicacao";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels/session-ref";
import type { ChannelProvider } from "@/lib/channels/types";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";

import { BUCKET_DE_PUBLICACOES, midiaSchema, tipoDaMidia, type Formato } from "./esquema";

/** Posts por rodada. Cada um pode esperar ~25 s pelo container; o cron tem 60 s. */
const POR_RODADA = 2;
/** Validade da URL assinada que a rede usa para baixar a mídia. */
const URL_VALIDA_SEGUNDOS = 3600;
/** Erro passageiro: tenta de novo até aqui, com espera crescente. */
export const MAX_TENTATIVAS = 5;
/** Container processando: quantas rodadas esperar antes de desistir (~30 min). */
export const MAX_RODADAS_PROCESSANDO = 30;

export type DesfechoDaRodada = "publicado" | "processando" | "reagendado" | "falhou";

export interface ResultadoDoPost {
  organizationId: string;
  postId: string;
  desfecho: DesfechoDaRodada;
}

/** Espera antes da próxima tentativa: 2, 4, 8, 16 minutos. Pura, para o teste. */
export function esperaAntesDe(tentativa: number): number {
  return Math.min(2 ** Math.max(1, tentativa), 60) * 60_000;
}

interface LinhaDoPost {
  id: string;
  organization_id: string;
  channel_session_id: string | null;
  formato: Formato;
  legenda: string;
  midias: unknown;
  tentativas: number;
  id_container: string | null;
}

async function avisarFalha(admin: SupabaseClient, post: LinhaDoPost, motivo: string): Promise<void> {
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: post.organization_id,
    kind: "publicacao_falhou",
    severity: "warn",
    title: "Uma publicação agendada não saiu",
    body:
      `A rede recusou ou não concluiu um post agendado. Motivo: ${motivo} ` +
      "Nada foi publicado de novo automaticamente — abra as publicações, corrija e agende outra vez.",
  });
  if (error) {
    logger.error("[publicacoes] aviso de falha não entrou na Central", {
      organization_id: post.organization_id,
      post_id: post.id,
      error: error.message,
    });
  }
}

async function gravar(
  admin: SupabaseClient,
  post: LinhaDoPost,
  campos: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("publicacoes_posts")
    .update({ ...campos, updated_at: new Date().toISOString() })
    .eq("organization_id", post.organization_id)
    .eq("id", post.id);
  if (error) throw new Error(`publicacoes_gravar_falhou: ${error.message}`);
}

async function falhar(admin: SupabaseClient, post: LinhaDoPost, motivo: string): Promise<DesfechoDaRodada> {
  await gravar(admin, post, { status: "falhou", ultimo_erro: motivo.slice(0, 500), proxima_tentativa_em: null });
  await avisarFalha(admin, post, motivo);
  await audit({
    action: "publicacao.falhou",
    organizationId: post.organization_id,
    resourceType: "publicacoes_posts",
    resourceId: post.id,
    metadata: { tentativas: post.tentativas },
  });
  return "falhou";
}

async function processar(admin: SupabaseClient, post: LinhaDoPost, agora: Date): Promise<DesfechoDaRodada> {
  const midias = midiaSchema.array().safeParse(post.midias);
  if (!midias.success) return falhar(admin, post, "A lista de mídias do post está inválida.");
  if (!post.channel_session_id) return falhar(admin, post, "A conta do post foi desconectada.");

  const { data: sessao, error: erroSessao } = await admin
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("organization_id", post.organization_id)
    .eq("id", post.channel_session_id)
    .is("archived_at", null)
    .maybeSingle();
  if (erroSessao) throw new Error(`publicacoes_sessao_falhou: ${erroSessao.message}`);
  if (!sessao) return falhar(admin, post, "A conta do post foi desconectada.");

  const ref = sessao as unknown as ChannelSessionRef;
  const adapter = getAdapter(ref.provider as ChannelProvider);
  if (!adapter.publicarConteudo) {
    return falhar(admin, post, "Esta conta não publica conteúdo (só conversa).");
  }

  // A rede baixa a mídia de FORA: URL assinada, temporária, do bucket privado.
  const assinadas: { url: string; tipo: "imagem" | "video" }[] = [];
  for (const m of midias.data) {
    // O caminho começa pela organização (rota de upload); conferir de novo aqui
    // impede que um caminho de outra organização seja assinado por engano.
    if (!m.caminho.startsWith(`${post.organization_id}/`)) {
      return falhar(admin, post, "Uma mídia do post não pertence a esta empresa.");
    }
    const { data, error } = await admin.storage
      .from(BUCKET_DE_PUBLICACOES)
      .createSignedUrl(m.caminho, URL_VALIDA_SEGUNDOS);
    if (error || !data?.signedUrl) return falhar(admin, post, "Uma mídia do post não foi encontrada.");
    assinadas.push({ url: data.signedUrl, tipo: tipoDaMidia(m.mime) });
  }

  try {
    const r = await adapter.publicarConteudo({
      organizationId: post.organization_id,
      sessionRef: resolveSessionRef(ref),
      formato: post.formato,
      legenda: post.legenda,
      midias: assinadas,
      containerId: post.id_container,
    });
    if (r.estado === "processando") {
      if (post.tentativas >= MAX_RODADAS_PROCESSANDO) {
        return falhar(admin, post, "A rede demorou demais para processar o vídeo.");
      }
      await gravar(admin, post, {
        status: "agendado",
        id_container: r.containerId,
        proxima_tentativa_em: new Date(agora.getTime() + 60_000).toISOString(),
      });
      return "processando";
    }
    await gravar(admin, post, {
      status: "publicado",
      id_externo: r.idExterno,
      link_publico: r.link,
      publicado_em: agora.toISOString(),
      ultimo_erro: null,
      proxima_tentativa_em: null,
    });
    await audit({
      action: "publicacao.publicada",
      organizationId: post.organization_id,
      resourceType: "publicacoes_posts",
      resourceId: post.id,
      metadata: { formato: post.formato, tentativas: post.tentativas },
    });
    return "publicado";
  } catch (e) {
    const erro =
      e instanceof ErroDePublicacao
        ? e
        : new ErroDePublicacao(e instanceof Error ? e.message : "erro desconhecido", false);
    if (erro.definitivo || post.tentativas >= MAX_TENTATIVAS) return falhar(admin, post, erro.message);
    await gravar(admin, post, {
      status: "agendado",
      ultimo_erro: erro.message.slice(0, 500),
      // Container já montado continua valendo: retomar, não montar outro.
      id_container: erro.containerId ?? post.id_container,
      proxima_tentativa_em: new Date(agora.getTime() + esperaAntesDe(post.tentativas)).toISOString(),
    });
    return "reagendado";
  }
}

export async function rodadaDePublicacao(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<ResultadoDoPost[]> {
  const paradas = await idsDeOrgsParadas(admin);
  const { data: reivindicados, error } = await admin.rpc("fn_publicacoes_reivindicar", {
    p_limite: POR_RODADA,
    p_pular: paradas,
  });
  if (error) throw new Error(`publicacoes_reivindicar_falhou: ${error.message}`);

  const resultados: ResultadoDoPost[] = [];
  for (const alvo of (reivindicados ?? []) as { post_id: string; org_id: string }[]) {
    const { data: linha, error: erroLeitura } = await admin
      .from("publicacoes_posts")
      .select("id, organization_id, channel_session_id, formato, legenda, midias, tentativas, id_container")
      .eq("organization_id", alvo.org_id)
      .eq("id", alvo.post_id)
      .maybeSingle();
    if (erroLeitura || !linha) {
      logger.error("[publicacoes] post reivindicado não pôde ser lido", {
        organization_id: alvo.org_id,
        post_id: alvo.post_id,
        detail: erroLeitura?.message ?? "sem_linha",
      });
      continue;
    }
    const post = linha as LinhaDoPost;
    let desfecho: DesfechoDaRodada;
    try {
      desfecho = await processar(admin, post, agora);
    } catch (e) {
      // Falha NOSSA (banco, storage) depois do claim: o post fica em
      // `publicando` e o claim seguinte o encerra como interrompido. Não
      // republica por conta própria — publicar em dobro é pior que não publicar.
      logger.error("[publicacoes] rodada falhou no meio de um post", {
        organization_id: post.organization_id,
        post_id: post.id,
        detail: e instanceof Error ? e.message.slice(0, 200) : "erro",
      });
      continue;
    }
    resultados.push({ organizationId: post.organization_id, postId: post.id, desfecho });
  }
  return resultados;
}
