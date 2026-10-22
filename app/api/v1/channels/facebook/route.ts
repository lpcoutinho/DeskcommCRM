import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/channels/facebook — estado da conexão + o que colar no app Meta.
 * POST  /api/v1/channels/facebook — VALIDA o token, grava e liga a conta ao webhook.
 * PATCH /api/v1/channels/facebook — configura o webhook NO APP Meta (opcional).
 *
 * A página do Facebook (Messenger) pela API da Meta, com o PRÓPRIO app da organização. O corpo é o mesmo
 * das duas redes (`../_conexao-social.ts`); o caminho fala na rede que o
 * operador reconhece, e quem é o provider mora em `lib/channels/`.
 */
import type { NextRequest, NextResponse } from "next/server";

import {
  conectarRedeSocial,
  configurarWebhookDaRedeSocial,
  obterConexaoSocial,
} from "../_conexao-social";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  return obterConexaoSocial(req, "facebook");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return conectarRedeSocial(req, "facebook");
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return configurarWebhookDaRedeSocial(req, "facebook");
}
