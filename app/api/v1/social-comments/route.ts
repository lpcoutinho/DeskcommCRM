/**
 * GET /api/v1/social-comments — os comentários recebidos nas publicações das
 * contas sociais conectadas, mais novos primeiro.
 *
 * Leitura pelo client de SESSÃO: a RLS da 0742 entrega só os da organização de
 * quem pede. `?antes=<ISO>` pagina para trás pela hora do comentário.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const POR_PAGINA = 50;

const COLUNAS =
  "id, channel_session_id, network, external_id, media_external_id, media_product_type, parent_external_id, author_username, body, commented_at, public_replied_at, private_reply_status, private_replied_at, private_reply_error";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "social_comments" });
  if (!authz.ok) return authz.response;

  const antes = z.string().datetime({ offset: true }).safeParse(req.nextUrl.searchParams.get("antes"));
  const supabase = await createClient();
  let q = supabase
    .from("social_comments")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("commented_at", { ascending: false })
    .limit(POR_PAGINA + 1);
  if (antes.success) q = q.lt("commented_at", antes.data);
  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = data ?? [];
  return ok(linhas.slice(0, POR_PAGINA), {
    requestId,
    meta: { has_more: linhas.length > POR_PAGINA },
  });
}
