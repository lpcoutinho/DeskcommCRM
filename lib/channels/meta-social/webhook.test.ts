import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { respostaDoHandshakeDeEntrada } from "../inbound";
import {
  lerWebhookInstagram,
  respostaDoHandshake,
  tokenDeVerificacao,
  verificarAssinaturaInstagram,
} from "./webhook";

/**
 * O webhook do Instagram nativo, no formato documentado pela Meta
 * (`object: "instagram"`, `entry[].messaging[]`). As fixtures seguem a forma
 * dos exemplos da documentação de Webhooks da Plataforma do Instagram.
 */
const CONTA = "17841400000000001";
const CLIENTE = "9876543210123456";
const SEGREDO = "0123456789abcdef0123456789abcdef";
const SESSAO = "8f9a0e8e-1c5b-4b3a-9d7f-2f1e0c4b7a11";

function corpo(messaging: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    object: "instagram",
    entry: [{ time: 1761000000000, id: CONTA, messaging, ...extra }],
  });
}

const textoDoCliente = {
  sender: { id: CLIENTE },
  recipient: { id: CONTA },
  timestamp: 1761000000000,
  message: { mid: "aWdfZAG1faWQ6MTIz", text: "oi, quanto custa?" },
};

describe("lerWebhookInstagram", () => {
  it("mensagem do cliente vira entrada social com a thread = o cliente", () => {
    const l = lerWebhookInstagram(corpo([textoDoCliente]));
    expect(l?.objetoEstranho).toBe(false);
    expect(l?.contas).toEqual([CONTA]);
    expect(l?.mensagens).toHaveLength(1);
    const m = l!.mensagens[0]!;
    expect(m.direction).toBe("inbound");
    expect(m.platform).toBe("instagram");
    expect(m.participantId).toBe(CLIENTE);
    expect(m.conversationId).toBe(CLIENTE);
    expect(m.accountId).toBe(CONTA);
    expect(m.text).toBe("oi, quanto custa?");
    expect(m.externalId).toBe(`social:${CONTA}:aWdfZAG1faWQ6MTIz`);
    expect(m.sentAt).toBe(new Date(1761000000000).toISOString());
    // Sem telefone, nunca: a identidade é social.
    expect(m.identity.phone).toBeNull();
  });

  it("eco (a conta enviou) é SAÍDA, e o participante é quem recebeu", () => {
    const eco = {
      sender: { id: CONTA },
      recipient: { id: CLIENTE },
      timestamp: 1761000001000,
      message: { mid: "mid-do-eco", text: "custa 10", is_echo: true },
    };
    const m = lerWebhookInstagram(corpo([eco]))!.mensagens[0]!;
    expect(m.direction).toBe("outbound");
    expect(m.participantId).toBe(CLIENTE);
    expect(m.conversationId).toBe(CLIENTE);
    // O id do eco é o MESMO formato que o envio devolve: é assim que o eco do
    // nosso próprio envio cai na deduplicação.
    expect(m.externalId).toBe(`social:${CONTA}:mid-do-eco`);
  });

  it("anexos levam a URL e o tipo que a caixa de entrada sabe mostrar", () => {
    const comAnexos = {
      ...textoDoCliente,
      message: {
        mid: "m2",
        attachments: [
          { type: "image", payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1" } },
          { type: "ig_reel", payload: { url: "https://lookaside.fbsbx.com/reel.mp4", title: "x" } },
          { type: "file", payload: { url: "https://lookaside.fbsbx.com/doc.pdf" } },
          { type: "story_mention" }, // sem URL: não vira anexo
        ],
      },
    };
    const m = lerWebhookInstagram(corpo([comAnexos]))!.mensagens[0]!;
    expect(m.text).toBeNull();
    expect(m.attachments).toEqual([
      { type: "image", url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1" },
      { type: "video", url: "https://lookaside.fbsbx.com/reel.mp4" },
      { type: "document", url: "https://lookaside.fbsbx.com/doc.pdf" },
    ]);
  });

  it("leitura vira desfecho da mensagem pelo mesmo id", () => {
    const lida = {
      sender: { id: CLIENTE },
      recipient: { id: CONTA },
      timestamp: 1761000002000,
      read: { mid: "mid-do-eco" },
    };
    const l = lerWebhookInstagram(corpo([lida]))!;
    expect(l.mensagens).toHaveLength(0);
    expect(l.leituras).toEqual([
      {
        accountId: CONTA,
        externalId: `social:${CONTA}:mid-do-eco`,
        lidaEm: new Date(1761000002000).toISOString(),
      },
    ]);
  });

  it("mensagem apagada, reação e postback não viram mensagem (são contados)", () => {
    const apagada = { ...textoDoCliente, message: { mid: "m3", is_deleted: true } };
    const reacao = { ...textoDoCliente, message: undefined, reaction: { mid: "m1", action: "react" } };
    const l = lerWebhookInstagram(corpo([apagada, reacao]))!;
    expect(l.mensagens).toHaveLength(0);
    expect(l.eventosIgnorados).toBe(2);
  });

  it("comentário de outra pessoa vira comentário recebido, com a publicação e o autor", () => {
    // Forma do exemplo da documentação de webhooks de comentário do Instagram.
    const l = lerWebhookInstagram(
      JSON.stringify({
        object: "instagram",
        entry: [
          {
            id: CONTA,
            time: 1761000000,
            changes: [
              {
                field: "comments",
                value: {
                  from: { id: CLIENTE, username: "maria.silva" },
                  media: { id: "17900000000000001", media_product_type: "FEED" },
                  id: "17865799348089039",
                  text: "eu quero!",
                },
              },
            ],
          },
        ],
      }),
    )!;
    expect(l.mensagens).toHaveLength(0);
    expect(l.mudancasIgnoradas).toBe(0);
    expect(l.comentarios).toEqual([
      {
        accountId: CONTA,
        externalId: "17865799348089039",
        mediaExternalId: "17900000000000001",
        mediaProductType: "FEED",
        parentExternalId: null,
        authorExternalId: CLIENTE,
        authorUsername: "maria.silva",
        texto: "eu quero!",
        // `time` em segundos vira o instante certo, não o ano 57000.
        comentadoEm: new Date(1761000000 * 1000).toISOString(),
      },
    ]);
  });

  it("⭐ o comentário da PRÓPRIA conta não entra (a resposta pública da regra volta por aqui)", () => {
    const l = lerWebhookInstagram(
      corpo([], {
        changes: [
          { field: "comments", value: { from: { id: CONTA, username: "loja" }, id: "c2", text: "Te chamei no direct!" } },
          { field: "mentions", value: { media_id: "m1", comment_id: "c3" } },
        ],
      }),
    )!;
    expect(l.comentarios).toHaveLength(0);
    expect(l.mudancasIgnoradas).toBe(2);
  });

  it("objeto de outra rede não é lido; JSON inválido devolve null", () => {
    expect(lerWebhookInstagram(JSON.stringify({ object: "whatsapp_business_account", entry: [] }))?.objetoEstranho).toBe(
      true,
    );
    expect(lerWebhookInstagram("{não é json")).toBeNull();
  });

  it("ids numéricos (como em payload de teste do painel) viram string", () => {
    const numerico = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: 17841400000000001,
          messaging: [{ sender: { id: 42 }, recipient: { id: 17841400000000001 }, message: { mid: "x", text: "a" } }],
        },
      ],
    });
    const m = lerWebhookInstagram(numerico)!.mensagens[0]!;
    expect(m.participantId).toBe("42");
  });
});

