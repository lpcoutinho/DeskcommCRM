/**
 * A provisionadora do módulo de publicações (migration 0722) na forma da ADR-0002:
 * security definer sem parâmetro, executável só pelo service role, cria
 * EXATAMENTE a tabela declarada, não toca o núcleo, nasce protegida e é
 * idempotente. A RLS por operação e o claim da fila estão em
 * `publicacoes-modulo.test.ts`.
 */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";

moldeDeProvisionadora({
  modulo: "publicacoes",
  tabelas: ["publicacoes_posts"],
  protecaoPropria: ["publicacoes_posts"],
});
