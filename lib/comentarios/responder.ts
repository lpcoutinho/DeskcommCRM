/**
 * Responder um comentário — em público ou no privado (a DM que nasce dele).
 *
 * É UM caminho para as duas portas: a regra de automação (`reply_comment` /
 * `private_reply_comment`) e a pessoa na tela de Comentários. Duas cópias
 * divergiriam na primeira guarda que só uma recebesse.
 *
 * ─── Quem responde é o canal, por capacidade ────────────────────────────────
 *
 * O comentário guarda a conexão em que chegou (`channel_session_id`). Aqui se
 * pergunta ao adapter dessa conexão se ele sabe responder comentário — nunca
 * qual rede é (invariante 1 da doutrina de canal).
 *
 * ─── Uma resposta por comentário, e a guarda é a LINHA ─────────────────────
 *
 * Duas regras do mesmo gatilho, o evento reprocessado ou a pessoa clicando
 * junto com a regra não podem responder duas vezes. Antes de chamar a rede, a
 * linha é LEVADA por um UPDATE condicional (`... is null`): em READ COMMITTED
 * quem chega depois espera o commit, reavalia o WHERE e sai com zero linhas.
 * Só quem levou chama a rede.
 *
 * No privado a regra é da Meta e é dura: UMA DM por comentário, até 7 dias
 * depois dele. As duas são recusadas antes da chamada. E a falha no envio é
 * TERMINAL (`failed`): a chamada pode ter saído antes do erro, e uma segunda DM
 * seria pior que nenhuma. Em público a falha devolve a linha — a resposta não
 * saiu, e dá para responder de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdapter } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef, type ChannelSessionRef } from "@/lib/channels/session-ref";
import type { ChannelAdapter, ChannelProvider } from "@/lib/channels/types";

/** A janela da resposta privada, em dias (regra da Meta). */
export const PRAZO_DA_RESPOSTA_PRIVADA_DIAS = 7;

export type ModoDaResposta = "publico" | "privado";

/** Por que a resposta não saiu sem nem chamar a rede. */
export type MotivoDeNaoResponder =
  | "comentario_inexistente"
  | "conexao_removida"
  | "canal_sem_comentarios"
  | "ja_respondido"
  | "ja_respondido_no_privado"
  | "prazo_da_resposta_privada_vencido";

export type DesfechoDaResposta =
  | { estado: "respondido"; externalId: string }
  | { estado: "nao_respondido"; motivo: MotivoDeNaoResponder }
  | { estado: "falhou"; erro: string };

interface Linha {
  id: string;
  channel_session_id: string | null;
  external_id: string;
  private_reply_status: string | null;
}

async function canalDaConexao(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string | null,
): Promise<{ adapter: ChannelAdapter; sessionRef: string } | null> {
  if (!channelSessionId) return null;
  const { data, error } = await admin
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`comentario_sessao_falhou: ${error.message}`);
  if (!data) return null;
  const ref = data as unknown as ChannelSessionRef;
  return { adapter: getAdapter(ref.provider as ChannelProvider), sessionRef: resolveSessionRef(ref) };
}

function legivel(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

export async function responderComentario(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    commentId: string;
    modo: ModoDaResposta;
    texto: string;
    agora?: Date;
  },
): Promise<DesfechoDaResposta> {
  const { organizationId, commentId, modo } = input;
  const agora = input.agora ?? new Date();

  const { data: bruta, error: erroLeitura } = await admin
    .from("social_comments")
    .select("id, channel_session_id, external_id, private_reply_status")
    .eq("organization_id", organizationId)
    .eq("id", commentId)
    .maybeSingle();
  if (erroLeitura) throw new Error(`comentario_leitura_falhou: ${erroLeitura.message}`);
  if (!bruta) return { estado: "nao_respondido", motivo: "comentario_inexistente" };
  const linha = bruta as Linha;

  const canal = await canalDaConexao(admin, organizationId, linha.channel_session_id);
  if (!canal) return { estado: "nao_respondido", motivo: "conexao_removida" };
  const enviar = modo === "publico" ? canal.adapter.responderComentario : canal.adapter.responderComentarioNoPrivado;
  if (!enviar) return { estado: "nao_respondido", motivo: "canal_sem_comentarios" };

  // ─── Levar a linha ───────────────────────────────────────────────────────
  const levar =
    modo === "publico"
      ? admin
          .from("social_comments")
          .update({ public_replied_at: agora.toISOString() })
          .eq("organization_id", organizationId)
          .eq("id", commentId)
          .is("public_replied_at", null)
      : admin
          .from("social_comments")
          .update({ private_reply_status: "sending", private_replied_at: agora.toISOString() })
          .eq("organization_id", organizationId)
          .eq("id", commentId)
          .is("private_reply_status", null)
          .gte(
            "commented_at",
            new Date(agora.getTime() - PRAZO_DA_RESPOSTA_PRIVADA_DIAS * 86_400_000).toISOString(),
          );
  const { data: levada, error: erroLevar } = await levar.select("id");
  if (erroLevar) throw new Error(`comentario_reserva_falhou: ${erroLevar.message}`);
  if (!levada?.length) {
    if (modo === "publico") return { estado: "nao_respondido", motivo: "ja_respondido" };
    // Zero linhas no privado: ou já houve DM, ou o prazo da Meta venceu. A
    // leitura de antes diz qual (uma DM que saiu no meio também é "já houve").
    return {
      estado: "nao_respondido",
      motivo: linha.private_reply_status ? "ja_respondido_no_privado" : "prazo_da_resposta_privada_vencido",
    };
  }

  // ─── Chamar a rede ───────────────────────────────────────────────────────
  const pedido = {
    organizationId,
    sessionRef: canal.sessionRef,
    commentExternalId: linha.external_id,
    texto: input.texto,
  };
  try {
    const r = await enviar(pedido);
    await admin
      .from("social_comments")
      .update(
        modo === "publico"
          ? { public_reply_external_id: r.externalId }
          : { private_reply_status: "sent", private_reply_external_id: r.externalId },
      )
      .eq("organization_id", organizationId)
      .eq("id", commentId);
    return { estado: "respondido", externalId: r.externalId };
  } catch (e) {
    const erro = legivel(e);
    await admin
      .from("social_comments")
      .update(
        modo === "publico"
          ? { public_replied_at: null }
          : // TERMINAL: a chamada pode ter saído antes do erro.
            { private_reply_status: "failed", private_reply_error: erro },
      )
      .eq("organization_id", organizationId)
      .eq("id", commentId);
    return { estado: "falhou", erro };
  }
}
