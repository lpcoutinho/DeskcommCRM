/**
 * Instagram nativo — publicar conteúdo no perfil (API de publicação de conteúdo).
 *
 * O fluxo da Meta tem três passos, e só o último é público:
 *
 *   1. montar o CONTAINER com a mídia (`POST /<conta>/media`) — a Meta baixa a
 *      mídia da URL que mandamos, então ela precisa ser alcançável de fora
 *      (URL assinada e temporária do Storage);
 *   2. esperar o container ficar pronto (`status_code = FINISHED`) — imagem é
 *      quase imediato, vídeo leva minutos;
 *   3. publicar (`POST /<conta>/media_publish`) e buscar o link público.
 *
 * Esta função espera um pouco (alguns segundos) e, se o container ainda está
 * processando, DEVOLVE `processando` com o id dele: a fila retoma na rodada
 * seguinte sem montar outro. Assim a rodada não segura o cron por minutos e a
 * mesma mídia nunca vira dois containers — nem dois posts.
 *
 * Carrossel: cada item vira um container filho, e o pai junta os filhos. Os
 * filhos são esperados dentro da mesma rodada; se não ficarem prontos a tempo,
 * o erro é TRANSITÓRIO e a próxima rodada monta tudo de novo (container não
 * publicado expira sozinho na Meta e não aparece para ninguém).
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { ErroDePublicacao } from "../publicacao";
import type { PublicacaoInput, PublicacaoResultado } from "../types";
import { chamarGraphInstagram, ErroDaGraphInstagram } from "./graph";
import { credencialInstagram } from "./session";

/** Quantas vezes conferir o container dentro de UMA rodada, e o intervalo. */
const CONFERENCIAS_POR_RODADA = 6;
const INTERVALO_MS = 4000;

type Esperar = (ms: number) => Promise<void>;
const esperarDeVerdade: Esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Erro da Graph → erro de publicação, com a decisão de tentar de novo. */
function paraErroDePublicacao(e: unknown): ErroDePublicacao {
  if (e instanceof ErroDePublicacao) return e;
  if (e instanceof ErroDaGraphInstagram) {
    if (e.tokenInvalido) {
      return new ErroDePublicacao("O token da conta não vale mais: reconecte em Conexões › Instagram.", true);
    }
    // Rede fora do ar, 5xx, limite de chamadas: passa.
    if (e.status === null || (e.status !== null && e.status >= 500) || e.codigo === 4 || e.codigo === 17) {
      return new ErroDePublicacao(e.message, false);
    }
    // 4xx da Graph com código: mídia recusada, permissão, parâmetro. Repetir não muda.
    return new ErroDePublicacao(e.message, true);
  }
  return new ErroDePublicacao(e instanceof Error ? e.message : "erro desconhecido", false);
}

async function conferirCota(token: string, conta: string): Promise<void> {
  const r = await chamarGraphInstagram(token, `${encodeURIComponent(conta)}/content_publishing_limit`, {
    consulta: { fields: "quota_usage,config" },
  });
  const linha = Array.isArray(r.data) ? (r.data[0] as Record<string, unknown> | undefined) : undefined;
  const usado = typeof linha?.quota_usage === "number" ? linha.quota_usage : null;
  const total =
    typeof (linha?.config as Record<string, unknown> | undefined)?.quota_total === "number"
      ? ((linha!.config as Record<string, unknown>).quota_total as number)
      : null;
  if (usado !== null && total !== null && usado >= total) {
    throw new ErroDePublicacao(
      `A conta chegou ao limite de ${total} publicações em 24 horas da Meta. A fila tenta de novo mais tarde.`,
      false,
    );
  }
}

/** O corpo do container, por formato. */
function corpoDoContainer(input: PublicacaoInput): Record<string, unknown> {
  const [primeira] = input.midias;
  if (!primeira) throw new ErroDePublicacao("O post não tem mídia.", true);
  switch (input.formato) {
    case "imagem":
      if (primeira.tipo !== "imagem") throw new ErroDePublicacao("Post de imagem precisa de uma imagem.", true);
      return { image_url: primeira.url, caption: input.legenda };
    case "video":
    case "reel":
      // A Meta publica vídeo de feed como REELS; `share_to_feed` deixa o vídeo
      // também na grade do perfil, que é o que "vídeo" quer dizer para a pessoa.
      if (primeira.tipo !== "video") throw new ErroDePublicacao("Reels e vídeo precisam de um vídeo.", true);
      return {
        media_type: "REELS",
        video_url: primeira.url,
        caption: input.legenda,
        share_to_feed: input.formato === "video",
      };
    case "story":
      // Story não tem legenda na API.
      return primeira.tipo === "video"
        ? { media_type: "STORIES", video_url: primeira.url }
        : { media_type: "STORIES", image_url: primeira.url };
    case "carrossel":
      throw new ErroDePublicacao("carrossel é montado à parte", true);
  }
}

async function estadoDoContainer(token: string, id: string): Promise<string> {
  const r = await chamarGraphInstagram(token, encodeURIComponent(id), {
    consulta: { fields: "status_code,status" },
  });
  return texto(r.status_code) ?? "IN_PROGRESS";
}

