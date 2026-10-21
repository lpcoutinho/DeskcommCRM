import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { renovarTokensDoInstagram } from "@/lib/channels/meta-social/renovacao";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * instagram-token — renova o token das contas de Instagram conectadas antes de
 * ele vencer (60 dias). A regra de quem renova mora em
 * `lib/channels/meta-social/renovacao.ts`; aqui só a rodada e a auditoria.
 *
 * Audita só quando houve efeito (um token renovado ou uma falha), por
 * organização: rodada que não fez nada não é mutação
 * (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
 */
export const dynamic = "force-dynamic";

async function executar(req: NextRequest) {
  if (!autorizaCron(req))
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );

  let resultados;
  try {
    resultados = await renovarTokensDoInstagram(createAdminClient());
  } catch {
    return NextResponse.json(
      { error: { code: "internal_error", message: "Não foi possível ler as contas de Instagram." } },
      { status: 500 },
    );
  }

  const porOrganizacao = new Map<string, { renovados: number; falhas: number }>();
  for (const r of resultados) {
    if (r.desfecho === "cedo_demais") continue;
    const resumo = porOrganizacao.get(r.organizationId) ?? { renovados: 0, falhas: 0 };
    if (r.desfecho === "renovado") resumo.renovados++;
    else resumo.falhas++;
    porOrganizacao.set(r.organizationId, resumo);
  }
  for (const [organizationId, resumo] of porOrganizacao) {
    if (resumo.renovados > 0 || resumo.falhas > 0)
      await audit({
        action: "channel.token_refreshed",
        organizationId,
        metadata: { canal: "instagram", ...resumo },
      });
  }

  return NextResponse.json({
    data: { avaliadas: resultados.length, organizacoes: porOrganizacao.size },
  });
}

export const GET = executar;
export const POST = executar;
