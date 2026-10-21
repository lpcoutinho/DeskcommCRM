import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import {
  CHANNEL_PROVIDER_META_SOCIAL,
  capabilitiesOf,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { channelBrand } from "@/lib/channels/presentation";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

/**
 * O canal de Instagram nativo (provider `meta_social`) — vocabulário e costuras
 * do seam. Fixa o perfil, o `sessionRef`, o adapter e o par migration × baseline,
 * os artefatos que andam juntos.
 */
const PROVIDER = "meta_social" as const;
const MIGRATION = "supabase/migrations/20261022140000_0717_instagram_nativo.sql";

describe("canal Instagram nativo — vocabulário e seam", () => {
  it("é rede social: janela de 24h, sem modelos, sem banimento por volume, sem grupos", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_META_SOCIAL);
    expect(caps.freeformOutsideWindow).toBe(false);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.groups).toBe("none");
    expect(fonteDeTemplates(PROVIDER)).toBeNull();
  });

  it("é canal de MENSAGEM e aparece como a rede, nunca como o transporte", () => {
    expect(transportaMensagem(PROVIDER)).toBe(true);
    expect(channelBrand({ provider: PROVIDER, social_platform: "instagram" })).toBe("instagram");
    expect(channelBrand({ provider: PROVIDER, social_platform: "facebook" })).toBe("messenger");
  });

  it("o sessionRef é a conta, pela coluna própria, e ela entra no select", () => {
    expect(resolveSessionRef({ provider: PROVIDER, meta_social_account_id: "178414" })).toBe("178414");
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("meta_social_account_id");
  });

  it("o adapter existe e os códigos de falha carregam o nome", () => {
    const adapter = getAdapter(PROVIDER);
    expect(adapter.provider).toBe(PROVIDER);
    expect(adapter.codes.notConfigured).toBe("meta_social_not_configured");
    expect(adapter.isConfigured()).toBe(true);
  });

  it("migration e baseline conhecem o provider, o ramo do CHECK e o arquivo do webhook", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,800}'meta_social'::text/);
    expect(baseline).toMatch(/provider = 'meta_social' and meta_social_account_id is not null/);
    expect(baseline).toMatch(/webhook_events_log_provider_check check \(provider in \([\s\S]{0,400}'meta_social'/);
    expect(baseline).toContain("channel_sessions_meta_social_account_id_ativo_unique");
    // Colunas ANTES do CHECK que as referencia — senão o install quebra.
    expect(baseline.indexOf("add column if not exists meta_social_account_id")).toBeLessThan(
      baseline.indexOf("(provider = 'meta_social'"),
    );

    const mig = readFileSync(MIGRATION, "utf8");
    expect(mig).toMatch(/^-- manifest: /);
    expect(mig).toContain("add column if not exists meta_social_account_id");
    expect(mig).toMatch(/provider = 'meta_social' and meta_social_account_id is not null/);
    // O vocabulário do arquivo do webhook não perde os valores que já tinha.
    expect(mig).toMatch(/'stripe', 'asaas',\s+'meta_social'/);
  });

  it("o token é renovado por uma rodada diária agendada", () => {
    const agenda = readFileSync("docker/scheduler/entrypoint.sh", "utf8");
    expect(agenda).toMatch(/^41 4 \* \* \*\|60\|api\/v1\/cron\/instagram-token$/m);
  });
});
