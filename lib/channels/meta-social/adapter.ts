/**
 * Instagram nativo — o adapter do seam: enviar, baixar a mídia recebida e dizer
 * se a conexão está de pé.
 *
 * ─── Quem endereça é a thread, nunca telefone ───────────────────────────────
 *
 * No Instagram o destinatário é o id da pessoa DENTRO da conta (IGSID), que só
 * existe depois que ela escreveu. Ele fica em `provider_conversation_id` (a
 * thread), gravado pela entrada. Sem ele não há para quem mandar — e a janela
 * de 24h garante que, dentro dela, ele exista.
 *
 * ─── Envio sem id é falha ───────────────────────────────────────────────────
 *
 * A Meta responde `{ recipient_id, message_id }`. Resposta sem `message_id` não
 * vira "enviado": o eco que volta pelo webhook é casado justamente por esse id,
 * e um envio sem ele apareceria duplicado e pausaria a IA como se uma pessoa
 * tivesse respondido pelo celular.
 */
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { MAX_MEDIA_BYTES, MediaTooLargeError } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { socialMessageId } from "../social/catalog";
import type { ChannelAdapter, ChannelHealth, OutboundEnvelope } from "../types";
import { chamarGraphInstagram, ErroDaGraphInstagram } from "./graph";
import { publicarNoInstagram } from "./publicacao";
import { credencialInstagram } from "./session";

/** Prefixo que o handler traduz para `queued` (sem credencial ≠ falha de envio). */
const NAO_CONFIGURADO = "meta_social_not_configured";

/** Saltos de redirecionamento aceitos ao baixar mídia da CDN da Meta. */
const MAX_SALTOS = 3;

/** O tipo de anexo que a API de mensagens do Instagram aceita, por tipo nosso. */
function tipoDeAnexo(kind: OutboundEnvelope["kind"]): "image" | "video" | "audio" | "file" | null {
  switch (kind) {
    case "image":
    case "video":
    case "audio":
      return kind;
    case "document":
      return "file";
    default:
      return null;
  }
}

async function baixarSemCredencial(url: string): Promise<Response> {
  // A URL da mídia é da CDN da Meta, assinada e temporária: ela NUNCA recebe o
  // token da conta. Os redirecionamentos são seguidos à mão para que cada salto
  // passe pela mesma checagem anti-SSRF do primeiro.
  let atual = url;
  for (let salto = 0; salto <= MAX_SALTOS; salto++) {
    assertSafeOutboundUrl(atual);
    await assertDestinoResolvidoSeguro(new URL(atual).hostname);
    const r = await fetch(atual, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const destino = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!destino) return r;
    await r.body?.cancel();
    atual = new URL(destino, atual).toString();
  }
  throw new Error("A mídia redirecionou vezes demais.");
}

export const metaSocialAdapter: ChannelAdapter = {
  provider: CHANNEL_PROVIDER_META_SOCIAL,

  // Quem endereça é a thread gravada (`providerConversationId`), nunca telefone.
  // O valor aqui só diz ao handler que há destinatário possível.
  resolveRecipient: (input) => (input.isGroup ? null : "provider-thread"),

  /**
   * `true` sempre, como os outros canais com credencial na sessão: o método é
   * síncrono e não consulta o banco. Quem desiste é o `send`, que LANÇA
   * `meta_social_not_configured` — o handler traduz o prefixo para `queued`.
   */
  isConfigured: () => true,

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "meta_social_error",
    unknownError: "meta_social_unknown",
  },

  templates: undefined,

  async sendTemplate() {
    throw new Error("O Instagram não usa modelos de WhatsApp.");
  },

  // Publicar no perfil (feed, reels, stories) — ver `./publicacao.ts`.
  publicarConteudo: (input) => publicarNoInstagram(input),

  async checkHealth(input): Promise<ChannelHealth> {
    const cred = await credencialInstagram(createAdminClient(), {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });
    if (!cred) return { reachable: true, status: "FAILED", detail: "credencial_indisponivel" };
    try {
      await chamarGraphInstagram(cred.token, "me", { consulta: { fields: "user_id" } });
      return { reachable: true, status: "WORKING", detail: null };
    } catch (e) {
      if (e instanceof ErroDaGraphInstagram && e.tokenInvalido) {
        return { reachable: true, status: "FAILED", detail: "token_invalido_reconecte" };
      }
      const detalhe = e instanceof Error ? e.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detalhe.slice(0, 200) };
    }
  },

  async fetchInboundMedia(input) {
    const resposta = await baixarSemCredencial(input.url);
    if (!resposta.ok) throw new Error(`Falha ao baixar mídia (HTTP ${resposta.status}).`);
    if (Number(resposta.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) {
      await resposta.body?.cancel();
      throw new MediaTooLargeError();
    }
    const reader = resposta.body?.getReader();
    if (!reader) throw new Error("A mídia retornou um corpo vazio.");
    const partes: Uint8Array[] = [];
    let tamanho = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tamanho += value.byteLength;
        if (tamanho > MAX_MEDIA_BYTES) {
          await reader.cancel();
          throw new MediaTooLargeError();
        }
        partes.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      buffer: Buffer.concat(partes),
      mime:
        resposta.headers.get("content-type")?.split(";")[0] ??
        input.hintMime ??
        "application/octet-stream",
    };
  },

  async send(envelope) {
    if (!envelope.providerConversationId) {
      throw new Error("Aguarde uma mensagem do cliente para responder no Instagram.");
    }
    const anexo = envelope.media ? tipoDeAnexo(envelope.kind) : null;
    if (envelope.kind !== "text" && !anexo) {
      throw new Error("Este tipo de mensagem ainda não é suportado no Instagram.");
    }
    // A API do Instagram não tem legenda: anexo e texto são duas mensagens, e a
    // segunda voltaria pelo webhook como um envio feito FORA do CRM — pausando a
    // IA como se uma pessoa tivesse respondido. Recusar é honesto; a tela orienta.
    if (anexo && envelope.media?.caption?.trim()) {
      throw new Error("No Instagram a legenda não vai junto do anexo: envie o texto numa mensagem separada.");
    }

    const cred = await credencialInstagram(createAdminClient(), {
      organizationId: envelope.organizationId,
      accountId: envelope.sessionRef,
    });
    if (!cred) {
      throw new Error(`${NAO_CONFIGURADO}: reconecte a conta em Conexões › Instagram.`);
    }

    const message =
      anexo && envelope.media
        ? { attachment: { type: anexo, payload: { url: envelope.media.url } } }
        : { text: envelope.body ?? "" };

    await envelope.beforeSend?.();
    const resposta = await chamarGraphInstagram(cred.token, "me/messages", {
      metodo: "POST",
      corpo: {
        recipient: { id: envelope.providerConversationId },
        message,
      },
    });
    const mid = typeof resposta.message_id === "string" ? resposta.message_id : null;
    if (!mid) {
      throw new Error("Envio sem confirmação do Instagram. Confira a conversa antes de tentar novamente.");
    }
    return { externalId: socialMessageId(cred.accountId, mid) };
  },
};
