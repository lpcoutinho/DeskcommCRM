/**
 * A conexão de uma rede social pela API da Meta, com o PRÓPRIO app da
 * organização — o corpo das rotas `channels/instagram` e `channels/facebook`.
 *
 * As duas redes têm o MESMO contrato (token + chave secreta do app, webhook do
 * app, assinatura da conta); muda o tipo de token (no Facebook, o da PÁGINA) e
 * o objeto do webhook. Uma conexão por rede: o Instagram e a página do Facebook
 * da mesma organização são duas linhas.
 *
 * As rotas chamam `requireSupportWrite` no PRÓPRIO corpo, antes de delegar
 * para cá (cerca `suporte-cobertura-de-efeitos`).
 *
 * ─── Duas pontas, na ordem em que dá errado ─────────────────────────────────
 *
 * 1. Token + segredo do app (POST). O token deixa a gente FALAR com a conta; o
 *    segredo deixa a gente CONFERIR que o webhook veio da Meta. Os dois são
 *    validados ou cifrados antes de gravar e nenhum volta num GET.
 * 2. O webhook do app (PATCH, ou à mão no painel). A Meta precisa saber PARA
 *    ONDE entregar. Sem isso o CRM envia, mas a mensagem do cliente não chega —
 *    e a tela diz isso em vez de deixar o operador descobrir pelo silêncio.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  assinarWebhooksDaConta,
  configurarWebhookDoApp,
  validarConta,
} from "@/lib/channels/meta-social/conta";
import { ErroDaGraphInstagram, type RedeSocial } from "@/lib/channels/meta-social/graph";
import { buscarSessaoInstagram, gravarSessaoInstagram } from "@/lib/channels/meta-social/session";
import { tokenDeVerificacao } from "@/lib/channels/meta-social/webhook";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

const recurso = (rede: RedeSocial) => (rede === "facebook" ? "channels_facebook" : "channels_instagram");

const conectarSchema = z.object({
  token: z.string().trim().min(20).max(1000),
  app_secret: z.string().trim().regex(/^[a-f0-9]{32}$/i),
});
const webhookDoAppSchema = z.object({ app_id: z.string().trim().regex(/^\d{5,25}$/) });

function urlDoWebhook(req: NextRequest, pathToken: string | null): string | null {
  return pathToken ? `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${pathToken}` : null;
}

export async function obterConexaoSocial(req: NextRequest, rede: RedeSocial): Promise<NextResponse> {
  const requestId = randomUUID();
  // Conectar uma conta expõe a empresa e decide quem fala por ela: decisão de dono.
  const authz = await requireRole("admin", { requestId, resource: recurso(rede) });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const sessao = await buscarSessaoInstagram(admin, authz.org.orgId, rede);
  const ativa = sessao && !sessao.archivedAt ? sessao : null;

  // O segredo do app é decifrado só para DERIVAR o token de verificação (um
  // HMAC dele): o segredo em si nunca sai daqui.
  const segredo = ativa?.webhookSecretEncrypted
    ? await decryptWebhookSecret(admin, ativa.webhookSecretEncrypted)
    : null;

  return ok(
    {
      connected: Boolean(ativa),
      channel_session_id: ativa?.id ?? null,
      account_id: ativa?.accountId ?? null,
      username: ativa?.username ?? null,
      display_name: ativa?.displayName ?? null,
      status: ativa?.status ?? null,
      has_token: Boolean(ativa?.hasToken),
      token_expires_at: ativa?.tokenExpiresAt ?? null,
      webhook_url: ativa ? urlDoWebhook(req, ativa.webhookPathToken) : null,
      verify_token: ativa && segredo ? tokenDeVerificacao(segredo, ativa.id) : null,
    },
    { requestId },
  );
}

/** POST — valida o token, grava e liga a conta ao webhook. */
export async function conectarRedeSocial(req: NextRequest, rede: RedeSocial): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: recurso(rede) });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "invalid_request",
      t("Informe o token de acesso e a chave secreta do app (32 caracteres)."),
      422,
      { requestId },
    );
  }

  // Valida ANTES de gravar: gravar primeiro e descobrir depois é o operador
  // achando que conectou até a primeira mensagem que não chega.
  const validacao = await validarConta(parsed.data.token, rede);
  if (!validacao.ok) return fail("invalid_request", validacao.motivo, 422, { requestId });

  const admin = createAdminClient();
  const tokenCifrado = await encryptWebhookSecret(admin, parsed.data.token);
  const segredoCifrado = await encryptWebhookSecret(admin, parsed.data.app_secret);
  if (!tokenCifrado || !segredoCifrado) {
    // Sem a cifra, gravar em claro seria pior que recusar.
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação — a chave não foi gravada"),
      422,
      { requestId },
    );
  }

  const existente = await buscarSessaoInstagram(admin, orgId, rede);
  // O @ da conta só batiza a conexão; depois dela o nome é do operador
  // (Renomear), e reconectar não o apaga.
  const displayName =
    existente?.displayName ||
    (validacao.username ? `@${validacao.username}` : (validacao.nome ?? (rede === "facebook" ? "Facebook" : "Instagram")));

  const { error, channelSessionId, contaEmUso } = await gravarSessaoInstagram(admin, {
    organizationId: orgId,
    existente,
    rede,
    accountId: validacao.accountId,
    username: validacao.username,
    displayName,
    tokenEncrypted: tokenCifrado,
    segredoDoAppCifrado: segredoCifrado,
    userId: authz.user.id,
    requestId,
  });
  if (error) {
    const limite = traduzirLimiteDoPlano(error, authz.user.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    // Conta já ligada em outra organização (ou outra linha ativa): o índice
    // único recusa, e a mensagem precisa dizer isso, não "erro interno".
    if (contaEmUso) {
      const frase =
        rede === "facebook"
          ? t("Esta página do Facebook já está conectada em outro lugar.")
          : t("Esta conta do Instagram já está conectada em outro lugar.");
      return fail("state_conflict", frase, 409, {
        requestId,
      });
    }
    return fail("internal_error", error, 500, { requestId });
  }

  // A conta pede para receber os eventos do app. Falhar aqui NÃO desfaz a
  // conexão (o envio funciona sem isso), mas a tela precisa dizer que a
  // entrada não está ligada — e por quê.
  let contaAssinada = true;
  let motivoDaAssinatura: string | null = null;
  try {
    await assinarWebhooksDaConta(parsed.data.token, rede);
  } catch (e) {
    contaAssinada = false;
    motivoDaAssinatura = e instanceof ErroDaGraphInstagram ? e.message : "erro_desconhecido";
  }

  // A volta de um canal arquivado já é auditada por `reactivateChannelSession`.
  if (!existente?.archivedAt) {
    void audit({
      action: "channel.connected",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: channelSessionId,
      requestId,
      metadata: { canal: rede, etapa: "token", conta_assinada: contaAssinada },
    });
  }

  return ok(
    {
      connected: true,
      username: validacao.username,
      display_name: displayName,
      account_subscribed: contaAssinada,
      account_subscription_error: motivoDaAssinatura,
    },
    { requestId },
  );
}

