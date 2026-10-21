/**
 * O gatilho `comment.received` e as ações que respondem comentário.
 *
 * A ação de comentário só tem o que responder quando o evento É um comentário:
 * em outro gatilho ela seria uma regra salva que nunca age. A porta (o schema
 * que a rota e o designer usam) recusa — inclusive quando a ação vem escondida
 * dentro de um `ai_decide`.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildContext } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  acoesDeComentarioForaDoGatilho,
  createAutomationRuleSchema,
  ENTIDADE_ESPERADA_POR_GATILHO,
  MENSAGEM_DA_ACAO_DE_COMENTARIO,
} from "@/lib/schemas/webhooks";

const responderNoPrivado = { type: "private_reply_comment", config: { template: "Oi {{comment.author_username}}!" } };

describe("ações de comentário na porta do schema", () => {
  it("o gatilho existe e traz o comentário como entidade", () => {
    expect(ENTIDADE_ESPERADA_POR_GATILHO["comment.received"]).toBe("social_comment");
  });

  it("controle positivo: comentário → DM privada é aceito", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Eu quero → link",
      trigger_event: "comment.received",
      conditions: [{ field: "comment.body", op: "contains", value: "eu quero" }],
      actions: [responderNoPrivado, { type: "reply_comment", config: { template: "Te chamei no direct!" } }],
    });
    expect(r.success).toBe(true);
  });

  it("⭐ ação de comentário em outro gatilho é recusada, com a frase para quem monta", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "errada",
      trigger_event: "lead.created",
      actions: [responderNoPrivado],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(MENSAGEM_DA_ACAO_DE_COMENTARIO);
  });

  it("⭐ escondida dentro de um ai_decide também é vista", () => {
    const tipos = acoesDeComentarioForaDoGatilho("message.received", [
      {
        type: "ai_decide",
        config: { opcoes: [{ id: "a", rotulo: "a", acao: responderNoPrivado }, { id: "b", rotulo: "b", acao: { type: "add_tag" } }] },
      },
    ]);
    expect(tipos).toEqual(["private_reply_comment"]);
  });
});

describe("o contexto da regra de comentário", () => {
  it("hidrata o comentário de AGORA e o contato pela identidade social, sempre na organização do evento", async () => {
    const consultas: { tabela: string; filtros: Record<string, unknown> }[] = [];
    const linhas: Record<string, Record<string, unknown>> = {
      social_comments: { id: "c1", body: "eu quero", author_identity: "instagram:conta:p1" },
      contacts: { id: "ct1", name: "Maria" },
    };
    const admin = {
      from: (tabela: string) => {
        const filtros: Record<string, unknown> = {};
        const api = {
          select: () => api,
          eq: (c: string, v: unknown) => ((filtros[c] = v), api),
          is: () => api,
          maybeSingle: async () => {
            consultas.push({ tabela, filtros });
            return { data: linhas[tabela] ?? null, error: null };
          },
        };
        return api;
      },
    } as unknown as SupabaseClient;
    const row = {
      id: "e1",
      organization_id: "org-1",
      event_type: "comment.received",
      entity_kind: "social_comment",
      entity_id: "c1",
      payload: { comment_id: "c1" },
      metadata: {},
    } as unknown as EventRow;

    const ctx = await buildContext(admin, row);
    expect(ctx.comment).toEqual(linhas.social_comments);
    expect(ctx.contact).toEqual(linhas.contacts);
    expect(consultas).toEqual([
      { tabela: "social_comments", filtros: { id: "c1", organization_id: "org-1" } },
      { tabela: "contacts", filtros: { organization_id: "org-1", social_identity: "instagram:conta:p1" } },
    ]);
  });
});
