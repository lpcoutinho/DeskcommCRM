/**
 * Instagram nativo — o que se faz com a CONTA: validar, ligar o webhook dela,
 * renovar o token e (opcionalmente) configurar o webhook do app.
 *
 * ─── Validar ANTES de gravar ────────────────────────────────────────────────
 *
 * `GET /me` com o token descobre a conta sozinho: o operador não caça o id no
 * painel, e não há erro de digitação possível nesse campo. O `user_id` é o id
 * da conta profissional — o mesmo `entry.id` que o webhook manda —, e não o
 * `id` do usuário no app, que é outro número.
 *
 * ─── Duas assinaturas, de lados diferentes ──────────────────────────────────
 *
 * Para a Meta entregar mensagens são precisas DUAS coisas: o app sabe PARA ONDE
 * mandar (URL + token de verificação, configurados no app) e a conta pede para
 * receber (`/me/subscribed_apps`). A segunda é por conta e é feita aqui com o
 * token dela. A primeira é do APP — uma URL por app — e pode ser feita pela
 * tela (`configurarWebhookDoApp`, que exige o id do app) ou à mão no painel.
 */
import { graphBaseUrl } from "../meta/graph-base";
import { chamarGraphInstagram, ErroDaGraphInstagram } from "./graph";

/** Os campos que este canal consome hoje. Assinar o que ninguém lê é ruído. */
export const CAMPOS_DO_WEBHOOK = ["messages", "messaging_seen", "messaging_referral"] as const;

export type ValidacaoDaConta =
  | {
      ok: true;
      accountId: string;
      username: string | null;
      nome: string | null;
      tipoDeConta: string | null;
    }
  | { ok: false; motivo: string };

function texto(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** O token serve, e de qual conta ele é? */
export async function validarConta(token: string): Promise<ValidacaoDaConta> {
  const t = token.trim();
  if (!t) return { ok: false, motivo: "Informe o token de acesso do Instagram." };
  try {
    const eu = await chamarGraphInstagram(t, "me", {
      consulta: { fields: "user_id,username,name,account_type" },
    });
    const accountId = texto(eu.user_id);
    if (!accountId) {
      return { ok: false, motivo: "O token não devolveu o id da conta profissional." };
    }
    return {
      ok: true,
      accountId,
      username: texto(eu.username),
      nome: texto(eu.name),
      tipoDeConta: texto(eu.account_type),
    };
  } catch (e) {
    if (e instanceof ErroDaGraphInstagram) {
      // Rede caída não é token errado — dizer "token inválido" mandaria trocar
      // um token que estava certo.
      if (e.status === null) return { ok: false, motivo: e.message };
      if (e.tokenInvalido) return { ok: false, motivo: "Token recusado pelo Instagram." };
      return { ok: false, motivo: `O Instagram recusou: ${e.message}` };
    }
    throw e;
  }
}

/**
 * A conta pede para receber os eventos do app. Idempotente na Meta: repetir
 * devolve `success: true` de novo. LANÇA `ErroDaGraphInstagram` em falha.
 */
export async function assinarWebhooksDaConta(token: string): Promise<void> {
  const r = await chamarGraphInstagram(token, "me/subscribed_apps", {
    metodo: "POST",
    consulta: { subscribed_fields: CAMPOS_DO_WEBHOOK.join(",") },
  });
  if (r.success !== true) {
    throw new ErroDaGraphInstagram("O Instagram não confirmou a assinatura da conta.", 200, null);
  }
}

/**
 * Renova o token de longa duração. Só funciona com token de mais de 24h e ainda
 * válido; devolve o token novo e QUANDO ele expira — é a única chamada que diz a
 * validade. LANÇA `ErroDaGraphInstagram` em falha.
 */
export async function renovarToken(
  token: string,
  agora: Date = new Date(),
): Promise<{ token: string; expiraEm: string }> {
  const r = await chamarGraphInstagram(token, "refresh_access_token", {
    semVersao: true,
    consulta: { grant_type: "ig_refresh_token" },
  });
  const novo = texto(r.access_token);
  const segundos = typeof r.expires_in === "number" ? r.expires_in : null;
  if (!novo || segundos === null) {
    throw new ErroDaGraphInstagram("A renovação não devolveu o token novo.", 200, null);
  }
  return { token: novo, expiraEm: new Date(agora.getTime() + segundos * 1000).toISOString() };
}

/**
 * Configura no APP para onde a Meta entrega os eventos do Instagram.
 *
 * ⚠️ Um app tem UMA URL por objeto: isto SUBSTITUI o que estiver configurado no
 * app para o Instagram (outra automação apontada para o mesmo app deixa de
 * receber). A tela diz isso antes do clique.
 *
 * A credencial do app (`<id>|<segredo>`) vai no CORPO do POST, nunca na URL: o
 * caminho aparece em log de proxy, o corpo não. A Meta responde com um GET de
 * verificação na URL antes de aceitar — então a instalação precisa estar
 * publicada em https, e o handshake (`respostaDoHandshake`) precisa responder.
 */
export async function configurarWebhookDoApp(input: {
  appId: string;
  segredoDoApp: string;
  callbackUrl: string;
  tokenDeVerificacao: string;
}): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const corpo = new URLSearchParams({
    object: "instagram",
    callback_url: input.callbackUrl,
    verify_token: input.tokenDeVerificacao,
    fields: CAMPOS_DO_WEBHOOK.join(","),
    include_values: "true",
    access_token: `${input.appId}|${input.segredoDoApp}`,
  });
  let resposta: Response;
  try {
    resposta = await fetch(`${graphBaseUrl()}/${encodeURIComponent(input.appId)}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo.toString(),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, motivo: "Não foi possível falar com a Meta. Tente de novo." };
  }
  const json = (await resposta.json().catch(() => null)) as Record<string, unknown> | null;
  const erro = json?.error as Record<string, unknown> | undefined;
  if (!resposta.ok || erro || json?.success !== true) {
    const mensagem = typeof erro?.message === "string" ? erro.message : `HTTP ${resposta.status}`;
    return { ok: false, motivo: `A Meta recusou a configuração do webhook: ${mensagem}` };
  }
  return { ok: true };
}
