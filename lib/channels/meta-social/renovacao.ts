/**
 * Instagram nativo — a renovação do token, para a conexão não morrer em 60 dias.
 *
 * O token de longa duração do Instagram vale 60 dias e só pode ser renovado
 * depois de 24h de vida. Sem renovação, o canal para de enviar sozinho dois
 * meses depois de conectado, sem ninguém ter mexido em nada — o tipo de morte
 * que ninguém associa à causa.
 *
 * A rodada é diária e escolhe quem renovar pela validade gravada:
 *  - validade desconhecida (token recém-colado) → tenta; a Meta recusa nas
 *    primeiras 24h, e isso não é erro (fica para amanhã);
 *  - validade a menos de `ANTECEDENCIA_DIAS` → renova.
 *
 * Quem avisa o operador quando o token MORRE de vez não é esta rodada: é o
 * vigia de conexão (`checkHealth` do adapter), que já abre o aviso na Central e
 * o fecha quando a conta volta. Duas peças avisando do mesmo problema seriam
 * dois avisos para uma causa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { renovarToken } from "./conta";
import { ErroDaGraphInstagram } from "./graph";
import { gravarTokenRenovado } from "./session";

/** Renova quando faltar menos que isto. Folga para falhar alguns dias seguidos. */
export const ANTECEDENCIA_DIAS = 20;

export interface ResultadoDaRenovacao {
  organizationId: string;
  channelSessionId: string;
  desfecho: "renovado" | "cedo_demais" | "falhou";
}

/** A sessão precisa de renovação agora? Pura, para o teste fixar a régua. */
export function precisaRenovar(expiraEm: string | null, agora: Date = new Date()): boolean {
  if (!expiraEm) return true;
  const restanteMs = new Date(expiraEm).getTime() - agora.getTime();
  return restanteMs < ANTECEDENCIA_DIAS * 24 * 60 * 60 * 1000;
}

export async function renovarTokensDoInstagram(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<ResultadoDaRenovacao[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, meta_social_token_encrypted, meta_social_token_expires_at")
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .is("archived_at", null)
    .not("meta_social_token_encrypted", "is", null);
  if (error) throw new Error(`instagram_token_sweep_failed: ${error.message}`);

  const resultados: ResultadoDaRenovacao[] = [];
  for (const linha of (data ?? []) as {
    id: string;
    organization_id: string;
    meta_social_token_encrypted: string;
    meta_social_token_expires_at: string | null;
  }[]) {
    if (!precisaRenovar(linha.meta_social_token_expires_at, agora)) continue;
    const base = { organizationId: linha.organization_id, channelSessionId: linha.id };

    const token = await decryptWebhookSecret(admin, linha.meta_social_token_encrypted);
    if (!token) {
      resultados.push({ ...base, desfecho: "falhou" });
      continue;
    }
    try {
      const novo = await renovarToken(token, agora);
      const cifrado = await encryptWebhookSecret(admin, novo.token);
      if (!cifrado) throw new Error("cifra_indisponivel");
      const { error: erroGravacao } = await gravarTokenRenovado(admin, {
        ...base,
        tokenEncrypted: cifrado,
        expiresAt: novo.expiraEm,
      });
      if (erroGravacao) throw new Error(erroGravacao);
      resultados.push({ ...base, desfecho: "renovado" });
    } catch (e) {
      // Token com menos de 24h: a Meta recusa a renovação, e é o esperado logo
      // depois de conectar. Só conta como falha quando a validade é CONHECIDA.
      const cedo = !linha.meta_social_token_expires_at && e instanceof ErroDaGraphInstagram && !e.tokenInvalido;
      if (!cedo) {
        logger.warn("[canal.instagram] renovação do token falhou", {
          organization_id: linha.organization_id,
          channel_session_id: linha.id,
          detail: e instanceof Error ? e.message.slice(0, 160) : "erro",
        });
      }
      resultados.push({ ...base, desfecho: cedo ? "cedo_demais" : "falhou" });
    }
  }
  return resultados;
}
