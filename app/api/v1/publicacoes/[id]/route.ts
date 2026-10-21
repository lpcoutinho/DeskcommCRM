/**
 * PATCH  /api/v1/publicacoes/[id] — edita o post (substitui conta, formato,
 *        legenda, mídias e hora) ou cancela (`{ "acao": "cancelar" }`).
 * DELETE /api/v1/publicacoes/[id] — apaga o post que ainda não saiu.
 *
 * Reagendar um post que FALHOU é editar com hora: a tentativa recomeça do zero
 * (contador, container e erro limpos), porque a pessoa mudou algo — ou decidiu
 * tentar de novo depois de conferir o perfil.
 *
 * Post publicado ou publicando não é editável nem apagável: a RLS da 0722
 * recusa, e a rota responde 409 com a frase em vez de "0 linhas".
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { contasQuePublicam } from "@/lib/channels/publicadoras";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { traduzir } from "@/lib/i18n/dicionario";
import { postSchema } from "@/lib/publicacoes/esquema";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const cancelarSchema = z.object({ acao: z.literal("cancelar") });

async function preparar(req: NextRequest, ctx: { params: Promise<{ id: string }> }, requestId: string) {
  const authz = await requireRole("manager", { requestId, resource: "publicacoes" });
  if (!authz.ok) return { ok: false, resposta: authz.response as Response } as const;
  if (!(await moduloLigado(createAdminClient(), "publicacoes"))) {
    return { ok: false, resposta: fail("not_found", "not found", 404, { requestId }) } as const;
  }
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return { ok: false, resposta: fail("not_found", "not found", 404, { requestId }) } as const;
  }
  return { ok: true, authz, id } as const;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  // Guarda de efeito ANTES de tudo, no corpo do handler (o gate de cobertura lê aqui).
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const p = await preparar(req, ctx, requestId);
  if (!p.ok) return p.resposta;
  const { authz, id } = p;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const json = await req.json().catch(() => null);
  const cancelar = cancelarSchema.safeParse(json);
  let campos: Record<string, unknown>;
  if (cancelar.success) {
    campos = { status: "cancelado" };
  } else {
    const parsed = postSchema.safeParse(json);
    if (!parsed.success) {
      return fail("validation_error", parsed.error.issues[0]?.message ?? t("Confira o post antes de salvar."), 422, {
        requestId,
      });
    }
    const corpo = parsed.data;
    if (corpo.midias.some((m) => !m.caminho.startsWith(`${orgId}/`))) {
      return fail("validation_error", t("Uma das mídias não pertence a esta empresa."), 422, { requestId });
    }
    const contas = await contasQuePublicam(createAdminClient(), orgId);
      const daConta = contas.find((c) => c.id === corpo.channel_session_id);
    if (!daConta) {
      return fail("validation_error", t("Escolha uma conta conectada que publique conteúdo."), 422, { requestId });
    }
    if (!daConta.formatos.includes(corpo.formato)) {
      return fail("validation_error", t("Esta conta não publica neste formato."), 422, { requestId });
    }
    campos = {
      channel_session_id: corpo.channel_session_id,
      formato: corpo.formato,
      legenda: corpo.legenda,
      midias: corpo.midias,
      status: corpo.agendar_para ? "agendado" : "rascunho",
      agendado_para: corpo.agendar_para ?? null,
      // Editar recomeça a tentativa: a pessoa mudou algo (ou decidiu repetir).
      tentativas: 0,
      id_container: null,
      ultimo_erro: null,
      proxima_tentativa_em: null,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("publicacoes_posts")
    .update({ ...campos, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", id)
    .select("id, status")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) {
    return fail("state_conflict", t("Este post já saiu (ou está saindo) e não pode mais ser alterado."), 409, {
      requestId,
    });
  }
  void audit({
    action: "publicacao.alterada",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "publicacoes_posts",
    resourceId: id,
    requestId,
    metadata: { status: (data as { status: string }).status },
  });
  return ok(data, { requestId });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  // Guarda de efeito ANTES de tudo, no corpo do handler (o gate de cobertura lê aqui).
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const p = await preparar(req, ctx, requestId);
  if (!p.ok) return p.resposta;
  const { authz, id } = p;
  const orgId = authz.org.orgId;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("publicacoes_posts")
    .delete()
    .eq("organization_id", orgId)
    .eq("id", id)
    .select("id");
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data || data.length === 0) {
    return fail(
      "state_conflict",
      traduzir("Este post já saiu (ou está saindo) e não pode ser apagado.", authz.user.idioma),
      409,
      { requestId },
    );
  }
  void audit({
    action: "publicacao.removida",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "publicacoes_posts",
    resourceId: id,
    requestId,
  });
  return ok({ id }, { requestId });
}
