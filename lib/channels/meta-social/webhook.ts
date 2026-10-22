/**
 * Instagram nativo — o webhook, como módulo PURO: assinatura, handshake e leitura.
 *
 * ─── A assinatura é a da Meta, com o segredo DO APP ─────────────────────────
 *
 * A Meta assina o corpo cru com HMAC-SHA256 e o segredo do app
 * (`X-Hub-Signature-256: sha256=<hex>`) — o mesmo esquema do canal oficial do
 * WhatsApp, e por isso a conferência é `verifyMetaSignature`. A diferença é de
 * ONDE vem o segredo: lá é da instalação (`META_APP_SECRET`); aqui cada
 * organização traz o próprio app, e o segredo dele mora cifrado na sessão.
 *
 * ─── O token de verificação é DERIVADO, não guardado ────────────────────────
 *
 * O handshake (GET com `hub.verify_token`) só prova que quem assinou o webhook
 * no painel da Meta conhecia um valor nosso. Guardar mais um segredo por sessão
 * seria mais uma coluna sem ganho: o token sai do segredo do app e do id da
 * sessão por HMAC, então é estável, único por conexão e só quem tem o segredo
 * o recalcula. A tela o mostra para colar; o GET o recalcula para conferir.
 *
 * ─── O que este canal lê ────────────────────────────────────────────────────
 *
 * `object: "instagram"`, `entry[].messaging[]`: mensagem do cliente, eco do que
 * a conta enviou (pelo CRM ou pelo app do Instagram) e leitura.
 * `entry[].changes[]` com `field: "comments"`: comentário numa publicação da
 * conta. O que a PRÓPRIA conta comenta (inclusive a resposta pública que a
 * automação acabou de dar, que volta por aqui) não entra: regra que responde
 * comentário dispararia sobre a própria resposta. Outras mudanças (`mentions`,
 * `live_comments`…) são contadas e não gravadas.
 *
 * `object: "page"` é a página do Facebook (Messenger): `messaging[]` tem a MESMA
 * forma (eco com `is_echo`, `mid`, anexos com `payload.url`), e o comentário
 * chega em `changes[field=feed]`. A leitura do Messenger vem por marca d'água
 * (`read.watermark`, sem `mid`) e é contada, não aplicada.
 */
import { createHmac } from "node:crypto";

import { verifyMetaSignature } from "../meta/webhook";
import { socialMessageId } from "../social/catalog";
import type { SocialMessage } from "../social/parser";
import type { RedeSocial } from "./graph";

/** O header em que a Meta manda a assinatura do corpo. */
export const HEADER_ASSINATURA_META = "x-hub-signature-256";

/** A rede desta conexão, gravada em `metadata.social_platform`. */
export const REDE_INSTAGRAM = "instagram" as const;
/** A página do Facebook (Messenger): o webhook chega como `object: "page"`. */
export const REDE_FACEBOOK = "facebook" as const;

/** A assinatura confere com o segredo do app? */
export function verificarAssinaturaInstagram(
  rawBody: string,
  headers: Headers,
  segredoDoApp: string | null,
): boolean {
  if (!segredoDoApp) return false;
  return verifyMetaSignature(rawBody, headers.get(HEADER_ASSINATURA_META), segredoDoApp);
}

