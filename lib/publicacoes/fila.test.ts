import { beforeEach, describe, expect, it, vi } from "vitest";

const publicar = vi.fn();
vi.mock("@/lib/channels", () => ({
  getAdapter: (provider: string) => (provider === "so_conversa" ? {} : { publicarConteudo: publicar }),
}));
// O ref da conta é detalhe do seam; aqui basta que ele chegue ao adapter.
vi.mock("@/lib/channels/session-ref", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider",
  resolveSessionRef: () => "ref-da-conta",
}));
vi.mock("@/lib/organizacao/operante", () => ({ idsDeOrgsParadas: async () => ["org-parada"] }));
const auditado = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditado(e) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { ErroDePublicacao } from "@/lib/channels/publicacao";

import { esperaAntesDe, MAX_TENTATIVAS, rodadaDePublicacao } from "./fila";

const ORG = "11111111-1111-4111-8111-111111111111";
const POST = "33333333-3333-4333-8333-333333333333";
const CAMINHO = `${ORG}/44444444-4444-4444-8444-444444444444.jpg`;

/** Banco falso do tamanho da rodada: claim, leitura do post e da sessão, gravações. */
function banco(post: Record<string, unknown>, sessao: Record<string, unknown> | null) {
  const gravacoes: Record<string, unknown>[] = [];
  const avisos: Record<string, unknown>[] = [];
  const rpc = vi.fn(async () => ({ data: [{ post_id: POST, org_id: ORG }], error: null }));
  const cadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => ((filtros[c] = v), api),
      is: () => api,
      update: (p: Record<string, unknown>) => ((patch = p), api),
      insert: async (linha: Record<string, unknown>) => (avisos.push({ tabela, ...linha }), { error: null }),
      maybeSingle: async () => ({ data: tabela === "publicacoes_posts" ? post : sessao, error: null }),
      then: (resolver: (v: { error: null }) => void) => {
        if (patch) gravacoes.push({ tabela, filtros: { ...filtros }, ...patch });
        resolver({ error: null });
      },
    };
    return api;
  };
  const admin = {
    rpc,
    from: (t: string) => cadeia(t),
    storage: {
      from: () => ({
        createSignedUrl: async (c: string) => ({ data: { signedUrl: `https://x/sign/${c}` }, error: null }),
      }),
    },
  } as unknown as SupabaseClient;
  return { admin, gravacoes, avisos, rpc };
}

const linha = (extra: Record<string, unknown> = {}) => ({
  id: POST,
  organization_id: ORG,
  channel_session_id: "55555555-5555-4555-8555-555555555555",
  formato: "imagem",
  legenda: "Promoção",
  midias: [{ caminho: CAMINHO, mime: "image/jpeg" }],
  tentativas: 1,
  id_container: null,
  ...extra,
});
const SESSAO = { provider: "rede" };
const agora = new Date("2026-10-21T13:00:00Z");

describe("rodadaDePublicacao", () => {
  beforeEach(() => {
    publicar.mockReset();
    auditado.mockReset();
  });

  it("reivindica pulando organização parada e publica com a URL ASSINADA da mídia", async () => {
    publicar.mockResolvedValue({ estado: "publicado", idExterno: "m1", link: "https://instagram.com/p/x" });
    const b = banco(linha(), SESSAO);
    const r = await rodadaDePublicacao(b.admin, agora);
    expect(b.rpc).toHaveBeenCalledWith("fn_publicacoes_reivindicar", { p_limite: 2, p_pular: ["org-parada"] });
    expect(publicar.mock.calls[0]![0]).toMatchObject({
      organizationId: ORG,
      sessionRef: "ref-da-conta",
      formato: "imagem",
      midias: [{ url: `https://x/sign/${CAMINHO}`, tipo: "imagem" }],
      containerId: null,
    });
    expect(r).toEqual([{ organizationId: ORG, postId: POST, desfecho: "publicado" }]);
    // Toda gravação leva a organização junto com o id (cliente de serviço).
    expect(b.gravacoes[0]).toMatchObject({
      status: "publicado",
      id_externo: "m1",
      filtros: { organization_id: ORG, id: POST },
    });
    expect(auditado).toHaveBeenCalledWith(expect.objectContaining({ action: "publicacao.publicada" }));
  });

  it("processando volta para a fila com o container, em um minuto", async () => {
    publicar.mockResolvedValue({ estado: "processando", containerId: "c9" });
    const b = banco(linha(), SESSAO);
    expect((await rodadaDePublicacao(b.admin, agora))[0]!.desfecho).toBe("processando");
    expect(b.gravacoes[0]).toMatchObject({
      status: "agendado",
      id_container: "c9",
      proxima_tentativa_em: new Date(agora.getTime() + 60_000).toISOString(),
    });
  });

  it("erro passageiro reagenda com espera crescente e GUARDA o container já montado", async () => {
    publicar.mockRejectedValue(new ErroDePublicacao("rede fora", false, "c7"));
    const b = banco(linha({ tentativas: 2 }), SESSAO);
    expect((await rodadaDePublicacao(b.admin, agora))[0]!.desfecho).toBe("reagendado");
    expect(b.gravacoes[0]).toMatchObject({
      status: "agendado",
      id_container: "c7",
      proxima_tentativa_em: new Date(agora.getTime() + esperaAntesDe(2)).toISOString(),
    });
    expect(b.avisos).toHaveLength(0);
  });

  it("erro definitivo — ou passageiro no teto de tentativas — falha e AVISA na Central", async () => {
    publicar.mockRejectedValue(new ErroDePublicacao("mídia recusada", true));
    const b = banco(linha(), SESSAO);
    expect((await rodadaDePublicacao(b.admin, agora))[0]!.desfecho).toBe("falhou");
    expect(b.gravacoes[0]).toMatchObject({ status: "falhou", ultimo_erro: "mídia recusada" });
    expect(b.avisos[0]).toMatchObject({ tabela: "agent_inbox_items", kind: "publicacao_falhou", organization_id: ORG });

    publicar.mockRejectedValue(new ErroDePublicacao("rede fora", false));
    const noTeto = banco(linha({ tentativas: MAX_TENTATIVAS }), SESSAO);
    expect((await rodadaDePublicacao(noTeto.admin, agora))[0]!.desfecho).toBe("falhou");
  });

  it("conta que não publica, conta desconectada e mídia de OUTRA organização falham sem chamar a rede", async () => {
    const soConversa = banco(linha(), { ...SESSAO, provider: "so_conversa" });
    expect((await rodadaDePublicacao(soConversa.admin, agora))[0]!.desfecho).toBe("falhou");

    const desconectada = banco(linha(), null);
    expect((await rodadaDePublicacao(desconectada.admin, agora))[0]!.desfecho).toBe("falhou");

    const alheia = banco(
      linha({ midias: [{ caminho: `22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444.jpg`, mime: "image/jpeg" }] }),
      SESSAO,
    );
    expect((await rodadaDePublicacao(alheia.admin, agora))[0]!.desfecho).toBe("falhou");
    expect(publicar).not.toHaveBeenCalled();
  });

  it("a espera cresce em dobro e tem teto", () => {
    expect(esperaAntesDe(1)).toBe(2 * 60_000);
    expect(esperaAntesDe(3)).toBe(8 * 60_000);
    expect(esperaAntesDe(20)).toBe(60 * 60_000);
  });
});