/** Espera o container; `true` = pronto, `false` = ainda processando. */
async function aguardar(token: string, id: string, esperar: Esperar): Promise<boolean> {
  for (let i = 0; i < CONFERENCIAS_POR_RODADA; i++) {
    const estado = await estadoDoContainer(token, id);
    if (estado === "FINISHED") return true;
    if (estado === "ERROR") {
      throw new ErroDePublicacao(
        "A Meta não conseguiu processar a mídia (formato, tamanho ou proporção fora do aceito).",
        true,
      );
    }
    // Já publicado: uma rodada anterior publicou e perdeu a resposta. Repetir
    // não faz sentido; a pessoa confere o perfil (publicar em dobro é pior).
    if (estado === "PUBLISHED") {
      throw new ErroDePublicacao("A Meta indica que este post já foi publicado: confira no perfil.", true);
    }
    // Expirado (24h sem publicar): monta de novo na próxima rodada.
    if (estado === "EXPIRED") throw new ErroDePublicacao("O container expirou antes de publicar.", false);
    if (i < CONFERENCIAS_POR_RODADA - 1) await esperar(INTERVALO_MS);
  }
  return false;
}

async function montarCarrossel(
  token: string,
  conta: string,
  input: PublicacaoInput,
  esperar: Esperar,
): Promise<string> {
  if (input.midias.length < 2 || input.midias.length > 10) {
    throw new ErroDePublicacao("Carrossel precisa de 2 a 10 mídias.", true);
  }
  const filhos: string[] = [];
  for (const m of input.midias) {
    const corpo =
      m.tipo === "video"
        ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: true }
        : { image_url: m.url, is_carousel_item: true };
    const r = await chamarGraphInstagram(token, `${encodeURIComponent(conta)}/media`, { metodo: "POST", corpo });
    const id = texto(r.id);
    if (!id) throw new ErroDePublicacao("A Meta não devolveu o item do carrossel.", false);
    filhos.push(id);
  }
  for (const id of filhos) {
    if (!(await aguardar(token, id, esperar))) {
      throw new ErroDePublicacao("Os vídeos do carrossel ainda estão sendo processados.", false);
    }
  }
  const pai = await chamarGraphInstagram(token, `${encodeURIComponent(conta)}/media`, {
    metodo: "POST",
    corpo: { media_type: "CAROUSEL", children: filhos.join(","), caption: input.legenda },
  });
  const id = texto(pai.id);
  if (!id) throw new ErroDePublicacao("A Meta não devolveu o carrossel montado.", false);
  return id;
}

export async function publicarNoInstagram(
  input: PublicacaoInput,
  esperar: Esperar = esperarDeVerdade,
): Promise<PublicacaoResultado> {
  const cred = await credencialInstagram(createAdminClient(), {
    organizationId: input.organizationId,
    accountId: input.sessionRef,
  });
  if (!cred) {
    throw new ErroDePublicacao("A conta não está conectada: reconecte em Conexões › Instagram.", true);
  }
  const conta = cred.accountId;

  let containerId = input.containerId;
  try {
    if (!containerId) {
      await conferirCota(cred.token, conta);
      if (input.formato === "carrossel") {
        containerId = await montarCarrossel(cred.token, conta, input, esperar);
      } else {
        const r = await chamarGraphInstagram(cred.token, `${encodeURIComponent(conta)}/media`, {
          metodo: "POST",
          corpo: corpoDoContainer(input),
        });
        containerId = texto(r.id);
        if (!containerId) throw new ErroDePublicacao("A Meta não devolveu o container.", false);
      }
    }

    if (!(await aguardar(cred.token, containerId, esperar))) {
      return { estado: "processando", containerId };
    }

    const publicado = await chamarGraphInstagram(cred.token, `${encodeURIComponent(conta)}/media_publish`, {
      metodo: "POST",
      corpo: { creation_id: containerId },
    });
    const idExterno = texto(publicado.id);
    if (!idExterno) {
      // Sem id não dá para afirmar que saiu NEM que não saiu: definitivo, para
      // a pessoa conferir no perfil antes de repetir (publicar em dobro é pior).
      throw new ErroDePublicacao("A Meta não confirmou a publicação: confira no perfil antes de repetir.", true);
    }

    // O link é enfeite da tela: falhar aqui não desfaz a publicação.
    let link: string | null = null;
    try {
      const m = await chamarGraphInstagram(cred.token, encodeURIComponent(idExterno), {
        consulta: { fields: "permalink" },
      });
      link = texto(m.permalink);
    } catch {
      link = null;
    }
    return { estado: "publicado", idExterno, link };
  } catch (e) {
    const erro = paraErroDePublicacao(e);
    // Erro DEPOIS de montar o container: devolve o id para a fila retomar em vez
    // de montar outro (que, se o primeiro chegou a publicar, viraria post em dobro).
    throw containerId && !erro.containerId
      ? new ErroDePublicacao(erro.message, erro.definitivo, containerId)
      : erro;
  }
}
