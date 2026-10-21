import { beforeEach, describe, expect, it, vi } from "vitest";

const publico = vi.fn();
const privado = vi.fn();
vi.mock("@/lib/channels", () => ({
  getAdapter: (provider: string) =>
    provider === "so_conversa"
      ? {}
      : { responderComentario: publico, responderComentarioNoPrivado: privado },
}));
// O ref da conta é detalhe do seam; aqui basta que ele chegue ao adapter.
vi.mock("@/lib/channels/session-ref", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider",
  resolveSessionRef: () => "ref-da-conta",
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { PRAZO_DA_RESPOSTA_PRIVADA_DIAS, responderComentario } from "./responder";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-10-21T12:00:00Z");

type Linha = Record<string, unknown>;

/**
 * Banco falso do tamanho do caminho: uma linha de comentário e uma sessão. O
 * UPDATE aplica os filtros de verdade (`is null`, `gte`), que é exatamente a
 * guarda que o teste precisa exercitar.
 */
function banco(comentario: Linha, sessao: Linha | null = { provider: "rede" }) {
  const linha: Linha = { ...comentario };
  const cadeia = (tabela: string) => {
    const filtros: ((l: Linha) => boolean)[] = [];
    let patch: Linha | null = null;
    const casa = () => filtros.every((f) => f(linha));
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (filtros.push((l) => tabela !== "social_comments" || l[c] === v), api),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), api),
      gte: (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), api),
      update: (p: Linha) => ((patch = p), api),
      maybeSingle: async () => ({
        data: tabela === "social_comments" ? (casa() ? { ...linha } : null) : sessao,
        error: null,
      }),
      then: (resolver: (v: { data: Linha[]; error: null }) => void) => {
        const afetadas = patch && casa() ? [{ id: linha.id }] : [];
        if (patch && afetadas.length) Object.assign(linha, patch);
        resolver({ data: afetadas, error: null });
      },
    };
    return api;
  };
  const admin = { from: (t: string) => cadeia(t) } as unknown as SupabaseClient;
  return { admin, linha };
}

const comentario = (extra: Linha = {}): Linha => ({
  id: ID,
  organization_id: ORG,
  channel_session_id: "33333333-3333-4333-8333-333333333333",
  external_id: "17865799348089039",
  commented_at: "2026-10-20T12:00:00.000Z",
  public_replied_at: null,
  private_reply_status: null,
  ...extra,
});

const pedido = (modo: "publico" | "privado") => ({ organizationId: ORG, commentId: ID, modo, texto: "Te chamei!", agora: AGORA });

describe("responderComentario", () => {
  beforeEach(() => {
    publico.mockReset();
    privado.mockReset();
  });

  it("em público: chama a rede com o id do comentário e guarda a resposta", async () => {
    publico.mockResolvedValue({ externalId: "resp-1" });
    const b = banco(comentario());
    expect(await responderComentario(b.admin, pedido("publico"))).toEqual({ estado: "respondido", externalId: "resp-1" });
    expect(publico).toHaveBeenCalledWith({
      organizationId: ORG,
      sessionRef: "ref-da-conta",
      commentExternalId: "17865799348089039",
      texto: "Te chamei!",
    });
    expect(b.linha.public_reply_external_id).toBe("resp-1");
    expect(b.linha.public_replied_at).toBe(AGORA.toISOString());
  });

  it("⭐ a SEGUNDA resposta pública não chama a rede", async () => {
    publico.mockResolvedValue({ externalId: "resp-1" });
    const b = banco(comentario());
    await responderComentario(b.admin, pedido("publico"));
    expect(await responderComentario(b.admin, pedido("publico"))).toEqual({
      estado: "nao_respondido",
      motivo: "ja_respondido",
    });
    expect(publico).toHaveBeenCalledTimes(1);
  });

  it("em público, a falha DEVOLVE a linha: a resposta não saiu e dá para responder de novo", async () => {
    publico.mockRejectedValueOnce(new Error("rede fora"));
    const b = banco(comentario());
    expect(await responderComentario(b.admin, pedido("publico"))).toEqual({ estado: "falhou", erro: "rede fora" });
    expect(b.linha.public_replied_at).toBeNull();
    publico.mockResolvedValue({ externalId: "resp-2" });
    expect((await responderComentario(b.admin, pedido("publico"))).estado).toBe("respondido");
  });

  it("⭐ no privado: UMA DM por comentário — a segunda não chama a rede", async () => {
    privado.mockResolvedValue({ externalId: "social:conta:mid-1", participantId: "p1" });
    const b = banco(comentario());
    expect((await responderComentario(b.admin, pedido("privado"))).estado).toBe("respondido");
    expect(b.linha).toMatchObject({ private_reply_status: "sent", private_reply_external_id: "social:conta:mid-1" });
    expect(await responderComentario(b.admin, pedido("privado"))).toEqual({
      estado: "nao_respondido",
      motivo: "ja_respondido_no_privado",
    });
    expect(privado).toHaveBeenCalledTimes(1);
  });

  it("⭐ no privado, a falha é TERMINAL: a chamada pode ter saído, e nunca sai uma segunda DM", async () => {
    privado.mockRejectedValueOnce(new Error("timeout depois de enviar"));
    const b = banco(comentario());
    expect((await responderComentario(b.admin, pedido("privado"))).estado).toBe("falhou");
    expect(b.linha).toMatchObject({ private_reply_status: "failed", private_reply_error: "timeout depois de enviar" });
    expect((await responderComentario(b.admin, pedido("privado"))).estado).toBe("nao_respondido");
    expect(privado).toHaveBeenCalledTimes(1);
  });

  it("⭐ no privado, comentário com mais de 7 dias é recusado ANTES da rede", async () => {
    const velho = new Date(AGORA.getTime() - (PRAZO_DA_RESPOSTA_PRIVADA_DIAS * 86_400_000 + 60_000)).toISOString();
    const b = banco(comentario({ commented_at: velho }));
    expect(await responderComentario(b.admin, pedido("privado"))).toEqual({
      estado: "nao_respondido",
      motivo: "prazo_da_resposta_privada_vencido",
    });
    expect(privado).not.toHaveBeenCalled();
    expect(b.linha.private_reply_status).toBeNull();
  });

  it("conexão removida ou canal que não responde comentário: não chama nada", async () => {
    expect(await responderComentario(banco(comentario(), null).admin, pedido("publico"))).toEqual({
      estado: "nao_respondido",
      motivo: "conexao_removida",
    });
    expect(
      await responderComentario(banco(comentario(), { provider: "so_conversa" }).admin, pedido("privado")),
    ).toEqual({ estado: "nao_respondido", motivo: "canal_sem_comentarios" });
    expect(publico).not.toHaveBeenCalled();
    expect(privado).not.toHaveBeenCalled();
  });
});
