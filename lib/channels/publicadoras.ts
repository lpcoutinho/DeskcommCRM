/**
 * As contas desta organização que PUBLICAM conteúdo — o seletor "onde publicar"
 * da tela de publicações.
 *
 * A pergunta é de capacidade, não de identidade (invariante 1 da doutrina de
 * canal): uma conta publica se o adapter dela sabe `publicarConteudo`. Rede
 * nova que aprender a publicar aparece aqui sem tocar na tela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { nomeDoCanal } from "./estado";
import { getAdapter } from "./index";
import { channelBrand } from "./presentation";
import type { ChannelProvider, FormatoDePublicacao } from "./types";

const TODOS_OS_FORMATOS: readonly FormatoDePublicacao[] = ["imagem", "video", "carrossel", "reel", "story"];

export interface ContaQuePublica {
  id: string;
  nome: string;
  /** A rede como o usuário a reconhece (`instagram`, `messenger`…). */
  rede: string;
  /** O que esta conta publica — a tela só oferece estes, e a rota recusa o resto. */
  formatos: FormatoDePublicacao[];
}

function publica(provider: string): boolean {
  try {
    return typeof getAdapter(provider as ChannelProvider).publicarConteudo === "function";
  } catch {
    // Provider mais novo que este código (ou de voz): não publica.
    return false;
  }
}

export async function contasQuePublicam(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ContaQuePublica[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, provider, display_name, metadata")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`contas_que_publicam_falhou: ${error.message}`);
  return ((data ?? []) as {
    id: string;
    provider: string;
    display_name: string | null;
    metadata: Record<string, unknown> | null;
  }[])
    .filter((s) => publica(s.provider))
    .map((s) => {
      const plataforma = typeof s.metadata?.social_platform === "string" ? s.metadata.social_platform : null;
      const adapter = getAdapter(s.provider as ChannelProvider);
      return {
        id: s.id,
        nome: nomeDoCanal(s),
        rede: channelBrand({ provider: s.provider, social_platform: plataforma }),
        formatos: [...(adapter.formatosQuePublica?.(s.metadata) ?? TODOS_OS_FORMATOS)],
      };
    });
}