/** PATCH — configura o webhook NO APP Meta (opcional). */
export async function configurarWebhookDaRedeSocial(req: NextRequest, rede: RedeSocial): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: recurso(rede) });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = webhookDoAppSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Informe o ID do app (só números)."), 422, { requestId });
  }

  const admin = createAdminClient();
  const sessao = await buscarSessaoInstagram(admin, orgId, rede);
  if (!sessao || sessao.archivedAt) {
    return fail("state_conflict", t("Conecte a conta antes de configurar o webhook."), 409, {
      requestId,
    });
  }
  const segredo = sessao.webhookSecretEncrypted
    ? await decryptWebhookSecret(admin, sessao.webhookSecretEncrypted)
    : null;
  const callbackUrl = urlDoWebhook(req, sessao.webhookPathToken);
  if (!segredo || !callbackUrl) {
    return fail("state_conflict", t("Conecte a conta de novo: a chave secreta do app não está disponível."), 409, {
      requestId,
    });
  }
  // A Meta só entrega em https público; localhost e http fariam o handshake
  // falhar com uma mensagem da Meta que não diz isso.
  if (!callbackUrl.startsWith("https://")) {
    return fail(
      "invalid_request",
      t("O endereço desta instalação não é https público: a Meta não consegue entregar o webhook aqui."),
      422,
      { requestId },
    );
  }

  const r = await configurarWebhookDoApp({
    appId: parsed.data.app_id,
    segredoDoApp: segredo,
    callbackUrl,
    tokenDeVerificacao: tokenDeVerificacao(segredo, sessao.id),
    rede,
  });
  if (!r.ok) return fail("invalid_request", r.motivo, 422, { requestId });

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: sessao.id,
    requestId,
    metadata: { canal: rede, etapa: "webhook_do_app" },
  });

  return ok({ app_webhook_configured: true }, { requestId });
}
