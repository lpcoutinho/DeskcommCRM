import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { Comentarios } from "./_client";

export const dynamic = "force-dynamic";

/**
 * COMENTÁRIOS — o que as pessoas comentam nas publicações das contas sociais
 * conectadas (hoje, o Instagram pela API da Meta), e a resposta: em público ou
 * no privado, à mão ou por regra de automação.
 *
 * Todo papel lê; responder exige `agent`+ (é atender). Quem cria a regra
 * "comentou X → DM" é `manager`+, em Webhooks › Automações.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Comentários")}</h1>
        <p className="text-sm text-text-muted">
          {t("O que comentam nas publicações do Instagram e da página do Facebook conectados. Responda em público ou chame no privado.")}
        </p>
      </div>
      <Comentarios
        podeResponder={ROLE_RANK[org.role] >= ROLE_RANK.agent}
        podeAutomatizar={ROLE_RANK[org.role] >= ROLE_RANK.manager}
      />
    </div>
  );
}
