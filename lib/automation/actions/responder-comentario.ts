/**
 * Ações `reply_comment` e `private_reply_comment` — responder o comentário do
 * evento `comment.received`, em público ou no privado (a DM que nasce dele).
 *
 * O caminho é o MESMO da tela de Comentários (`lib/comentarios/responder.ts`):
 * a guarda de uma resposta por comentário, o prazo da DM privada e a falha
 * terminal moram lá. Aqui fica só o que é da regra: o texto do template, e não
 * mandar DM a quem pediu para não receber mensagem.
 */
import { registerAction } from "@/lib/automation/actions";
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";
import { renderTemplate } from "@/lib/automation/template";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { responderComentario, type ModoDaResposta } from "@/lib/comentarios/responder";

function executor(type: "reply_comment" | "private_reply_comment", modo: ModoDaResposta) {
  return async (ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> => {
    const comentario = ctx.context.comment as { id?: unknown } | undefined;
    if (typeof comentario?.id !== "string") {
      return { type, status: "skipped", detail: { reason: "sem_comentario" } };
    }
    // Quem pediu para não receber mensagem não recebe DM, nem a do comentário.
    if (modo === "privado" && (ctx.context.contact as { is_blocked?: boolean } | undefined)?.is_blocked === true) {
      return { type, status: "skipped", detail: { reason: "contato_bloqueado" } };
    }
    const template = typeof config.template === "string" ? config.template : "";
    const texto = renderTemplate(template, ctx.context).trim();
    if (!texto) return { type, status: "failed", error: "missing_config" };

    try {
      const r = await responderComentario(ctx.admin, {
        organizationId: ctx.organizationId,
        commentId: comentario.id,
        modo,
        texto,
      });
      if (r.estado === "respondido") return { type, status: "success", detail: { external_id: r.externalId } };
      if (r.estado === "nao_respondido") return { type, status: "skipped", detail: { reason: r.motivo } };
      return { type, status: "failed", error: r.erro };
    } catch (err) {
      return { type, status: "failed", error: mensagemDeErro(err) };
    }
  };
}

registerAction({ type: "reply_comment", execute: executor("reply_comment", "publico") });
registerAction({ type: "private_reply_comment", execute: executor("private_reply_comment", "privado") });
