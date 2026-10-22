import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const credencial = vi.fn();
vi.mock("./session", () => ({ credencialInstagram: (...a: unknown[]) => credencial(...a) }));

import { responderComentarioNoInstagram, responderComentarioNoPrivadoDoInstagram } from "./comentarios";

const CONTA = "17841400000000001";
const entrada = { organizationId: "org-1", sessionRef: CONTA, commentExternalId: "17865799348089039", texto: " Te chamei! " };

function meta(resposta: unknown, status = 200) {
  const chamadas: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      chamadas.push({ url: String(url), init });
      return new Response(JSON.stringify(resposta), { status });
    }),
  );
  return chamadas;
}

describe("responder comentário pela Graph do Instagram", () => {
  beforeEach(() => credencial.mockResolvedValue({ channelSessionId: "s1", accountId: CONTA, token: "IGAAt", tokenExpiresAt: null }));
  afterEach(() => {
    vi.unstubAllGlobals();
    credencial.mockReset();
  });

  it("em público: POST /<comentário>/replies com o texto, token no header", async () => {
    const chamadas = meta({ id: "resp-1" });
    expect(await responderComentarioNoInstagram(entrada)).toEqual({ externalId: "resp-1" });
    const [c] = chamadas;
    expect(new URL(c!.url).pathname).toMatch(/\/17865799348089039\/replies$/);
    expect(c!.init?.method).toBe("POST");
    expect(JSON.parse(String(c!.init?.body))).toEqual({ message: "Te chamei!" });
    expect(new Headers(c!.init?.headers).get("authorization")).toBe("Bearer IGAAt");
    expect(c!.url).not.toContain("IGAAt");
  });

  it("no privado: recipient.comment_id, e o id volta no formato do external_id do eco", async () => {
    const chamadas = meta({ recipient_id: "9876543210123456", message_id: "mid-1" });
    expect(await responderComentarioNoPrivadoDoInstagram(entrada)).toEqual({
      externalId: `social:${CONTA}:mid-1`,
      participantId: "9876543210123456",
    });
    expect(new URL(chamadas[0]!.url).pathname).toMatch(/\/me\/messages$/);
    expect(JSON.parse(String(chamadas[0]!.init?.body))).toEqual({
      recipient: { comment_id: "17865799348089039" },
      message: { text: "Te chamei!" },
    });
  });

  it("resposta sem message_id é falha (o eco não seria reconhecido); conta sem credencial também", async () => {
    meta({ recipient_id: "9876543210123456" });
    await expect(responderComentarioNoPrivadoDoInstagram(entrada)).rejects.toThrow(/id da mensagem/);
    credencial.mockResolvedValueOnce(null);
    await expect(responderComentarioNoInstagram(entrada)).rejects.toThrow(/reconecte/);
  });

  it("texto vazio não chama a rede", async () => {
    const chamadas = meta({ id: "x" });
    await expect(responderComentarioNoInstagram({ ...entrada, texto: "   " })).rejects.toThrow(/vazia/);
    expect(chamadas).toHaveLength(0);
  });

  it("na página do Facebook a resposta pública é /<comentário>/comments, em graph.facebook.com", async () => {
    credencial.mockResolvedValue({ channelSessionId: "s2", accountId: "101", token: "EAAp", tokenExpiresAt: null, rede: "facebook" });
    const chamadas = meta({ id: "resp-fb" });
    expect(await responderComentarioNoInstagram({ ...entrada, sessionRef: "101", commentExternalId: "101_9_1" })).toEqual({
      externalId: "resp-fb",
    });
    const u = new URL(chamadas[0]!.url);
    expect(u.hostname).toBe("graph.facebook.com");
    expect(u.pathname).toMatch(/\/101_9_1\/comments$/);
  });
});
