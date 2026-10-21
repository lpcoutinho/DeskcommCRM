/**
 * Publicações nas redes — o esquema central do post (módulo `publicacoes`, ADR-0002).
 *
 * A coluna `midias` é jsonb, e jsonb sem esquema central é lock-in (anti-padrão
 * 6): a tela, a rota e a fila leem a MESMA forma daqui. O banco confere só a
 * casca (lista de 1 a 10); o conteúdo de cada item é este Zod.
 */
import { z } from "zod";

export const FORMATOS = ["imagem", "video", "carrossel", "reel", "story"] as const;
export type Formato = (typeof FORMATOS)[number];

export const STATUS_DO_POST = [
  "rascunho",
  "agendado",
  "publicando",
  "publicado",
  "falhou",
  "cancelado",
] as const;
export type StatusDoPost = (typeof STATUS_DO_POST)[number];

/** O teto da legenda na Meta. O banco tem o mesmo CHECK. */
export const LIMITE_DA_LEGENDA = 2200;

/** O que a Meta aceita e o bucket `publicacoes` guarda (mesma lista do bucket). */
export const MIMES_DE_IMAGEM = ["image/jpeg", "image/png"] as const;
export const MIMES_DE_VIDEO = ["video/mp4", "video/quicktime"] as const;
export const MIMES_ACEITOS = [...MIMES_DE_IMAGEM, ...MIMES_DE_VIDEO] as const;

/** 100 MB, o teto do bucket. Vídeo de reels raramente passa disso. */
export const TAMANHO_MAXIMO_BYTES = 104_857_600;

export const BUCKET_DE_PUBLICACOES = "publicacoes";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `<organização>/<arquivo>.<ext>` — o caminho que a rota de upload grava. */
const CAMINHO = new RegExp(`^${UUID}/${UUID}\\.(jpg|png|mp4|mov)$`);

export const midiaSchema = z.object({
  caminho: z.string().regex(CAMINHO),
  mime: z.enum(MIMES_ACEITOS),
});
export type Midia = z.infer<typeof midiaSchema>;

export function tipoDaMidia(mime: string): "imagem" | "video" {
  return (MIMES_DE_VIDEO as readonly string[]).includes(mime) ? "video" : "imagem";
}

/** A extensão do arquivo pelo mime (o caminho a carrega). */
export function extensaoDoMime(mime: (typeof MIMES_ACEITOS)[number]): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
  }
}

/** O que pode estar errado entre formato e mídia — código, não frase. */
export type ProblemaDeFormato =
  | "sem_midia"
  | "midias_demais"
  | "imagem_uma"
  | "video_um"
  | "story_um"
  | "carrossel_varias";

/**
 * A frase em português de cada problema — a que a ROTA devolve. A tela traduz
 * o CÓDIGO com um literal por ramo (`t()` não recebe variável: chave montada em
 * runtime não está em dicionário nenhum).
 */
export const FRASE_DO_PROBLEMA: Record<ProblemaDeFormato, string> = {
  sem_midia: "Escolha pelo menos uma imagem ou vídeo.",
  midias_demais: "Um post leva no máximo 10 mídias.",
  imagem_uma: "Post de imagem leva uma imagem só.",
  video_um: "Reels e vídeo levam um vídeo só.",
  story_um: "Story leva uma imagem ou um vídeo.",
  carrossel_varias: "Carrossel leva de 2 a 10 mídias.",
};

/** O formato combina com a mídia? `null` = combina. Pura: tela e rota conferem. */
export function conferirFormato(formato: Formato, midias: readonly Midia[]): ProblemaDeFormato | null {
  if (midias.length === 0) return "sem_midia";
  if (midias.length > 10) return "midias_demais";
  const tipos = midias.map((m) => tipoDaMidia(m.mime));
  switch (formato) {
    case "imagem":
      return midias.length === 1 && tipos[0] === "imagem" ? null : "imagem_uma";
    case "video":
    case "reel":
      return midias.length === 1 && tipos[0] === "video" ? null : "video_um";
    case "story":
      return midias.length === 1 ? null : "story_um";
    case "carrossel":
      return midias.length >= 2 ? null : "carrossel_varias";
  }
}

/** Corpo de criação e edição de post (rota). */
export const postSchema = z
  .object({
    channel_session_id: z.uuid(),
    formato: z.enum(FORMATOS),
    legenda: z.string().max(LIMITE_DA_LEGENDA).default(""),
    midias: z.array(midiaSchema).min(1).max(10),
    /** Ausente = rascunho. Presente = agendado para esta hora (passado = já). */
    agendar_para: z.iso.datetime({ offset: true }).nullish(),
  })
  .superRefine((v, ctx) => {
    const problema = conferirFormato(v.formato, v.midias);
    if (problema) ctx.addIssue({ code: "custom", message: FRASE_DO_PROBLEMA[problema], path: ["midias"] });
  });
export type PostEntrada = z.infer<typeof postSchema>;
