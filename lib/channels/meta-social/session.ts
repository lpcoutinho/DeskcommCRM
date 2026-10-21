/**
 * Instagram nativo — persistência da sessão, do lado de dentro do seam.
 *
 * A rota e a tela não podem nomear o provider nem as colunas dele (invariante 1
 * de `docs/doctrine/restricao-de-canal.md`, vigiado por `lint:channels`); elas
 * falam em "a conta", "o token", "o segredo do app". Leitura e escrita moram aqui.
 *
 * Toda consulta leva `organization_id` À MÃO: o client é de service role e
 * ignora a RLS. O molde é o canal parceiro (`../graph-parceiro/session.ts`).
 *
 * ─── Uma conta por organização, por enquanto ────────────────────────────────
 *
 * Como no canal parceiro, a organização tem UMA sessão deste provider, e
 * reconectar ressuscita a mesma linha. Duas contas de Instagram na mesma
 * organização é extensão natural (o índice único já é por conta, não por
 * organização), mas a tela de hoje conecta uma.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";
import { REDE_INSTAGRAM } from "./webhook";

export interface SessaoInstagram {
  id: string;
  accountId: string;
  username: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  /** Cifrado; quem precisa do segredo do app decifra no servidor. */
  webhookSecretEncrypted: string | null;
  archivedAt: string | null;
}

const COLUNAS =
  "id, meta_social_account_id, meta_social_token_encrypted, meta_social_token_expires_at, phone_number, display_name, status, webhook_path_token, webhook_secret_encrypted, archived_at, metadata";

function toSessao(row: Record<string, unknown> | null): SessaoInstagram | null {
  if (!row) return null;
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  return {
    id: row.id as string,
    accountId: row.meta_social_account_id as string,
    username: typeof metadata.social_username === "string" ? metadata.social_username : null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasToken: !!row.meta_social_token_encrypted,
    tokenExpiresAt: (row.meta_social_token_expires_at as string) ?? null,
    webhookSecretEncrypted: (row.webhook_secret_encrypted as string) ?? null,
    archivedAt: (row.archived_at as string) ?? null,
  };
}

/**
 * A sessão deste canal na organização — a ATIVA primeiro. Reconectar por cima de
 * uma arquivada traz a linha de volta, não cria outra ao lado dela.
 * LANÇA quando a consulta falha.
 */
export async function buscarSessaoInstagram(
  admin: SupabaseClient,
  organizationId: string,
): Promise<SessaoInstagram | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`instagram_session_lookup_failed: ${error.message}`);
  return toSessao((data as Record<string, unknown>[] | null)?.[0] ?? null);
}

/**
 * Grava (ou ressuscita) a sessão com o token e o segredo do app recém-validados.
 *
 * A rede vai em `metadata.social_platform` — a mesma chave do canal social
 * intermediado, que é o que a apresentação lê para mostrar "Instagram". Numa
 * sessão nova, o metadata nasce de `metadataInicialDoCanal()`: IA pausada até o
 * administrador liberar (`pre_go_live`).
 */