describe("assinatura e handshake", () => {
  const raw = corpo([textoDoCliente]);
  const assinar = (s: string) => `sha256=${createHmac("sha256", s).update(raw, "utf8").digest("hex")}`;

  it("confere com a chave secreta do app e recusa qualquer outra", () => {
    const ok = new Headers({ "x-hub-signature-256": assinar(SEGREDO) });
    const outra = new Headers({ "x-hub-signature-256": assinar("f".repeat(32)) });
    expect(verificarAssinaturaInstagram(raw, ok, SEGREDO)).toBe(true);
    expect(verificarAssinaturaInstagram(raw, outra, SEGREDO)).toBe(false);
    expect(verificarAssinaturaInstagram(raw, new Headers(), SEGREDO)).toBe(false);
    expect(verificarAssinaturaInstagram(raw, ok, null)).toBe(false);
    // Um byte a mais no corpo e a assinatura não bate: o HMAC é sobre o corpo cru.
    expect(verificarAssinaturaInstagram(`${raw} `, ok, SEGREDO)).toBe(false);
  });

  it("o handshake devolve o challenge só com o token derivado desta sessão", () => {
    const token = tokenDeVerificacao(SEGREDO, SESSAO);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    const q = (verify: string) =>
      new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": verify, "hub.challenge": "1158201444" });
    expect(respostaDoHandshake(q(token), SEGREDO, SESSAO)).toBe("1158201444");
    expect(respostaDoHandshake(q(token), SEGREDO, "outra-sessao")).toBeNull();
    expect(respostaDoHandshake(q("errado"), SEGREDO, SESSAO)).toBeNull();
    expect(respostaDoHandshake(q(token), null, SESSAO)).toBeNull();
  });

  it("pela entrada genérica, só o canal do Instagram responde handshake", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": tokenDeVerificacao(SEGREDO, SESSAO),
      "hub.challenge": "42",
    });
    expect(respostaDoHandshakeDeEntrada("meta_social", params, SEGREDO, SESSAO)).toBe("42");
    expect(respostaDoHandshakeDeEntrada("zernio_social", params, SEGREDO, SESSAO)).toBeNull();
  });
});

