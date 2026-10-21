/**
 * Instagram nativo — a entrada de um webhook já autenticado.
 *
 * A leitura é do módulo puro (`./webhook.ts`); a GRAVAÇÃO é a mesma do canal
 * social intermediado (`ingestZernioInbound` com `socialMessage`): contato pela
 * identidade social (`instagram:<conta>:<participante>`), conversa pela thread,
 * mensagem com dedupe por `external_id`, mídia pedida ao worker, e os efeitos de
 * entrada (opt-out, demanda, despacho do agente). Duas gravações para a mesma
 * rede divergiriam no primeiro conserto que só uma delas recebesse.
 *
 * Só entra evento da conta DESTA sessão: a sessão veio do token do caminho, e o
 * corpo não escolhe onde gravar.
 *
 * Comentário vai para `social_comments` (dedupe por `external_id`); o INSERT
 * emite `comment.received` pelo gatilho do banco, e é o motor de automação que
 * responde. O eco da DM privada que uma regra mandou entra como mensagem da
 * conversa, mas sem pausar a IA (`saidaDoProprioCrm`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import type { SocialMessage } from "../social/parser";
import { ingestZernioInbound } from "../zernio/ingest";
import { chamarGraphInstagram } from "./graph";
import { contaDaSessaoInstagram, credencialInstagram } from "./session";
import { lerWebhookInstagram, REDE_INSTAGRAM, type ComentarioRecebido } from "./webhook";

export type DesfechoDaEntradaInstagram =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: "invalid_json"; message: string };

/** O corpo traz só contas desta sessão? A guarda que a rota pergunta antes de ingerir. */
export async function corpoEhDaContaDaSessao(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  rawBody: string,
): Promise<boolean> {
  const leitura = lerWebhookInstagram(rawBody);
  // JSON inválido segue adiante: quem responde por ele é a entrada, com o código certo.
  if (!leitura) return true;
  if (leitura.objetoEstranho || leitura.contas.length === 0) return false;
  const conta = await contaDaSessaoInstagram(admin, organizationId, channelSessionId);
  // Sessão sem conta RECUSA: "não sei de quem é" não vira "aceito de qualquer um".
  return conta !== null && leitura.contas.every((c) => c === conta);
}

/**
 * Nome e @ de quem escreveu, quando a conta ainda não conhece a pessoa.
 *
 * O webhook do Instagram traz só o id. Sem isto, todo contato novo nasceria sem
 * nome na caixa de entrada. Melhor esforço: a API de perfil pode negar (a
 * pessoa restringiu), e isso não pode impedir a mensagem de entrar.
 */
async function completarPerfil(
  admin: SupabaseClient,
  organizationId: string,
  msg: SocialMessage,
  token: string | null,
): Promise<SocialMessage> {
  if (!token || msg.direction !== "inbound") return msg;
  const identidade = `${msg.platform}:${msg.accountId}:${msg.participantId}`;
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("social_identity", identidade)
    .is("is_merged_into", null)
    .maybeSingle();
  if (data) return msg;
  try {
    const perfil = await chamarGraphInstagram(token, encodeURIComponent(msg.participantId), {
      consulta: { fields: "name,username" },
    });
    const nome = typeof perfil.name === "string" && perfil.name.trim() ? perfil.name.trim() : null;
    const usuario =
      typeof perfil.username === "string" && perfil.username.trim() ? perfil.username.trim() : null;
    return {
      ...msg,
      identity: { ...msg.identity, displayName: nome ?? usuario, username: usuario },
    };
  } catch (e) {
    logger.info("[canal.instagram] perfil do contato indisponível; segue sem nome", {
      organization_id: organizationId,
      detail: e instanceof Error ? e.message.slice(0, 120) : "erro",
    });
    return msg;
  }
}

/** `rede:conta:autor` — a mesma forma de `contacts.social_identity`. */
export function identidadeDoAutor(c: Pick<ComentarioRecebido, "accountId" | "authorExternalId">): string | null {
  return c.authorExternalId ? `${REDE_INSTAGRAM}:${c.accountId}:${c.authorExternalId}` : null;
}

async function gravarComentario(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string },
  c: ComentarioRecebido,
): Promise<"comentario" | "comentario_repetido"> {
  const { error } = await admin.from("social_comments").insert({
    organization_id: input.organizationId,
    channel_session_id: input.channelSessionId,
    network: REDE_INSTAGRAM,
    account_external_id: c.accountId,
    external_id: c.externalId,
    media_external_id: c.mediaExternalId,
    media_product_type: c.mediaProductType,
    parent_external_id: c.parentExternalId,
    author_external_id: c.authorExternalId,
    author_identity: identidadeDoAutor(c),
    author_username: c.authorUsername,
    body: c.texto,
    ...(c.comentadoEm ? { commented_at: c.comentadoEm } : {}),
  });
  // Reentrega do webhook: o comentário já está gravado e o evento já saiu.
  if (error?.code === "23505") return "comentario_repetido";
  // Erro de verdade sobe: a entrada responde 5xx e a Meta reentrega.
  if (error) throw new Error(`social_comment_insert_failed: ${error.message}`);
  return "comentario";
}