export async function gravarSessaoInstagram(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: SessaoInstagram | null;
    accountId: string;
    username: string | null;
    displayName: string;
    tokenEncrypted: string;
    segredoDoAppCifrado: string;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null; channelSessionId: string | null; contaEmUso: boolean }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_META_SOCIAL,
    meta_social_account_id: input.accountId,
    meta_social_token_encrypted: input.tokenEncrypted,
    // Token novo: a validade só é sabida na primeira renovação.
    meta_social_token_expires_at: null,
    webhook_secret_encrypted: input.segredoDoAppCifrado,
    display_name: input.displayName,
    status: "WORKING",
  };

  if (input.existente) {
    // A rede e o @ entram no metadata que JÁ existe: reescrevê-lo inteiro
    // apagaria a liberação da IA que o administrador fez.
    const { data: atual, error: erroLeitura } = await admin
      .from("channel_sessions")
      .select("metadata")
      .eq("organization_id", input.organizationId)
      .eq("id", input.existente.id)
      .maybeSingle();
    if (erroLeitura) return { error: erroLeitura.message, channelSessionId: null, contaEmUso: false };
    const metadata = {
      ...(((atual as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<
        string,
        unknown
      >),
      social_platform: REDE_INSTAGRAM,
      social_username: input.username,
    };
    const r = await reactivateChannelSession(
      admin,
      {
        organizationId: input.organizationId,
        channelSessionId: input.existente.id,
        archivedAt: input.existente.archivedAt,
      },
      { ...linha, metadata },
      {
        userId: input.userId,
        requestId: input.requestId,
        metadata: { provider: CHANNEL_PROVIDER_META_SOCIAL, social_platform: REDE_INSTAGRAM },
      },
    );
    return {
      error: r.error?.message ?? null,
      channelSessionId: input.existente.id,
      contaEmUso: contaJaEmUso(r.error),
    };
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      ...linha,
      metadata: {
        ...metadataInicialDoCanal(),
        social_platform: REDE_INSTAGRAM,
        social_username: input.username,
      },
    })
    .select("id")
    .maybeSingle();
  return {
    error: error?.message ?? null,
    channelSessionId: (data as { id: string } | null)?.id ?? null,
    contaEmUso: contaJaEmUso(error),
  };
}

/**
 * A conta já está ativa em outra linha (desta ou de outra organização): o índice
 * único entre ativos recusou com 23505. A tela precisa dizer isso, não "erro".
 */
function contaJaEmUso(erro: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!erro) return false;
  return erro.code === "23505" || /meta_social_account_id_ativo_unique/.test(erro.message ?? "");
}

/** A credencial de envio: o token decifrado da conta, escopado pela organização. */
export interface CredencialInstagram {
  channelSessionId: string;
  accountId: string;
  token: string;
  tokenExpiresAt: string | null;
}

/**
 * Credencial gravada na sessão ATIVA desta organização para esta conta.
 * `null` = sem token gravado. LANÇA quando a consulta falha — descartar o
 * `error` foi metade do defeito da issue #236 no canal oficial.
 */
export async function credencialInstagram(
  admin: SupabaseClient,
  lookup: { organizationId: string; accountId: string },
): Promise<CredencialInstagram | null> {
  if (!lookup.organizationId || !lookup.accountId) return null;
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, meta_social_account_id, meta_social_token_encrypted, meta_social_token_expires_at")
    .eq("organization_id", lookup.organizationId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_account_id", lookup.accountId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`instagram_creds_lookup_failed: ${error.code ?? ""} ${error.message}`.trim());
  const linha = data as {
    id: string;
    meta_social_account_id: string;
    meta_social_token_encrypted: string | null;
    meta_social_token_expires_at: string | null;
  } | null;
  if (!linha?.meta_social_token_encrypted) return null;
  const token = await decryptWebhookSecret(admin, linha.meta_social_token_encrypted);
  if (!token) return null;
  return {
    channelSessionId: linha.id,
    accountId: linha.meta_social_account_id,
    token,
    tokenExpiresAt: linha.meta_social_token_expires_at,
  };
}

/** A conta que ESTA sessão atende — para a entrada conferir que o evento é dela. */
export async function contaDaSessaoInstagram(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("meta_social_account_id")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .maybeSingle();
  if (error) throw new Error(`instagram_account_lookup_failed: ${error.message}`);
  return (data as { meta_social_account_id?: string | null } | null)?.meta_social_account_id ?? null;
}

/** Grava o token renovado e a validade que a renovação informou. */
export async function gravarTokenRenovado(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; tokenEncrypted: string; expiresAt: string },
): Promise<{ error: string | null }> {
  const { error } = await admin
    .from("channel_sessions")
    .update({
      meta_social_token_encrypted: input.tokenEncrypted,
      meta_social_token_expires_at: input.expiresAt,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .is("archived_at", null);
  return { error: error?.message ?? null };
}
