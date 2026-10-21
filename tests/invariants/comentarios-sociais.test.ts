/**
 * COMENTÁRIOS DAS REDES SOCIAIS (migration 0726) — o que o banco garante.
 *
 *  1. `social_comments` é lida pela organização e por mais ninguém, e nenhum
 *     papel do PostgREST escreve nela: quem grava é o servidor (a ingestão do
 *     webhook e a resposta), com a chave de serviço.
 *  2. O INSERT emite `comment.received` (entidade `social_comment`) — e o
 *     payload leva só ids: o texto e o @ ficam na linha, que a LGPD alcança.
 *  3. `comment.received` é do servidor: um login não o forja pelo `emit_event`.
 *  4. O reenvio do webhook não duplica: (organização, external_id) é único.
 *  5. A cascata de LGPD do contato alcança os comentários dele pela identidade
 *     social — e só os dele.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, GOV_VIEWER, lastLine, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

const ORG_B = "cccccccc-9999-4000-8000-00000000c0b0";
const CONTA = "17841400000000001";
const AUTORA = `instagram:${CONTA}:p-autora`;
const OUTRA = `instagram:${CONTA}:p-outra`;

const DA_AUTORA = "cccccccc-9999-4000-8000-00000000c001";
const DE_OUTRA = "cccccccc-9999-4000-8000-00000000c002";
const DA_ORG_B = "cccccccc-9999-4000-8000-00000000c003";
const CONTATO_DA_AUTORA = "cccccccc-9999-4000-8000-00000000c004";

const lerComo = (usuario: string, consulta: string): string =>
  lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
      ${consulta}
    `),
  );

const comentario = (id: string, org: string, externo: string, identidade: string, texto: string) => `
  insert into public.social_comments
    (id, organization_id, channel_session_id, network, account_external_id, external_id,
     media_external_id, author_external_id, author_identity, author_username, body)
  values ('${id}', '${org}', ${org === GOV_ORG ? `'${GOV_SESSION}'` : "null"}, 'instagram', '${CONTA}', '${externo}',
          'midia-1', split_part('${identidade}', ':', 3), '${identidade}', 'arroba_' || split_part('${identidade}', ':', 3), '${texto}')
  on conflict do nothing;`;

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_B}', 'comentarios-b', 'Comentarios B', 'Com B') on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name, social_identity)
      values ('${CONTATO_DA_AUTORA}', '${GOV_ORG}', 'Autora do comentário', '${AUTORA}')
      on conflict (id) do nothing;
    ${comentario(DA_AUTORA, GOV_ORG, "17800000000000001", AUTORA, "eu quero o link")}
    ${comentario(DE_OUTRA, GOV_ORG, "17800000000000002", OUTRA, "quanto custa?")}
    ${comentario(DA_ORG_B, ORG_B, "17800000000000003", OUTRA, "da outra empresa")}
  `);
});

describe("social_comments", () => {
  it("RLS ligada; anon não lê; nenhum papel do PostgREST escreve", () => {
    expect(lastLine(sql(`select relrowsecurity::text from pg_class where oid = 'public.social_comments'::regclass;`))).toBe("true");
    expect(lastLine(sql(`select has_table_privilege('anon', 'public.social_comments', 'SELECT')::text;`))).toBe("false");
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      expect(
        lastLine(sql(`select has_table_privilege('authenticated', 'public.social_comments', '${op}')::text;`)),
        `authenticated tem ${op}`,
      ).toBe("false");
    }
  });

  it("⭐ leitura cross-org é zero; dentro da organização, viewer lê", () => {
    expect(lerComo(GOV_VIEWER, `select count(*) from public.social_comments where id = '${DA_ORG_B}';`)).toBe("0");
    expect(lerComo(GOV_VIEWER, `select count(*) from public.social_comments where id = '${DA_AUTORA}';`)).toBe("1");
  });

  it("⭐ o INSERT emite comment.received com o comentário como entidade — e sem o texto no payload", () => {
    const linha = lastLine(
      sql(`
        select entity_kind || '|' || (payload ? 'body_preview')::text || '|' || (payload ? 'author_username')::text
                 || '|' || (payload->>'comment_id')
          from public.event_log
         where organization_id = '${GOV_ORG}' and event_type = 'comment.received' and entity_id = '${DA_AUTORA}';`),
    );
    expect(linha).toBe(`social_comment|false|false|${DA_AUTORA}`);
  });

  it("o reenvio do webhook (mesmo external_id) não duplica", () => {
    let erro: string | null = null;
    try {
      sql(`
        insert into public.social_comments (organization_id, network, account_external_id, external_id, body)
        values ('${GOV_ORG}', 'instagram', '${CONTA}', '17800000000000001', 'de novo');`);
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro).toContain("social_comments_org_external_id_unique");
  });

  it("⭐ um login NÃO forja comment.received pelo emit_event (42501)", () => {
    let erro: string | null = null;
    try {
      sql(`
        begin;
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', true) is not null;
        select public.emit_event('comment.received', 'social_comment', '${DA_AUTORA}'::uuid,
          '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid);
        rollback;`);
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro, "um viewer emitiu comment.received SEM erro").not.toBeNull();
    expect(erro).toContain("reserved_message_received");
  });

  it("⭐ a cascata de LGPD alcança os comentários da pessoa pela identidade social — e só os dela", () => {
    const retorno = lastLine(
      sql(`select public.fn_lgpd_cascade_redact_contact('${GOV_ORG}', '${CONTATO_DA_AUTORA}', '${randomUUID()}')->'counts'->>'social_comments';`),
    );
    expect(retorno).toBe("1");
    expect(
      lastLine(
        sql(`select coalesce(body, '∅') || '|' || coalesce(author_username, '∅') || '|' || coalesce(author_identity, '∅')
               from public.social_comments where id = '${DA_AUTORA}';`),
      ),
    ).toBe("∅|∅|∅");
    // A linha FICA (as respostas dependem dela); o comentário de outra pessoa não muda.
    expect(lastLine(sql(`select body from public.social_comments where id = '${DE_OUTRA}';`))).toBe("quanto custa?");
  });
});
