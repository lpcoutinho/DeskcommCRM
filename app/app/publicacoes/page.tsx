import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { Publicacoes } from "./_client";

export const dynamic = "force-dynamic";

/**
 * PUBLICAÇÕES — módulo opcional (ADR-0002): agendar e publicar posts nas contas
 * conectadas que publicam conteúdo (hoje, o Instagram pela API da Meta).
 *
 * Sem o módulo instalado a tela não existe (404), como a porta do menu.
 * `viewer` lê a agenda; criar, agendar, cancelar e apagar exige `manager`+ —
 * publicar fala pela marca em público. A RLS da 0722 tem a mesma régua.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!(await moduloLigado(createAdminClient(), "publicacoes"))) notFound();

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Publicações")}</h1>
        <p className="text-sm text-text-muted">
          {t("Agende posts para o Instagram conectado e acompanhe o que saiu e o que falhou.")}
        </p>
      </div>
      <Publicacoes podeGerenciar={ROLE_RANK[org.role] >= ROLE_RANK.manager} />
    </div>
  );
}
