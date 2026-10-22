/**
 * MÓDULO DE PUBLICAÇÕES (ADR-0002, migration 0741) — o que o banco garante.
 *
 *  1. A forma da provisionadora (D2/D4/D5) é medida pelo molde, em
 *     `publicacoes-provisionadora.test.ts`.
 *  2. Instalado: RLS por operação. `viewer` e `agent` leem e não escrevem;
 *     `manager` escreve só os estados da PESSOA (rascunho, agendado, cancelado),
 *     não toca post publicado/publicando, e não pendura post em conta de OUTRA
 *     organização. Leitura cross-org é zero.
 *  3. O claim só leva o que venceu, pula organização parada, e um post
 *     interrompido em `publicando` vira `falhou` com aviso na Central — nunca
 *     volta para a fila (publicar em dobro é pior que não publicar).
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const ORG_B = "cccccccc-9999-4000-8000-00000000e0b0";
const SESSAO_B = "cccccccc-9999-4000-8000-00000000e0b1";
const RASCUNHO = "cccccccc-9999-4000-8000-00000000e001";
const PUBLICADO = "cccccccc-9999-4000-8000-00000000e002";
const VENCIDO = "cccccccc-9999-4000-8000-00000000e003";
const FUTURO = "cccccccc-9999-4000-8000-00000000e004";
const PRESO = "cccccccc-9999-4000-8000-00000000e005";
const DA_ORG_B = "cccccccc-9999-4000-8000-00000000e006";

const MIDIA = `'[{"caminho":"${GOV_ORG}/00000000-0000-4000-8000-000000000001.jpg","mime":"image/jpeg"}]'::jsonb`;

const lerComo = (usuario: string, consulta: string): string =>
  lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
      ${consulta}
    `),
  );

const statusDe = (id: string): string =>
  lastLine(sql(`select status from public.publicacoes_posts where id = '${id}';`));

describe("instalado", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      select public.fn_publicacoes_provisionar();
      -- Idempotente: reaplicar (o que o update.sh faz) não quebra nem duplica.
      select public.fn_publicacoes_provisionar();

      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG_B}', 'publicacoes-b', 'Publicacoes B', 'Pub B') on conflict (id) do nothing;
      insert into public.channel_sessions (id, organization_id, provider, waha_session_name, display_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'waha', 'pub-b', 'B', '\\x00'::bytea) on conflict (id) do nothing;

      insert into public.publicacoes_posts (id, organization_id, channel_session_id, formato, midias, status, agendado_para, updated_at) values
        ('${RASCUNHO}', '${GOV_ORG}', '${GOV_SESSION}', 'imagem', ${MIDIA}, 'rascunho', null, now()),
        ('${PUBLICADO}', '${GOV_ORG}', '${GOV_SESSION}', 'imagem', ${MIDIA}, 'publicado', now() - interval '1 day', now()),
        ('${VENCIDO}', '${GOV_ORG}', '${GOV_SESSION}', 'imagem', ${MIDIA}, 'agendado', now() - interval '1 minute', now()),
        ('${FUTURO}', '${GOV_ORG}', '${GOV_SESSION}', 'imagem', ${MIDIA}, 'agendado', now() + interval '1 day', now()),
        ('${PRESO}', '${GOV_ORG}', '${GOV_SESSION}', 'imagem', ${MIDIA}, 'publicando', now() - interval '1 hour', now() - interval '30 minutes'),
        ('${DA_ORG_B}', '${ORG_B}', '${SESSAO_B}', 'imagem', ${MIDIA}, 'agendado', now() - interval '1 minute', now())
        on conflict (id) do nothing;
    `);
  });

  it("RLS ligada e anon fora", () => {
    expect(lastLine(sql(`select relrowsecurity::text from pg_class where oid = 'public.publicacoes_posts'::regclass;`))).toBe("true");
    expect(lastLine(sql(`select has_table_privilege('anon', 'public.publicacoes_posts', 'SELECT')::text;`))).toBe("false");
  });

  it("⭐ leitura cross-org é zero; dentro da organização, viewer lê", () => {
    expect(lerComo(GOV_VIEWER, `select count(*) from public.publicacoes_posts where id = '${DA_ORG_B}';`)).toBe("0");
    expect(lerComo(GOV_VIEWER, `select count(*) from public.publicacoes_posts where id = '${RASCUNHO}';`)).toBe("1");
  });

  for (const [papel, usuario] of [
    ["viewer", GOV_VIEWER],
    ["agent", GOV_AGENT_A],
  ] as const) {
    it(`${papel} não cria, não edita e não apaga`, () => {
      expect(
        writeCountAs(
          usuario,
          `insert into public.publicacoes_posts (organization_id, channel_session_id, formato, midias) values ('${GOV_ORG}', '${GOV_SESSION}', 'imagem', ${MIDIA})`,
        ),
      ).toBe(0);
      expect(writeCountAs(usuario, `update public.publicacoes_posts set legenda = 'x' where id = '${RASCUNHO}'`)).toBe(0);
      expect(writeCountAs(usuario, `delete from public.publicacoes_posts where id = '${RASCUNHO}'`)).toBe(0);
    });
  }

  it("manager escreve os estados da pessoa (controle positivo)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.publicacoes_posts (organization_id, channel_session_id, formato, midias, status, agendado_para) values ('${GOV_ORG}', '${GOV_SESSION}', 'imagem', ${MIDIA}, 'agendado', now() + interval '2 days')`,
      ),
    ).toBe(1);
    expect(writeCountAs(GOV_MANAGER, `update public.publicacoes_posts set legenda = 'nova' where id = '${RASCUNHO}'`)).toBe(1);
  });

  it("⭐ manager não escreve 'publicado' pela sessão, nem mexe no que já saiu", () => {
    expect(writeCountAs(GOV_MANAGER, `update public.publicacoes_posts set status = 'publicado' where id = '${RASCUNHO}'`)).toBe(0);
    expect(writeCountAs(GOV_MANAGER, `update public.publicacoes_posts set legenda = 'x' where id = '${PUBLICADO}'`)).toBe(0);
    // O ataque que só o USING barra: devolver o post publicado à fila — o WITH
    // CHECK aceitaria (`agendado` é estado da pessoa), e a fila o publicaria de NOVO.
    expect(
      writeCountAs(GOV_MANAGER, `update public.publicacoes_posts set status = 'agendado', agendado_para = now() where id = '${PUBLICADO}'`),
    ).toBe(0);
    expect(writeCountAs(GOV_MANAGER, `delete from public.publicacoes_posts where id = '${PUBLICADO}'`)).toBe(0);
    expect(statusDe(PUBLICADO)).toBe("publicado");
  });

  it("⭐ post não pendura em conta de OUTRA organização", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.publicacoes_posts (organization_id, channel_session_id, formato, midias) values ('${GOV_ORG}', '${SESSAO_B}', 'imagem', ${MIDIA})`,
      ),
    ).toBe(0);
  });

  it("⭐ o claim leva só o vencido, pula a organização parada e encerra o interrompido com aviso", () => {
    const avisosAntes = Number(
      lastLine(sql(`select count(*) from public.agent_inbox_items where organization_id = '${GOV_ORG}' and kind = 'publicacao_falhou';`)),
    );
    const levados = sql(
      `select post_id from public.fn_publicacoes_reivindicar(10, array['${ORG_B}']::uuid[]) order by 1;`,
    );
    expect(levados).toContain(VENCIDO);
    expect(levados).not.toContain(FUTURO);
    expect(levados).not.toContain(DA_ORG_B);
    expect(levados).not.toContain(PRESO);

    expect(statusDe(VENCIDO)).toBe("publicando");
    expect(lastLine(sql(`select tentativas from public.publicacoes_posts where id = '${VENCIDO}';`))).toBe("1");
    expect(statusDe(FUTURO)).toBe("agendado");
    expect(statusDe(DA_ORG_B)).toBe("agendado");

    // Interrompido no meio: falhou, com o motivo — nunca de volta à fila.
    expect(statusDe(PRESO)).toBe("falhou");
    expect(lastLine(sql(`select ultimo_erro from public.publicacoes_posts where id = '${PRESO}';`))).toBe(
      "interrompido_confira_no_instagram",
    );
    const avisosDepois = Number(
      lastLine(sql(`select count(*) from public.agent_inbox_items where organization_id = '${GOV_ORG}' and kind = 'publicacao_falhou';`)),
    );
    expect(avisosDepois).toBe(avisosAntes + 1);
  });

  it("o claim e a provisionadora não são alcançáveis por anon nem por authenticated", () => {
    for (const fn of ["fn_publicacoes_reivindicar(integer, uuid[])", "fn_publicacoes_provisionar()"]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(
          lastLine(sql(`select has_function_privilege('${papel}', 'public.${fn}', 'EXECUTE')::text;`)),
          `${papel} executa ${fn}`,
        ).toBe("false");
      }
    }
  });
});
