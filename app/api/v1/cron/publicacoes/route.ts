import { NextResponse, type NextRequest } from "next/server";

import { autorizaCron } from "@/lib/auth/cron-auth";
import { rodadaDePublicacao } from "@/lib/publicacoes/fila";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * publicacoes — a fila do módulo de publicações (ADR-0002). A regra inteira
 * mora em `lib/publicacoes/fila.ts`: reivindicar o que venceu (pulando
 * organização parada, pela régua `idsDeOrgsParadas`), publicar pela conta e
 * gravar o desfecho.
 *
 * A auditoria é por POST e por efeito (`publicacao.publicada`/`.falhou`), dentro
 * da fila: rodada vazia não audita nada (`cron-audita-so-quando-ha-efeito`).
 * Onde o módulo não está instalado, o claim devolve vazio sem a tabela.
 */
export const dynamic = "force-dynamic";

async function executar(req: NextRequest) {
  if (!autorizaCron(req))
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  try {
    const resultados = await rodadaDePublicacao(createAdminClient());
    const contagem: Record<string, number> = {};
    for (const r of resultados) contagem[r.desfecho] = (contagem[r.desfecho] ?? 0) + 1;
    return NextResponse.json({ data: { processados: resultados.length, ...contagem } });
  } catch {
    return NextResponse.json(
      { error: { code: "internal_error", message: "A fila de publicações não pôde ser lida." } },
      { status: 500 },
    );
  }
}

export const GET = executar;
export const POST = executar;
