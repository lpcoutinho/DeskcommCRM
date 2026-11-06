import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A MIGRATION 8004 REALMENTE RECONCILIA O FORK COM O ORIGINAL.
 *
 * Migrations do original recriaram três objetos sem o que o fork acrescentou, e
 * nenhuma delas conflita no git: o `publicacao_falhou` sairia do CHECK, o
 * `comment.received` perderia a reserva e a redação de LGPD deixaria os comentários
 * intactos. A suíte aplica só o baseline, então sem este arquivo a 8004 nunca rodaria
 * num banco antes de chegar a uma instalação.
 *
 * Aplicada DUAS vezes: a segunda passada é a prova de idempotência.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20261106000000_8004_reconcilia_fork_com_v1_102.sql",
  "utf8",
);

const fonteDe = (funcao: string) =>
  sql(`select prosrc from pg_proc where oid = 'public.${funcao}'::regproc;`);

describe("migration 8004 — reconciliação do fork", () => {
  beforeAll(() => {
    sql(MIGRATION);
    sql(MIGRATION);
  });

  it("o CHECK de kind aceita o do fork e mantém os do original", () => {
    const definicao = sql(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'agent_inbox_items_kind_check';`,
    );
    for (const kind of [
      "publicacao_falhou",
      "assinatura_desconectada",
      "recuperacao_da_queda",
      "proposal_promised_not_created",
    ]) {
      expect(definicao).toContain(`'${kind}'`);
    }
  });

  it("login não forja comment.received, e os eventos reservados do original seguem reservados", () => {
    for (const evento of ["comment.received", "lead.stage_stale"]) {
      expect(() =>
        sql(`
          set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${crypto.randomUUID()}"}', false);
          select public.emit_event('${evento}', 'contact', gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, gen_random_uuid());
        `),
      ).toThrow(/reserved_message_received/);
    }
  });

  it("a redação de LGPD alcança os comentários sem perder o passo novo do original", () => {
    const fonte = fonteDe("fn_lgpd_cascade_redact_contact");
    expect(fonte).toContain("public.social_comments");
    expect(fonte).toContain("v_identidade_social");
    expect(fonte).toContain("v_variantes");
  });

  it("social_comments tem grant explícito: authenticated só lê, service_role escreve", () => {
    const pode = (papel: string, comando: string) =>
      lastLine(sql(`select has_table_privilege('${papel}', 'public.social_comments', '${comando}');`));
    expect(pode("authenticated", "SELECT")).toBe("t");
    expect(pode("authenticated", "INSERT")).toBe("f");
    expect(pode("service_role", "INSERT")).toBe("t");
    expect(pode("anon", "SELECT")).toBe("f");
  });
});