/**
 * O eco é da DM privada que uma regra mandou a partir de um comentário?
 *
 * Duas formas de reconhecer, porque o eco pode chegar ANTES da resposta da Meta
 * ao nosso envio (aí o id ainda não foi gravado): pelo id da mensagem, ou pelo
 * autor do comentário cuja resposta privada está saindo agora.
 */
async function ecoDaRespostaPrivada(
  admin: SupabaseClient,
  organizationId: string,
  msg: SocialMessage,
): Promise<{ autor: string | null } | null> {
  const porId = await admin
    .from("social_comments")
    .select("author_username")
    .eq("organization_id", organizationId)
    .eq("private_reply_external_id", msg.externalId)
    .limit(1)
    .maybeSingle();
  if (porId.data) return { autor: (porId.data as { author_username: string | null }).author_username };
  const recente = new Date(Date.now() - 10 * 60_000).toISOString();
  const saindo = await admin
    .from("social_comments")
    .select("author_username")
    .eq("organization_id", organizationId)
    .eq("author_identity", `${msg.platform}:${msg.accountId}:${msg.participantId}`)
    .eq("private_reply_status", "sending")
    .gte("private_replied_at", recente)
    .limit(1)
    .maybeSingle();
  return saindo.data ? { autor: (saindo.data as { author_username: string | null }).author_username } : null;
}

export async function ingerirWebhookInstagram(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; rawBody: string },
): Promise<DesfechoDaEntradaInstagram> {
  const leitura = lerWebhookInstagram(input.rawBody);
  if (!leitura) return { ok: false, code: "invalid_json", message: "invalid_json" };
  if (leitura.objetoEstranho) {
    return { ok: true, body: { status: "ignored", reason: "objeto_de_outra_rede" } };
  }

  const conta = await contaDaSessaoInstagram(admin, input.organizationId, input.channelSessionId);
  const desfechos: string[] = [];

  const daSessao = leitura.mensagens.filter((m) => m.accountId === conta);
  const token = daSessao.some((m) => m.direction === "inbound")
    ? ((await credencialInstagram(admin, { organizationId: input.organizationId, accountId: conta ?? "" }))
        ?.token ?? null)
    : null;

  for (const bruta of leitura.mensagens) {
    if (bruta.accountId !== conta) {
      desfechos.push("outra_conta");
      continue;
    }
    let msg = await completarPerfil(admin, input.organizationId, bruta, token);
    const daAutomacao =
      msg.direction === "outbound" ? await ecoDaRespostaPrivada(admin, input.organizationId, msg) : null;
    if (daAutomacao?.autor) {
      // A conversa nasce desta DM: o nome é o @ de quem comentou.
      msg = { ...msg, identity: { ...msg.identity, username: daAutomacao.autor, displayName: daAutomacao.autor } };
    }
    const r = await ingestZernioInbound(admin, {
      organizationId: input.organizationId,
      channelSessionId: input.channelSessionId,
      payload: null,
      socialMessage: msg,
      saidaDoProprioCrm: daAutomacao !== null,
    });
    desfechos.push(
      msg.direction === "outbound" ? `${daAutomacao ? "eco_da_resposta_privada" : "eco"}:${r.status}` : r.status,
    );
  }

  for (const comentario of leitura.comentarios) {
    if (comentario.accountId !== conta) {
      desfechos.push("outra_conta");
      continue;
    }
    desfechos.push(await gravarComentario(admin, input, comentario));
  }

  // Leitura: o cliente VIU. Não rebaixa nada (é o último estado), e mensagem
  // que não é nossa simplesmente não casa.
  for (const lida of leitura.leituras) {
    if (lida.accountId !== conta) continue;
    const { data } = await admin
      .from("messages")
      .update({ status: "read", ...(lida.lidaEm ? { read_at: lida.lidaEm } : {}) })
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", input.channelSessionId)
      .eq("external_id", lida.externalId)
      .select("id");
    desfechos.push((data ?? []).length > 0 ? "lida" : "lida_desconhecida");
  }

  return {
    ok: true,
    body: {
      received: leitura.mensagens.length + leitura.leituras.length + leitura.comentarios.length,
      outcomes: desfechos,
      // Mudanças que não são comentário de terceiro (o da própria conta, menção):
      // a contagem é o rastro de que chegaram (o corpo cru está no arquivo).
      ignored_changes: leitura.mudancasIgnoradas,
      ignored_events: leitura.eventosIgnorados,
      ...(desfechos.length === 0 ? { reason: "evento_sem_interesse" } : {}),
    },
  };
}
