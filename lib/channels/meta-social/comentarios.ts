/**
 * Rede social pela Meta — responder comentário, em público e no privado.
 *
 * Instagram e página do Facebook têm o mesmo contrato; muda o host (pela rede
 * da credencial) e o nome da resposta pública (`replies` × `comments`).
 *
 * ─── Em público ─────────────────────────────────────────────────────────────
 *
 * `POST /<comentário>/replies` com `message`: a resposta aparece embaixo do
 * comentário, assinada pela conta. A Meta devolve `{ id }` do comentário novo.
 * Esse comentário volta pelo webhook com `from.id` = a conta, e a leitura o
 * descarta (a conta não dispara regra sobre o que ela mesma escreveu).
 *
 * ─── No privado ─────────────────────────────────────────────────────────────
 *
 * `POST /me/messages` com `recipient: { comment_id }`: a DM que nasce do
 * comentário ("resposta privada"). A Meta aceita UMA por comentário, até 7 dias
 * depois dele, e devolve `{ recipient_id, message_id }`. O `message_id` volta
 * como eco pelo webhook de mensagens, e o id que devolvemos aqui é o MESMO
 * `external_id` que a entrada calcula para ele — é assim que o eco é
 * reconhecido como nosso e não pausa a IA.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { socialMessageId } from "../social/catalog";
import type { RespostaDeComentarioInput } from "../types";
import { chamarGraph, type RedeSocial } from "./graph";
import { credencialInstagram } from "./session";

/** O que a Meta aceita numa resposta de comentário (limite da API de comentários). */
export const LIMITE_DA_RESPOSTA_DE_COMENTARIO = 2200;

async function tokenDaConta(input: RespostaDeComentarioInput): Promise<{ token: string; rede: RedeSocial }> {
  const cred = await credencialInstagram(createAdminClient(), {
    organizationId: input.organizationId,
    accountId: input.sessionRef,
  });
  if (!cred) throw new Error("A conta não está conectada: reconecte em Conexões.");
  return { token: cred.token, rede: cred.rede ?? "instagram" };
}

function textoValido(texto: string): string {
  const limpo = texto.trim();
  if (!limpo) throw new Error("A resposta ficou vazia.");
  if (limpo.length > LIMITE_DA_RESPOSTA_DE_COMENTARIO) {
    throw new Error(`A resposta passa de ${LIMITE_DA_RESPOSTA_DE_COMENTARIO} caracteres.`);
  }
  return limpo;
}

export async function responderComentarioNoInstagram(
  input: RespostaDeComentarioInput,
): Promise<{ externalId: string }> {
  const message = textoValido(input.texto);
  const { token, rede } = await tokenDaConta(input);
  // Mesma resposta, nome diferente: no Instagram é `replies`, na página é `comments`.
  const caminho = rede === "facebook" ? "comments" : "replies";
  const r = await chamarGraph(rede, token, `${encodeURIComponent(input.commentExternalId)}/${caminho}`, {
    metodo: "POST",
    corpo: { message },
  });
  const id = typeof r.id === "string" && r.id ? r.id : null;
  if (!id) throw new Error("A Meta não devolveu o id da resposta.");
  return { externalId: id };
}

export async function responderComentarioNoPrivadoDoInstagram(
  input: RespostaDeComentarioInput,
): Promise<{ externalId: string; participantId: string | null }> {
  const text = textoValido(input.texto);
  const { token, rede } = await tokenDaConta(input);
  const r = await chamarGraph(rede, token, "me/messages", {
    metodo: "POST",
    corpo: { recipient: { comment_id: input.commentExternalId }, message: { text } },
  });
  const mid = typeof r.message_id === "string" && r.message_id ? r.message_id : null;
  // Sem o id, o eco não seria reconhecido como nosso: vira falha, como no envio.
  if (!mid) throw new Error("A Meta não devolveu o id da mensagem privada.");
  const participante = typeof r.recipient_id === "string" && r.recipient_id ? r.recipient_id : null;
  return { externalId: socialMessageId(input.sessionRef, mid), participantId: participante };
}
