/**
 * Instagram nativo — o cliente HTTP da API do Instagram (login do Instagram).
 *
 * É um host DIFERENTE do canal oficial do WhatsApp (`graph.instagram.com`, não
 * `graph.facebook.com`), com a MESMA versão da Graph: a instalação não deve
 * conviver com duas versões da plataforma (`lib/graph-version.ts`).
 *
 * ─── O token vai no header, nunca na URL ────────────────────────────────────
 *
 * A API aceita `access_token` como parâmetro de consulta, e o fluxo n8n de
 * origem deste canal mandava assim em parte das chamadas. Aqui não: URL vai para
 * log de proxy, de CDN e de erro, e um token de 60 dias num log é a conta da
 * empresa exposta. `Authorization: Bearer` em toda chamada.
 *
 * ─── Erro da plataforma vira erro com código ────────────────────────────────
 *
 * A Graph responde `{ error: { code, error_subcode, message } }`, às vezes com
 * HTTP 200. Quem chama precisa distinguir "token morto" (190) de "tente depois"
 * (rede, 5xx, limite), porque os dois levam a desfechos diferentes na tela e no
 * vigia de conexão — por isso `ErroDaGraphInstagram` carrega o código.
 */
import { graphVersion } from "@/lib/graph-version";
import { logger } from "@/lib/logger";

import { hostAceito } from "../meta/graph-base";

/** O host real. A instalação que não aponta a variável fala com a Meta. */
export const HOST_PADRAO_DO_INSTAGRAM = "https://graph.instagram.com";

/** Prazo de cada chamada. A Graph responde em centenas de ms; 15 s é rede ruim. */
const PRAZO_MS = 15_000;

/** Código da Graph para token inválido, expirado ou revogado. */
export const CODIGO_TOKEN_INVALIDO = 190;

/**
 * O host desta instalação. `META_INSTAGRAM_BASE_URL` existe para a prova em
 * tela com receptor local; valor inválido volta ao host real com aviso, como no
 * canal oficial (`graph-base.ts`) — um erro de digitação no `.env` não pode
 * derrubar o canal.
 */
export function instagramHost(): string {
  const daVariavel = process.env.META_INSTAGRAM_BASE_URL?.trim();
  if (!daVariavel) return HOST_PADRAO_DO_INSTAGRAM;
  const aceito = hostAceito(daVariavel);
  if (aceito) return aceito;
  logger.warn("[canal.instagram] META_INSTAGRAM_BASE_URL recusado; falando com o host real", {
    valor: daVariavel,
  });
  return HOST_PADRAO_DO_INSTAGRAM;
}

/** Base com a versão: `https://graph.instagram.com/v22.0`. */
export function instagramBaseUrl(): string {
  return `${instagramHost()}/${graphVersion()}`;
}

export class ErroDaGraphInstagram extends Error {
  constructor(
    message: string,
    /** HTTP da resposta; `null` quando nem houve resposta (rede, prazo). */
    readonly status: number | null,
    /** `error.code` da Graph, quando veio. */
    readonly codigo: number | null,
  ) {
    super(message);
    this.name = "ErroDaGraphInstagram";
  }

  /** O token não serve mais — reconectar é o único conserto. */
  get tokenInvalido(): boolean {
    return this.codigo === CODIGO_TOKEN_INVALIDO || this.status === 401;
  }
}

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Uma chamada à API do Instagram. `caminho` é relativo à base versionada
 * (`me`, `me/messages`, `<id>/replies`). Devolve o corpo JSON ou LANÇA
 * `ErroDaGraphInstagram` — inclusive no `error` com HTTP 200.
 */
export async function chamarGraphInstagram(
  token: string,
  caminho: string,
  opcoes: {
    metodo?: "GET" | "POST";
    corpo?: unknown;
    consulta?: Record<string, string>;
    /** A renovação de token mora fora da base versionada (`/refresh_access_token`). */
    semVersao?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const base = opcoes.semVersao ? instagramHost() : instagramBaseUrl();
  const url = new URL(`${base}/${caminho.replace(/^\/+/, "")}`);
  for (const [chave, valor] of Object.entries(opcoes.consulta ?? {})) {
    url.searchParams.set(chave, valor);
  }

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: opcoes.metodo ?? (opcoes.corpo === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opcoes.corpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(PRAZO_MS),
    });
  } catch {
    throw new ErroDaGraphInstagram("Não foi possível falar com o Instagram.", null, null);
  }

  const corpo = objeto(await resposta.json().catch(() => null));
  const erro = objeto(corpo?.error);
  if (!resposta.ok || erro) {
    const codigo = typeof erro?.code === "number" ? erro.code : null;
    const mensagem =
      typeof erro?.message === "string" && erro.message.trim()
        ? erro.message.trim()
        : `O Instagram respondeu ${resposta.status}.`;
    throw new ErroDaGraphInstagram(mensagem, resposta.status, codigo);
  }
  return corpo ?? {};
}