/** O token que a tela mostra e o handshake confere, derivado do segredo do app. */
export function tokenDeVerificacao(segredoDoApp: string, channelSessionId: string): string {
  return createHmac("sha256", segredoDoApp)
    .update(`verificacao-do-webhook:${channelSessionId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Resposta do handshake: o `hub.challenge`, ou `null` para recusar. */
export function respostaDoHandshake(
  params: URLSearchParams,
  segredoDoApp: string | null,
  channelSessionId: string,
): string | null {
  if (!segredoDoApp) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const recebido = params.get("hub.verify_token");
  if (!recebido || recebido !== tokenDeVerificacao(segredoDoApp, channelSessionId)) return null;
  return params.get("hub.challenge");
}

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
/** A Meta manda ids como string, mas já houve número em payload de teste. */
const id = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : str(v);

/** A leitura de um entregável do webhook: o que gravar, e o que só contar. */
export interface LeituraDoWebhookInstagram {
  /** O corpo é de outro objeto (`whatsapp_business_account`…). */
  objetoEstranho: boolean;
  /** `instagram` (object `instagram`) ou `facebook` (object `page`). */
  rede: RedeSocial;
  /** Contas (`entry.id`) que aparecem no corpo — a guarda confere com a sessão. */
  contas: string[];
  /** Mensagens e ecos desta conta, já no formato da ingestão social. */
  mensagens: SocialMessage[];
  /** Leituras: o cliente viu a mensagem com este `mid`. */
  leituras: { accountId: string; externalId: string; lidaEm: string | null }[];
  /** Comentários de outras pessoas nas publicações da conta. */
  comentarios: ComentarioRecebido[];
  /** Mudanças que não são comentário de terceiro (comentário da conta, menção…). */
  mudancasIgnoradas: number;
  /** Itens de `messaging` que não são mensagem nem leitura (reação, postback…). */
  eventosIgnorados: number;
}

/** Um comentário recebido, no formato da gravação em `social_comments`. */
export interface ComentarioRecebido {
  accountId: string;
  externalId: string;
  mediaExternalId: string | null;
  /** `FEED`, `REELS`, `AD`… — vocabulário aberto da Meta. */
  mediaProductType: string | null;
  /** Presente quando o comentário responde outro comentário. */
  parentExternalId: string | null;
  authorExternalId: string | null;
  authorUsername: string | null;
  texto: string | null;
  /** O `entry.time` (segundos); a Meta não manda a hora do comentário em si. */
  comentadoEm: string | null;
}

function instante(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Tipos de anexo da Meta que a caixa de entrada sabe mostrar com o que já tem. */
function tipoDoAnexo(tipo: string | null): string {
  switch (tipo) {
    case "image":
    case "video":
    case "audio":
      return tipo;
    // Reel e publicação compartilhados chegam com a URL do vídeo/da mídia.
    case "ig_reel":
    case "reel":
      return "video";
    case "animated_image":
      return "image";
    default:
      return "document";
  }
}

function lerMensagem(
  conta: string,
  item: Bruto,
  rede: RedeSocial,
): { tipo: "mensagem"; msg: SocialMessage } | { tipo: "leitura"; mid: string; em: string | null } | null {
  const remetente = id(obj(item.sender)?.id);
  const destinatario = id(obj(item.recipient)?.id);
  const quando = instante(item.timestamp);

  const leitura = obj(item.read);
  if (leitura) {
    const mid = str(leitura.mid);
    return mid ? { tipo: "leitura", mid, em: quando } : null;
  }

  const m = obj(item.message);
  if (!m || !remetente || !destinatario) return null;
  // Mensagem apagada pelo cliente: não há o que gravar, e criar uma linha vazia
  // seria inventar uma mensagem.
  if (m.is_deleted === true) return null;
  const mid = str(m.mid);
  if (!mid) return null;

  // Eco = a CONTA enviou (pelo CRM ou pelo app do Instagram). O participante é
  // quem recebeu; na entrada, quem mandou. O eco do nosso próprio envio volta
  // com o mesmo `mid` que o envio devolveu e cai na deduplicação.
  const eco = m.is_echo === true || remetente === conta;
  const participante = eco ? destinatario : remetente;
  if (participante === conta) return null; // a conta falando consigo mesma

  const anexos: { type: string; url: string }[] = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    const anexo = obj(a);
    const url = str(obj(anexo?.payload)?.url);
    if (url) anexos.push({ type: tipoDoAnexo(str(anexo?.type)), url });
  }

  return {
    tipo: "mensagem",
    msg: {
      platform: rede,
      participantId: participante,
      accountId: conta,
      // A "thread" do Instagram É o participante: o envio endereça por
      // `recipient.id`, e é isso que fica em `provider_conversation_id`.
      conversationId: participante,
      externalId: socialMessageId(conta, mid),
      direction: eco ? "outbound" : "inbound",
      kind: "message",
      status: eco ? "sent" : undefined,
      text: str(m.text),
      sentAt: quando,
      attachments: anexos,
      // O clique em anúncio que abre a conversa chega como `referral`; quem
      // interpreta é a atribuição de anúncio, como nos outros canais.
      referral: obj(item.referral) ?? obj(m.referral) ?? null,
      identity: { phone: null, bsuid: null, anchor: null, username: null, displayName: null },
    },
  };
}

/**
 * Comentário na página do Facebook: chega dentro de `feed`, junto com curtida,
 * publicação nova e edição. Só `item: "comment"` com `verb: "add"` é comentário
 * novo; edição e remoção não disparam regra (a resposta já saiu, ou não há a
 * quem responder).
 */
function lerComentarioDaPagina(conta: string, mudanca: Bruto, quando: string | null): ComentarioRecebido | null {
  if (mudanca.field !== "feed") return null;
  const v = obj(mudanca.value);
  if (!v || v.item !== "comment" || v.verb !== "add") return null;
  const externalId = id(v.comment_id);
  if (!externalId) return null;
  const autor = obj(v.from);
  const autorId = id(autor?.id);
  // A página comentando (a resposta pública da automação volta por aqui).
  if (autorId === conta) return null;
  const post = id(v.post_id);
  const pai = id(v.parent_id);
  const criado = typeof v.created_time === "number" ? instante(v.created_time * 1000) : null;
  return {
    accountId: conta,
    externalId,
    mediaExternalId: post,
    mediaProductType: "PAGE_POST",
    // Comentário de primeiro nível traz o próprio post como pai.
    parentExternalId: pai && pai !== post ? pai : null,
    authorExternalId: autorId,
    // A página não manda @: o nome de quem comentou é o que identifica.
    authorUsername: str(autor?.name),
    texto: str(v.message),
    comentadoEm: criado ?? quando,
  };
}

function lerComentario(conta: string, mudanca: Bruto, quando: string | null): ComentarioRecebido | null {
  if (mudanca.field !== "comments") return null;
  const v = obj(mudanca.value);
  const externalId = id(v?.id);
  if (!v || !externalId) return null;
  const autor = obj(v.from);
  const autorId = id(autor?.id);
  // A conta comentando (a resposta pública da automação volta por aqui).
  if (autorId === conta) return null;
  const midia = obj(v.media);
  return {
    accountId: conta,
    externalId,
    mediaExternalId: id(midia?.id),
    mediaProductType: str(midia?.media_product_type),
    parentExternalId: id(v.parent_id),
    authorExternalId: autorId,
    authorUsername: str(autor?.username),
    texto: str(v.text),
    comentadoEm: quando,
  };
}

/**
 * Lê o corpo de um entregável. Nunca lança: JSON inválido ou objeto estranho
 * voltam como leitura vazia, e quem decide o desfecho é a entrada.
 */
export function lerWebhookInstagram(rawBody: string): LeituraDoWebhookInstagram | null {
  let corpo: Bruto | null;
  try {
    corpo = obj(JSON.parse(rawBody));
  } catch {
    return null;
  }
  if (!corpo) return null;

  const leitura: LeituraDoWebhookInstagram = {
    objetoEstranho: corpo.object !== "instagram" && corpo.object !== "page",
    rede: corpo.object === "page" ? REDE_FACEBOOK : REDE_INSTAGRAM,
    contas: [],
    mensagens: [],
    leituras: [],
    comentarios: [],
    mudancasIgnoradas: 0,
    eventosIgnorados: 0,
  };
  if (leitura.objetoEstranho) return leitura;

  for (const e of Array.isArray(corpo.entry) ? corpo.entry : []) {
    const entrada = obj(e);
    const conta = id(entrada?.id);
    if (!entrada || !conta) continue;
    if (!leitura.contas.includes(conta)) leitura.contas.push(conta);

    // `entry.time` vem em SEGUNDOS no exemplo de comentário da Meta e em ms em
    // entregas de mensagem; abaixo de 10^12 é segundo (10^12 ms é 2001).
    const quando =
      typeof entrada.time === "number"
        ? instante(entrada.time < 1e12 ? entrada.time * 1000 : entrada.time)
        : null;
    for (const m of Array.isArray(entrada.changes) ? entrada.changes : []) {
      const mudanca = obj(m);
      const comentario = !mudanca
        ? null
        : leitura.rede === REDE_FACEBOOK
          ? lerComentarioDaPagina(conta, mudanca, quando)
          : lerComentario(conta, mudanca, quando);
      if (comentario) leitura.comentarios.push(comentario);
      else leitura.mudancasIgnoradas += 1;
    }

    for (const i of Array.isArray(entrada.messaging) ? entrada.messaging : []) {
      const item = obj(i);
      const lido = item ? lerMensagem(conta, item, leitura.rede) : null;
      if (!lido) {
        leitura.eventosIgnorados += 1;
        continue;
      }
      if (lido.tipo === "leitura") {
        leitura.leituras.push({
          accountId: conta,
          externalId: socialMessageId(conta, lido.mid),
          lidaEm: lido.em,
        });
      } else {
        leitura.mensagens.push(lido.msg);
      }
    }
  }
  return leitura;
}
