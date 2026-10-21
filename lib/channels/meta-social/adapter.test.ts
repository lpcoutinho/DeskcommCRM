import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const credencial = vi.fn();
vi.mock("./session", () => ({ credencialInstagram: (...a: unknown[]) => credencial(...a) }));

import type { OutboundEnvelope } from "../types";
import { metaSocialAdapter } from "./adapter";

const CONTA = "17841400000000001";

function envelope(extra: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: "org-1",
    sessionRef: CONTA,
    to: "provider-thread",
    kind: "text",
    body: "olá!",
    providerConversationId: "9876543210123456",
    ...extra,
  } as OutboundEnvelope;
}

describe("metaSocialAdapter.send", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    credencial.mockResolvedValue({
      channelSessionId: "s1",
      accountId: CONTA,
      token: "IGAAtoken",
      tokenExpiresAt: null,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    credencial.mockReset();
  });

  it("envia texto para a thread com o token no header, e devolve o id no formato do eco", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ recipient_id: "9876543210123456", message_id: "mid-1" }), { status: 200 }),
    );
    const r = await metaSocialAdapter.send(envelope());
    expect(r.externalId).toBe(`social:${CONTA}:mid-1`);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/graph\.instagram\.com\/v\d+\.\d+\/me\/messages$/);
    // O token nunca vai na URL.
    expect(String(url)).not.toContain("IGAAtoken");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer IGAAtoken" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      recipient: { id: "9876543210123456" },
      message: { text: "olá!" },
    });
  });

  it("documento vai como anexo do tipo file", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message_id: "mid-2" }), { status: 200 }));
    await metaSocialAdapter.send(
      envelope({ kind: "document", body: undefined, media: { url: "https://x.supabase.co/s/a.pdf" } as never }),
    );
    const corpo = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(corpo.message).toEqual({
      attachment: { type: "file", payload: { url: "https://x.supabase.co/s/a.pdf" } },
    });
  });

  it("sem thread, sem credencial, com legenda ou sem message_id: recusa, nunca 'enviado'", async () => {
    await expect(metaSocialAdapter.send(envelope({ providerConversationId: null }))).rejects.toThrow(
      /Aguarde uma mensagem do cliente/,
    );

    await expect(
      metaSocialAdapter.send(
        envelope({ kind: "image", media: { url: "https://x/a.jpg", caption: "veja" } as never }),
      ),
    ).rejects.toThrow(/legenda/);

    credencial.mockResolvedValueOnce(null);
    await expect(metaSocialAdapter.send(envelope())).rejects.toThrow(/^meta_social_not_configured/);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ recipient_id: "x" }), { status: 200 }));
    await expect(metaSocialAdapter.send(envelope())).rejects.toThrow(/sem confirmação/);

    // Erro da Graph com HTTP 200 também é erro.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 10, message: "fora da janela" } }), { status: 200 }),
    );
    await expect(metaSocialAdapter.send(envelope())).rejects.toThrow(/fora da janela/);
  });
});

describe("metaSocialAdapter.checkHealth", () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    credencial.mockReset();
  });

  it("token morto (190) é FAILED com o motivo; rede caída é inalcançável", async () => {
    credencial.mockResolvedValue({ channelSessionId: "s1", accountId: CONTA, token: "t", tokenExpiresAt: null });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 190, message: "expired" } }), { status: 400 }),
    );
    expect(await metaSocialAdapter.checkHealth!({ organizationId: "org-1", sessionRef: CONTA })).toEqual({
      reachable: true,
      status: "FAILED",
      detail: "token_invalido_reconecte",
    });

    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const caido = await metaSocialAdapter.checkHealth!({ organizationId: "org-1", sessionRef: CONTA });
    expect(caido.reachable).toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ user_id: CONTA }), { status: 200 }));
    expect((await metaSocialAdapter.checkHealth!({ organizationId: "org-1", sessionRef: CONTA })).status).toBe(
      "WORKING",
    );
  });
});
