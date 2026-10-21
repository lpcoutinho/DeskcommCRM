import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const credencial = vi.fn();
vi.mock("./session", () => ({ credencialInstagram: (...a: unknown[]) => credencial(...a) }));

import { ErroDePublicacao } from "../publicacao";
import type { PublicacaoInput } from "../types";
import { publicarNoInstagram } from "./publicacao";

const CONTA = "17841400000000001";
const semEspera = async () => {};

function entrada(extra: Partial<PublicacaoInput> = {}): PublicacaoInput {
  return {
    organizationId: "org-1",
    sessionRef: CONTA,
    formato: "imagem",
    legenda: "Promoção",
    midias: [{ url: "https://x.supabase.co/storage/v1/object/sign/publicacoes/a.jpg?token=t", tipo: "imagem" }],
    containerId: null,
    ...extra,
  };
}

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

/** A Meta "de mentira": responde por caminho e método, e guarda cada chamada. */
function meta(rotas: Record<string, (corpo: Record<string, unknown> | null) => Response>) {
  const chamadas: { metodo: string; caminho: string; corpo: Record<string, unknown> | null }[] = [];
  const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    const caminho = u.pathname.replace(/^\/v\d+\.\d+\//, "");
    const metodo = init?.method ?? "GET";
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    chamadas.push({ metodo, caminho, corpo });
    const resp = rotas[`${metodo} ${caminho}`];
    if (!resp) throw new Error(`rota inesperada: ${metodo} ${caminho}`);
    return resp(corpo);
  });
  vi.stubGlobal("fetch", fetchMock);
  return chamadas;
}

const COTA_LIVRE = {
  [`GET ${CONTA}/content_publishing_limit`]: () => json({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] }),
};

