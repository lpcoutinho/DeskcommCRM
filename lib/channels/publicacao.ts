/**
 * O erro de publicação, do lado de fora do adapter: o que a fila precisa saber
 * para decidir entre tentar de novo e pedir ajuda a uma pessoa.
 *
 * `definitivo: true` = repetir não muda nada (mídia recusada, formato que a
 * rede não aceita, conta sem permissão): o post vira `falhou` e a Central avisa.
 * `definitivo: false` = rede fora do ar, limite diário, container expirado: a
 * fila tenta de novo mais tarde, até o teto de tentativas.
 */
export class ErroDePublicacao extends Error {
  constructor(
    message: string,
    readonly definitivo: boolean,
    /** Container já montado quando o erro aconteceu — a fila retoma por ele. */
    readonly containerId: string | null = null,
  ) {
    super(message);
    this.name = "ErroDePublicacao";
  }
}
