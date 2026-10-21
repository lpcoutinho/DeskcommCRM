import { afterEach, describe, expect, it, vi } from "vitest";

import { assinarWebhooksDaConta, validarConta } from "./conta";

function meta(resposta: unknown, status = 200) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      chamadas.push(String(url));
      return new Response(JSON.stringify(resposta), { status });
    }),
  );
  return chamadas;
}

describe("a conta da página do Facebook", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("token da página: valida em graph.facebook.com e devolve o id da página", async () => {
    const chamadas = meta({ id: "101000000000001", name: "Loja", category: "Varejo" });
    expect(await validarConta("EAApagina-com-mais-de-20", "facebook")).toEqual({
      ok: true,
      accountId: "101000000000001",
      username: null,
      nome: "Loja",
      tipoDeConta: "PAGE",
    });
    expect(chamadas[0]).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/me\?fields=id%2Cname%2Ccategory$/);
  });

  it("⭐ token de USUÁRIO é recusado com a frase certa (não conecta e fica mudo)", async () => {
    meta({ error: { code: 100, message: "Tried accessing nonexisting field (category)" } }, 400);
    expect(await validarConta("EAAusuario-com-mais-de-20", "facebook")).toEqual({
      ok: false,
      motivo: "Use o token da PÁGINA, não o token de usuário.",
    });
  });

  it("a página assina os campos do Messenger e o feed (comentários)", async () => {
    const chamadas = meta({ success: true });
    await assinarWebhooksDaConta("EAApagina", "facebook");
    const url = new URL(chamadas[0]!);
    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.searchParams.get("subscribed_fields")).toBe(
      "messages,message_echoes,message_reads,messaging_referrals,feed",
    );
  });
});