/**
 * A página do Facebook (Messenger): `object: "page"`, mesma forma de
 * `messaging[]`, e o comentário em `changes[field=feed]` — formas dos exemplos
 * da documentação da Plataforma do Messenger e do webhook de página.
 */
describe("lerWebhookInstagram — página do Facebook", () => {
  const PAGINA = "101000000000001";
  const PSID = "7000000000000001";
  const daPagina = (entrada: Record<string, unknown>) =>
    JSON.stringify({ object: "page", entry: [{ id: PAGINA, time: 1761000000000, ...entrada }] });

  it("mensagem do Messenger vira entrada social da rede facebook; eco da página é saída", () => {
    const l = lerWebhookInstagram(
      daPagina({
        messaging: [
          { sender: { id: PSID }, recipient: { id: PAGINA }, timestamp: 1761000000000, message: { mid: "m.1", text: "oi" } },
          {
            sender: { id: PAGINA },
            recipient: { id: PSID },
            timestamp: 1761000001000,
            message: { mid: "m.2", text: "olá!", is_echo: true },
          },
        ],
      }),
    )!;
    expect(l.objetoEstranho).toBe(false);
    expect(l.rede).toBe("facebook");
    expect(l.mensagens.map((m) => [m.platform, m.direction, m.participantId, m.externalId])).toEqual([
      ["facebook", "inbound", PSID, `social:${PAGINA}:m.1`],
      ["facebook", "outbound", PSID, `social:${PAGINA}:m.2`],
    ]);
  });

  it("comentário novo na página vira comentário recebido; curtida, edição e a resposta da própria página não", () => {
    const l = lerWebhookInstagram(
      daPagina({
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: `${PAGINA}_900_1`,
              post_id: `${PAGINA}_900`,
              parent_id: `${PAGINA}_900`,
              from: { id: PSID, name: "Maria Silva" },
              message: "eu quero",
              created_time: 1761000000,
            },
          },
          { field: "feed", value: { item: "reaction", verb: "add", post_id: `${PAGINA}_900` } },
          { field: "feed", value: { item: "comment", verb: "edited", comment_id: `${PAGINA}_900_1` } },
          {
            field: "feed",
            value: { item: "comment", verb: "add", comment_id: `${PAGINA}_900_2`, from: { id: PAGINA, name: "Loja" } },
          },
        ],
      }),
    )!;
    expect(l.comentarios).toEqual([
      {
        accountId: PAGINA,
        externalId: `${PAGINA}_900_1`,
        mediaExternalId: `${PAGINA}_900`,
        mediaProductType: "PAGE_POST",
        parentExternalId: null,
        authorExternalId: PSID,
        authorUsername: "Maria Silva",
        texto: "eu quero",
        comentadoEm: new Date(1761000000 * 1000).toISOString(),
      },
    ]);
    expect(l.mudancasIgnoradas).toBe(3);
  });
});
