/**
 * GET  /api/v1/publicacoes — os posts da organização (mais novos primeiro) e as
 *                            contas que publicam.
 * POST /api/v1/publicacoes — cria um post: rascunho, ou agendado se vier hora.
 *
 * Módulo opcional (ADR-0002): sem o módulo instalado as rotas respondem 404
 * (`moduloLigado`), e a tabela nem existe.
 *
 * ⚠️ CLIENT DE SESSÃO para a tabela: a RLS por operação (0741) já exige
 * `manager` para escrever e proíbe a sessão de escrever `publicando`/`publicado`.
 * A rota cobra o mesmo degrau por clareza de mensagem, não como segunda régua.
 * O client de serviço entra só para assinar a prévia da mídia (bucket sem policy)
 * e para listar as contas — sempre com a organização da sessão.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { contasQuePublicam } from "@/lib/channels/publicadoras";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { traduzir } from "@/lib/i18n/dicionario";
import { BUCKET_DE_PUBLICACOES, midiaSchema, postSchema, STATUS_DO_POST } from "@/lib/publicacoes/esquema";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /api/v1/publicacoes";
const COLUNAS =
  "id, channel_session_id, formato, legenda, midias, status, agendado_para, tentativas, ultimo_erro, link_publico, publicado_em, created_at, updated_at";

/** Prévia assinada (10 min) da PRIMEIRA mídia de cada post — o que a lista mostra. */
async function previas(orgId: string, posts: { id: string; midias: unknown }[]): Promise<Record<string, string>> {
  const caminhos: { id: string; caminho: string }[] = [];
  for (const p of posts) {
    const m = midiaSchema.array().safeParse(p.midias);
    const primeira = m.success ? m.data[0] : undefined;
    if (primeira && primeira.caminho.startsWith(`${orgId}/`)) caminhos.push({ id: p.id, caminho: primeira.caminho });
  }
  if (caminhos.length === 0) return {};
  const { data } = await createAdminClient()
    .storage.from(BUCKET_DE_PUBLICACOES)
    .createSignedUrls(
      caminhos.map((c) => c.caminho),
      600,
    );
  const porCaminho = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
  return Object.fromEntries(
    caminhos.flatMap((c) => {
      const url = porCaminho.get(c.caminho);
      return url ? [[c.id, url]] : [];
    }),
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "publicacoes" });
  if (!authz.ok) return authz.response;
  if (!(await moduloLigado(createAdminClient(), "publicacoes"))) {
    return fail("not_found", "not found", 404, { requestId });
  }

  const status = req.nextUrl.searchParams.get("status");
  const supabase = await createClient();
  let q = supabase.from("publicacoes_posts").select(COLUNAS).order("created_at", { ascending: false }).limit(100);
  if (status && (STATUS_DO_POST as readonly string[]).includes(status)) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const posts = (data ?? []) as { id: string; midias: unknown }[];
  const [urls, contas] = await Promise.all([
    previas(authz.org.orgId, posts),
    contasQuePublicam(createAdminClient(), authz.org.orgId),
  ]);
  return ok(
    { posts: posts.map((p) => ({ ...p, previa_url: urls[p.id] ?? null })), contas },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  // Publicar fala pela marca em público: `manager`, como a RLS.
  const authz = await requireRole("manager", { requestId, resource: "publicacoes" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  if (!(await moduloLigado(createAdminClient(), "publicacoes"))) {
    return fail("not_found", "not found", 404, { requestId });
  }

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !/^[0-9a-f-]{36}$/i.test(chave)) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const primeira = parsed.error.issues[0]?.message;
    return fail("validation_error", primeira ?? t("Confira o post antes de salvar."), 422, { requestId });
  }
  const corpo = parsed.data;
  // A mídia tem de ser DESTA organização: o caminho nasce na rota de upload com
  // a organização da sessão, e aqui ela é conferida de novo — o corpo não escolhe.
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

  const supabase = await createClient();
  const criar = async () => {
    const { data, error } = await supabase
      .from("publicacoes_posts")
      .insert({
        organization_id: orgId,
        channel_session_id: corpo.channel_session_id,
        formato: corpo.formato,
        legenda: corpo.legenda,
        midias: corpo.midias,
        status: corpo.agendar_para ? "agendado" : "rascunho",
        agendado_para: corpo.agendar_para ?? null,
        criado_por: authz.user.id,
      })
      .select(COLUNAS)
      .single();
    if (error) throw new Error(error.message);
    void audit({
      action: "publicacao.criada",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "publicacoes_posts",
      resourceId: (data as { id: string }).id,
      requestId,
      metadata: { formato: corpo.formato, agendado: Boolean(corpo.agendar_para) },
    });
    return data;
  };

  try {
    if (chave === null) return ok(await criar(), { requestId, status: 201 });
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: orgId,
      endpoint: ENDPOINT,
      chave,
      corpo,
      executar: async () => ({ resposta: await criar(), status: 201 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", "Esta chave de idempotência já foi usada com outro conteúdo.", 409, {
        requestId,
      });
    }
    if (desfecho.tipo === "em_curso") {
      return fail("idempotency_in_progress", "O mesmo post ainda está sendo criado. Tente de novo em instantes.", 409, {
        requestId,
      });
    }
    // O recibo guarda 201 (criação); replay devolve o mesmo status.
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch (e) {
    return fail("internal_error", e instanceof Error ? e.message : "falha ao criar", 500, { requestId });
  }
}