describe("publicarNoInstagram", () => {
  beforeEach(() => credencial.mockResolvedValue({ channelSessionId: "s1", accountId: CONTA, token: "IGAAt", tokenExpiresAt: null }));
  afterEach(() => {
    vi.unstubAllGlobals();
    credencial.mockReset();
  });

  it("imagem: container → pronto → publica → link, com a legenda no container", async () => {
    const chamadas = meta({
      ...COTA_LIVRE,
      [`POST ${CONTA}/media`]: () => json({ id: "c1" }),
      "GET c1": () => json({ status_code: "FINISHED" }),
      [`POST ${CONTA}/media_publish`]: () => json({ id: "m1" }),
      "GET m1": () => json({ permalink: "https://www.instagram.com/p/abc/" }),
    });
    const r = await publicarNoInstagram(entrada(), semEspera);
    expect(r).toEqual({ estado: "publicado", idExterno: "m1", link: "https://www.instagram.com/p/abc/" });
    expect(chamadas.find((c) => c.caminho === `${CONTA}/media`)?.corpo).toEqual({
      image_url: entrada().midias[0]!.url,
      caption: "Promoção",
    });
    expect(chamadas.find((c) => c.caminho === `${CONTA}/media_publish`)?.corpo).toEqual({ creation_id: "c1" });
  });

  it("vídeo ainda processando devolve o container — e a rodada seguinte RETOMA sem montar outro", async () => {
    let pronto = false;
    const chamadas = meta({
      ...COTA_LIVRE,
      [`POST ${CONTA}/media`]: () => json({ id: "c2" }),
      "GET c2": () => json({ status_code: pronto ? "FINISHED" : "IN_PROGRESS" }),
      [`POST ${CONTA}/media_publish`]: () => json({ id: "m2" }),
      "GET m2": () => json({ permalink: null }),
    });
    const reel = entrada({ formato: "reel", midias: [{ url: "https://x/v.mp4", tipo: "video" }] });
    expect(await publicarNoInstagram(reel, semEspera)).toEqual({ estado: "processando", containerId: "c2" });
    expect(chamadas.filter((c) => c.caminho === `${CONTA}/media_publish`)).toHaveLength(0);

    pronto = true;
    const r = await publicarNoInstagram({ ...reel, containerId: "c2" }, semEspera);
    expect(r).toMatchObject({ estado: "publicado", idExterno: "m2" });
    // Um container só, nas duas rodadas.
    expect(chamadas.filter((c) => c.metodo === "POST" && c.caminho === `${CONTA}/media`)).toHaveLength(1);
    expect(chamadas.find((c) => c.caminho === `${CONTA}/media`)?.corpo).toMatchObject({ media_type: "REELS" });
  });

  it("carrossel monta um filho por mídia e o pai com os filhos", async () => {
    let n = 0;
    const chamadas = meta({
      ...COTA_LIVRE,
      [`POST ${CONTA}/media`]: (corpo) => json({ id: corpo?.media_type === "CAROUSEL" ? "pai" : `f${++n}` }),
      "GET f1": () => json({ status_code: "FINISHED" }),
      "GET f2": () => json({ status_code: "FINISHED" }),
      "GET pai": () => json({ status_code: "FINISHED" }),
      [`POST ${CONTA}/media_publish`]: () => json({ id: "m3" }),
      "GET m3": () => json({}),
    });
    await publicarNoInstagram(
      entrada({ formato: "carrossel", midias: [{ url: "https://x/1.jpg", tipo: "imagem" }, { url: "https://x/2.mp4", tipo: "video" }] }),
      semEspera,
    );
    const pai = chamadas.find((c) => c.corpo?.media_type === "CAROUSEL");
    expect(pai?.corpo).toMatchObject({ children: "f1,f2", caption: "Promoção" });
    expect(chamadas.filter((c) => c.corpo?.is_carousel_item === true)).toHaveLength(2);
  });

  it("mídia que a Meta não processa é DEFINITIVA; limite diário é PASSAGEIRO", async () => {
    meta({
      ...COTA_LIVRE,
      [`POST ${CONTA}/media`]: () => json({ id: "c4" }),
      "GET c4": () => json({ status_code: "ERROR" }),
    });
    const ruim = await publicarNoInstagram(entrada(), semEspera).catch((e) => e);
    expect(ruim).toBeInstanceOf(ErroDePublicacao);
    expect(ruim.definitivo).toBe(true);

    meta({ [`GET ${CONTA}/content_publishing_limit`]: () => json({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] }) });
    const cheio = await publicarNoInstagram(entrada(), semEspera).catch((e) => e);
    expect(cheio).toBeInstanceOf(ErroDePublicacao);
    expect(cheio.definitivo).toBe(false);
  });

  it("falha DEPOIS de montar o container devolve o id para retomar (nunca montar outro)", async () => {
    meta({
      ...COTA_LIVRE,
      [`POST ${CONTA}/media`]: () => json({ id: "c5" }),
      "GET c5": () => json({ status_code: "FINISHED" }),
      [`POST ${CONTA}/media_publish`]: () => json({ error: { code: 2, message: "temporário" } }, 503),
    });
    const e = await publicarNoInstagram(entrada(), semEspera).catch((x) => x);
    expect(e).toBeInstanceOf(ErroDePublicacao);
    expect(e.definitivo).toBe(false);
    expect(e.containerId).toBe("c5");
  });

  it("container já PUBLICADO (resposta perdida antes) não publica de novo", async () => {
    const chamadas = meta({ "GET c6": () => json({ status_code: "PUBLISHED" }) });
    const e = await publicarNoInstagram(entrada({ containerId: "c6" }), semEspera).catch((x) => x);
    expect(e.definitivo).toBe(true);
    expect(chamadas.some((c) => c.caminho.endsWith("media_publish"))).toBe(false);
  });

  it("sem credencial, ou token morto: definitivo, pedindo para reconectar", async () => {
    credencial.mockResolvedValueOnce(null);
    expect((await publicarNoInstagram(entrada(), semEspera).catch((e) => e)).definitivo).toBe(true);

    meta({ [`GET ${CONTA}/content_publishing_limit`]: () => json({ error: { code: 190, message: "expired" } }, 400) });
    const morto = await publicarNoInstagram(entrada(), semEspera).catch((e) => e);
    expect(morto.definitivo).toBe(true);
    expect(morto.message).toMatch(/reconecte/);
  });
});
