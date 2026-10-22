/**
 * POST /api/v1/social-comments/:id/responder — a pessoa responde um comentário
 * pela tela, em público ou no privado (a DM que nasce dele).
 *
 * O caminho é o MESMO da regra de automação (`lib/comentarios/responder.ts`):
 * uma resposta pública e uma DM por comentário, DM só até 7 dias depois. Quem
 * clica junto com a regra disputa a mesma linha, e só um chama a rede.
 *
 * `agent`+: responder comentário é atender. A escrita é do client de serviço
 * (a tabela não tem policy de escrita), com a organização da sessão.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { responderComentario, type MotivoDeNaoResponder } from "@/lib/comentarios/responder";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.discriminatedUnion("modo", [
  z.object({ modo: z.literal("publico"), texto: z.string().trim().min(1).max(2200) }),
  z.object({ modo: z.literal("privado"), texto: z.string().trim().min(1).max(1000) }),
]);

function fraseDoMotivo(motivo: MotivoDeNaoResponder, t: (texto: string) => string): string {
  switch (motivo) {
    case "comentario_inexistente":
      return t("Comentário não encontrado.");
    case "conexao_removida":
      return t("A conta em que o comentário chegou foi desconectada.");
    case "canal_sem_comentarios":
      return t("Esta conexão não responde comentários.");
    case "ja_respondido":
      return t("Este comentário já foi respondido em público.");
    case "ja_respondido_no_privado":
      return t("Este comentário já recebeu uma mensagem privada — a rede aceita só uma.");
    case "prazo_da_resposta_privada_vencido":
      return t("Passaram mais de 7 dias do comentário: a rede não aceita mais mensagem privada.");
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("agent", { requestId, resource: "social_comments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Comentário não encontrado."), 404, { requestId });
  }
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_error", t("Escreva a resposta."), 422, { requestId, details: corpo.error.flatten() });
  }

  let r;
  try {
    r = await responderComentario(createAdminClient(), {
      organizationId: authz.org.orgId,
      commentId: id,
      modo: corpo.data.modo,
      texto: corpo.data.texto,
    });
  } catch (e) {
    return fail("internal_error", e instanceof Error ? e.message : "erro", 500, { requestId });
  }

  if (r.estado === "nao_respondido") {
    const status = r.motivo === "comentario_inexistente" ? 404 : 409;
    return fail(r.motivo, fraseDoMotivo(r.motivo, t), status, { requestId });
  }
  if (r.estado === "falhou") {
    return fail("upstream_unavailable", r.erro, 502, { requestId });
  }

  void audit({
    action: "social_comment.replied",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "social_comment",
    resourceId: id,
    requestId,
    metadata: { modo: corpo.data.modo },
  });
  return ok({ external_id: r.externalId }, { requestId });
}
