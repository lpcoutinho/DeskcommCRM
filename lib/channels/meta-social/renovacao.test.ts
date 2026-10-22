import { describe, expect, it } from "vitest";

import { ANTECEDENCIA_DIAS, precisaRenovar } from "./renovacao";

const DIA = 24 * 60 * 60 * 1000;

describe("precisaRenovar — a régua da renovação diária do token", () => {
  const agora = new Date("2026-10-21T12:00:00Z");

  it("validade desconhecida (token recém-colado) tenta renovar", () => {
    expect(precisaRenovar(null, agora)).toBe(true);
  });

  it("renova quando falta menos que a antecedência, e não antes", () => {
    const perto = new Date(agora.getTime() + (ANTECEDENCIA_DIAS - 1) * DIA).toISOString();
    const longe = new Date(agora.getTime() + (ANTECEDENCIA_DIAS + 1) * DIA).toISOString();
    expect(precisaRenovar(perto, agora)).toBe(true);
    expect(precisaRenovar(longe, agora)).toBe(false);
  });

  it("token já vencido também entra (a falha vira aviso pelo vigia de conexão)", () => {
    expect(precisaRenovar(new Date(agora.getTime() - DIA).toISOString(), agora)).toBe(true);
  });
});
