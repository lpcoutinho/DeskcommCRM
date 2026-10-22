/**
 * POST /api/v1/publicacoes/midias — sobe UMA imagem ou vídeo para o bucket
 * privado `publicacoes` e devolve o caminho que o post vai referenciar.
 *
 * O caminho é `<organização da sessão>/<uuid>.<ext>`: quem escolhe a pasta é o
 * servidor, nunca o corpo. As rotas do post e a fila conferem esse prefixo de
 * novo antes de usar a mídia.
 *
 * O bucket não tem policy: só o servidor lê e escreve. A rede recebe URL
 * assinada e temporária na hora de publicar; a tela recebe uma prévia assinada.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  BUCKET_DE_PUBLICACOES,
  extensaoDoMime,
  MIMES_ACEITOS,
  TAMANHO_MAXIMO_BYTES,
} from "@/lib/publicacoes/esquema";
import { garantirBucketDePublicacoes } from "@/lib/publicacoes/armazenamento";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("manager", { requestId, resource: "publicacoes" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "publicacoes"))) {
    return fail("not_found", "not found", 404, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const arquivo = form?.get("arquivo");
  if (!(arquivo instanceof File)) {
    return fail("validation_error", t("Escolha uma imagem ou um vídeo."), 422, { requestId });
  }
  const mime = MIMES_ACEITOS.find((m) => m === arquivo.type);
  if (!mime) {
    return fail("validation_error", t("Use JPG ou PNG para imagem, e MP4 ou MOV para vídeo."), 422, { requestId });
  }
  if (arquivo.size === 0 || arquivo.size > TAMANHO_MAXIMO_BYTES) {
    return fail("validation_error", t("O arquivo precisa ter até 100 MB."), 422, { requestId });
  }

  try {
    await garantirBucketDePublicacoes(admin);
  } catch (e) {
    return fail("internal_error", e instanceof Error ? e.message : "bucket indisponível", 500, { requestId });
  }

  const caminho = `${authz.org.orgId}/${randomUUID()}.${extensaoDoMime(mime)}`;
  const { error } = await admin.storage
    .from(BUCKET_DE_PUBLICACOES)
    .upload(caminho, Buffer.from(await arquivo.arrayBuffer()), { contentType: mime, upsert: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const { data: previa } = await admin.storage.from(BUCKET_DE_PUBLICACOES).createSignedUrl(caminho, 600);
  return ok({ caminho, mime, previa_url: previa?.signedUrl ?? null }, { requestId, status: 201 });
}
