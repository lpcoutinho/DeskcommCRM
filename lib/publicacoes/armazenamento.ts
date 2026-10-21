/**
 * O bucket privado `publicacoes` — garantido pelo servidor, não pela migration.
 *
 * A provisionadora do módulo só escreve nas tabelas dele (molde da ADR-0002),
 * então o bucket nasce aqui, pela API do Storage, no primeiro upload. Idempotente:
 * "já existe" é o desfecho normal de todo upload depois do primeiro.
 *
 * Bucket SÓ do módulo, e não `whatsapp-media`: a retenção de mídia de conversa
 * varre arquivo órfão lá, e apagaria a mídia de um post agendado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { BUCKET_DE_PUBLICACOES, MIMES_ACEITOS, TAMANHO_MAXIMO_BYTES } from "./esquema";

let garantido = false;

export async function garantirBucketDePublicacoes(admin: SupabaseClient): Promise<void> {
  if (garantido) return;
  const { error } = await admin.storage.createBucket(BUCKET_DE_PUBLICACOES, {
    public: false,
    fileSizeLimit: TAMANHO_MAXIMO_BYTES,
    allowedMimeTypes: [...MIMES_ACEITOS],
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`bucket_de_publicacoes_indisponivel: ${error.message}`);
  }
  garantido = true;
}
