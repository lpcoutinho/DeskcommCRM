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
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import type { SocialMessage } from "../social/parser";
import { ingestZernioInbound } from "../zernio/ingest";
import { chamarGraphInstagram } from "./graph";
import { contaDaSessaoInstagram, credencialInstagram } from "./session";
import { lerWebhookInstagram } from "./webhook";

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
    const msg = await completarPerfil(admin, input.organizationId, bruta, token);
    const r = await ingestZernioInbound(admin, {
      organizationId: input.organizationId,
      channelSessionId: input.channelSessionId,
      payload: null,
      socialMessage: msg,
    });
    desfechos.push(msg.direction === "outbound" ? `eco:${r.status}` : r.status);
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
      received: leitura.mensagens.length + leitura.leituras.length,
      outcomes: desfechos,
      // Comentários chegam pelo mesmo webhook e ficam para a entrega deles: a
      // contagem aqui é o rastro de que chegaram (o corpo cru está no arquivo).
      ignored_changes: leitura.mudancasIgnoradas,
      ignored_events: leitura.eventosIgnorados,
      ...(desfechos.length === 0 ? { reason: "evento_sem_interesse" } : {}),
    },
  };
}
