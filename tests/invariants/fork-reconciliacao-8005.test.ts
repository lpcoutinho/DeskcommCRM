import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A MIGRATION 8005 RECONCILIA O FORK COM A v1.118.0 DO ORIGINAL.
 *
 * Depois da 8004, migrations do original recriaram objetos sem o que o fork
 * acrescentou, e nenhuma delas conflita no git: a 9240 (`emit_event`), a 9243
 * (`fn_lgpd_cascade_redact_contact`), a 9327/9333/9397 (`agent_inbox_items_kind_check`)
 * e a 9342/9418 (os CHECKs de provider). A suíte aplica só o baseline, então sem
 * este arquivo a 8005 nunca rodaria num banco antes de chegar a uma instalação.
 *
 * Aplicada DUAS vezes: a segunda passada é a prova de idempotência.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20261119120000_8005_reconcilia_fork_com_v1_118.sql",
  "utf8",
);

const fonteDe = (funcao: string) =>
  sql(`select prosrc from pg_proc where oid = 'public.${funcao}'::regproc;`);

const definicaoDe = (constraint: string) =>
  sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = '${constraint}';`);

describe("migration 8005 — reconciliação do fork com a v1.118.0", () => {
  beforeAll(() => {
    sql(MIGRATION);
    sql(MIGRATION);
  });

  it("o CHECK de kind aceita o do fork e mantém os novos do original", () => {
    const definicao = definicaoDe("agent_inbox_items_kind_check");
    for (const kind of [
      "publicacao_falhou",
      "channel_template_review_direct",
      "routing_ia_wait_expired",
      "followup_descartado",
    ]) {
      expect(definicao).toContain(`'${kind}'`);
    }
  });

  it("os CHECKs de provider aceitam meta_social e telegram", () => {
    for (const constraint of [
      "channel_sessions_provider_check",
      "channel_sessions_provider_ref_check",
      "webhook_events_log_provider_check",
    ]) {
      const definicao = definicaoDe(constraint);
      expect(definicao).toContain("meta_social");
      expect(definicao).toContain("telegram");
    }
    expect(definicaoDe("webhook_events_log_provider_check")).toContain("efi");
  });

  it("login não forja comment.received, nem os eventos reservados novos do original", () => {
    for (const evento of ["comment.received", "conversation.closed", "ai.case_updated"]) {
      expect(() =>
        sql(`
          set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${crypto.randomUUID()}"}', false);
          select public.emit_event('${evento}', 'contact', gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, gen_random_uuid());
        `),
      ).toThrow(/reserved_message_received/);
    }
  });

  it("a redação de LGPD alcança os comentários sem perder os passos novos do original", () => {
    const fonte = fonteDe("fn_lgpd_cascade_redact_contact");
    expect(fonte).toContain("public.social_comments");
    expect(fonte).toContain("v_identidade_social");
    // 9243: anexos, foto de perfil e fichas fundidas.
    expect(fonte).toContain("crm_lead_attachments");
    expect(fonte).toContain("v_avatar");
    expect(fonte).toContain("fichas_absorvidas");
  });
});
