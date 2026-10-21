import { describe, expect, it } from "vitest";

import { conferirFormato, postSchema, type Midia } from "./esquema";

const ORG = "11111111-1111-4111-8111-111111111111";
const img = (n: number): Midia => ({ caminho: `${ORG}/0000000${n}-0000-4000-8000-000000000000.jpg`, mime: "image/jpeg" });
const vid = (n: number): Midia => ({ caminho: `${ORG}/0000000${n}-0000-4000-8000-000000000000.mp4`, mime: "video/mp4" });

describe("conferirFormato — o formato combina com a mídia", () => {
  it("imagem leva uma imagem; reels e vídeo, um vídeo; story, uma de qualquer", () => {
    expect(conferirFormato("imagem", [img(1)])).toBeNull();
    expect(conferirFormato("imagem", [vid(1)])).toBe("imagem_uma");
    expect(conferirFormato("imagem", [img(1), img(2)])).toBe("imagem_uma");
    expect(conferirFormato("reel", [vid(1)])).toBeNull();
    expect(conferirFormato("video", [img(1)])).toBe("video_um");
    expect(conferirFormato("story", [vid(1)])).toBeNull();
    expect(conferirFormato("story", [img(1), img(2)])).toBe("story_um");
  });

  it("carrossel leva de 2 a 10, misturando imagem e vídeo", () => {
    expect(conferirFormato("carrossel", [img(1)])).toBe("carrossel_varias");
    expect(conferirFormato("carrossel", [img(1), vid(2)])).toBeNull();
    expect(conferirFormato("carrossel", Array.from({ length: 11 }, (_, i) => img(i % 10)))).toBe("midias_demais");
    expect(conferirFormato("carrossel", [])).toBe("sem_midia");
  });
});

describe("postSchema — o corpo da rota", () => {
  const base = {
    channel_session_id: "22222222-2222-4222-8222-222222222222",
    formato: "imagem",
    legenda: "Promoção de outubro",
    midias: [img(1)],
  };

  it("aceita rascunho (sem hora) e agendamento com fuso", () => {
    expect(postSchema.safeParse(base).success).toBe(true);
    expect(postSchema.safeParse({ ...base, agendar_para: "2026-10-22T13:00:00-03:00" }).success).toBe(true);
  });

  it("recusa caminho fora do formato da rota de upload (o corpo não escolhe a pasta)", () => {
    for (const caminho of ["../outra-org/a.jpg", `${ORG}/a.jpg`, `${ORG}/x/../y.jpg`, "a.jpg"]) {
      expect(postSchema.safeParse({ ...base, midias: [{ caminho, mime: "image/jpeg" }] }).success, caminho).toBe(false);
    }
  });

  it("recusa legenda acima do limite da Meta e devolve a frase do problema de formato", () => {
    expect(postSchema.safeParse({ ...base, legenda: "x".repeat(2201) }).success).toBe(false);
    const r = postSchema.safeParse({ ...base, formato: "carrossel" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("Carrossel leva de 2 a 10 mídias.");
  });
});
