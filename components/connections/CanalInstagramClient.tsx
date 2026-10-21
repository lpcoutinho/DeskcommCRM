"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { nomeDoCanal } from "@/lib/channels/estado";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Conectar o Instagram pela API da Meta, com o app da própria empresa.
 *
 * Quem chega aqui quase nunca criou um app na Meta antes. Por isso a tela
 * começa pelo PASSO A PASSO, e não pelo formulário: um campo "chave secreta do
 * app" sem dizer onde ela fica é um beco sem saída para quem instalou o CRM
 * para vender.
 *
 * ─── Duas pontas, na ordem em que dá errado ─────────────────────────────────
 *
 * 1. Token + chave secreta do app: com eles o CRM ENVIA e confere o que chega.
 * 2. O webhook do app: sem ele a Meta não sabe para onde mandar as mensagens.
 *    O CRM envia mas NÃO RECEBE — e a tela diz isso em voz alta, com o botão
 *    que resolve (ou os dois valores para colar no painel).
 */

const ROTA = "/api/v1/channels/instagram";
const CHAVE = ["canal-instagram"];

interface Estado {
  connected: boolean;
  channel_session_id: string | null;
  account_id: string | null;
  username: string | null;
  display_name: string | null;
  status: string | null;
  has_token: boolean;
  token_expires_at: string | null;
  webhook_url: string | null;
  verify_token: string | null;
}

/** Campo somente-leitura com botão de copiar — o que o operador cola do outro lado. */
function ParaColar({ rotulo, valor }: { rotulo: string; valor: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {rotulo}
      </span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
          {valor}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await copyToClipboard(valor);
            toast.success(t("Copiado."));
          }}
        >
          {t("Copiar")}
        </Button>
      </div>
    </div>
  );
}

/** O passo a passo da Meta, na ordem em que o painel pede. */
function PassoAPasso() {
  const t = useT();
  const passos = [
    {
      titulo: t("Crie um app na Meta"),
      texto: t(
        "Em developers.facebook.com, clique em Criar app e escolha o caso de uso de mensagens e conteúdo do Instagram. O app é da sua empresa: nenhum dado passa por terceiros.",
      ),
      link: "https://developers.facebook.com/apps",
    },
    {
      titulo: t("Ligue a sua conta do Instagram ao app"),
      texto: t(
        "No app, abra a configuração da API com login do Instagram, adicione a sua conta (ela precisa ser profissional: Empresa ou Criador de conteúdo) e gere o token de acesso.",
      ),
      link: null,
    },
    {
      titulo: t("Copie a chave secreta do app"),
      texto: t(
        "Em Configurações do app › Básico, clique em Mostrar na chave secreta do app. Anote também o ID do app, que aparece no topo da mesma página.",
      ),
      link: null,
    },
    {
      titulo: t("Cole o token e a chave aqui embaixo"),
      texto: t(
        "O CRM testa o token na Meta antes de gravar e descobre a conta sozinho. Os dois ficam guardados cifrados e não aparecem de novo.",
      ),
      link: null,
    },
    {
      titulo: t("Ligue o recebimento e publique o app"),
      texto: t(
        "Depois de conectar, configure o webhook com o botão desta tela (ou à mão no painel) e deixe o app no modo Ativo: a Meta só entrega mensagens de app publicado. Para atender contas que não têm papel no app, a Meta exige a análise do app (acesso avançado).",
      ),
      link: null,
    },
  ];

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="instagram-passo-a-passo">
      <div>
        <h3 className="text-sm font-semibold">{t("Passo a passo")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("Uns 15 minutos no painel da Meta, uma vez só.")}
        </p>
      </div>
      <ol className="flex flex-col gap-3">
        {passos.map((p, i) => (
          <li key={p.titulo} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{p.titulo}</p>
              <p className="text-xs text-muted-foreground">{p.texto}</p>
              {p.link && (
                <a
                  href={p.link}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  {t("Abrir o painel da Meta")}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function CanalInstagramClient() {
  const t = useT();
  const qc = useQueryClient();
  // Falha de leitura não trava a tela: sem estado, o formulário continua servindo.
  const { data: estado = null } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: Estado }>(ROTA)).data,
  });
  const [token, setToken] = useState("");
  const [segredo, setSegredo] = useState("");
  const [appId, setAppId] = useState("");
  const [salvando, setSalvando] = useState<"conta" | "webhook" | null>(null);

  const carregar = () => qc.invalidateQueries({ queryKey: CHAVE });
  const conectado = estado?.connected ?? false;

  const conectar = async () => {
    setSalvando("conta");
    try {
      const r = await apiClient.post<{
        data: { account_subscribed: boolean; account_subscription_error: string | null };
      }>(ROTA, { token, app_secret: segredo });
      // Os segredos saem da memória da tela assim que gravados: não voltam num GET.
      setToken("");
      setSegredo("");
      if (r.data.account_subscribed) toast.success(t("Conta do Instagram conectada."));
      else
        toast.warning(
          t("Conta conectada, mas a Meta não ligou o recebimento de mensagens desta conta."),
          { description: r.data.account_subscription_error ?? undefined },
        );
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(null);
    }
  };

  const configurarWebhook = async () => {
    setSalvando("webhook");
    try {
      await apiClient.patch(ROTA, { app_id: appId });
      toast.success(t("Webhook configurado no app. A Meta passa a entregar as mensagens aqui."));
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível configurar o webhook."));
    } finally {
      setSalvando(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="canal-instagram">
      {!conectado && <PassoAPasso />}

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{t("Instagram pela API da Meta")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "As mensagens diretas da sua conta profissional entram na caixa de entrada, com a IA e a equipe respondendo como no WhatsApp.",
              )}
            </p>
          </div>
          {conectado ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

        {conectado && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">
              {nomeDoCanal({ display_name: estado?.display_name }, t)}
            </p>
            <p className="text-xs text-muted-foreground">
              {estado?.status ?? "—"}
              {estado?.token_expires_at
                ? ` · ${t("token renovado automaticamente; vale até")} ${new Date(
                    estado.token_expires_at,
                  ).toLocaleDateString()}`
                : ""}
            </p>
          </div>
        )}

        {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="instagram-token">{t("Token de acesso")}</Label>
          <Input
            id="instagram-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={estado?.has_token ? t("gravada — preencha para trocar") : "IGAA…"}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="instagram-segredo">{t("Chave secreta do app")}</Label>
          <Input
            id="instagram-segredo"
            type="password"
            value={segredo}
            onChange={(e) => setSegredo(e.target.value)}
            placeholder={conectado ? t("gravada — preencha para trocar") : "a1b2c3…"}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "É com ela que o CRM confere que cada mensagem veio mesmo da Meta. Guardada cifrada; para trocar, cole a nova.",
            )}
          </p>
        </div>

        <div>
          <Button
            onClick={conectar}
            disabled={
              salvando !== null ||
              token.trim().length < 20 ||
              !/^[a-f0-9]{32}$/i.test(segredo.trim())
            }
          >
            {salvando === "conta" ? t("Verificando…") : conectado ? t("Reconectar") : t("Conectar")}
          </Button>
        </div>
      </Card>

      {/* Só depois de conectar: antes disso não há URL nem token de verificação. */}
      {conectado && estado?.webhook_url && estado.verify_token && (
        <Card className="flex flex-col gap-4 p-4" data-testid="instagram-webhook">
          <div>
            <h3 className="text-sm font-semibold">{t("Receber as mensagens")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "A Meta precisa saber para onde entregar as mensagens do Instagram. Sem isto o CRM envia, mas a mensagem do cliente não chega.",
              )}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="instagram-app-id">{t("ID do app")}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="instagram-app-id"
                className="max-w-xs"
                inputMode="numeric"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="1234567890123456"
                autoComplete="off"
              />
              <Button
                variant="outline"
                onClick={configurarWebhook}
                disabled={salvando !== null || !/^\d{5,25}$/.test(appId.trim())}
              >
                {salvando === "webhook" ? t("Configurando…") : t("Configurar automaticamente")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "Atenção: um app tem um endereço só para o Instagram. Se outra automação já recebe por este app, ela deixa de receber.",
              )}
            </p>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {t(
                "Prefere fazer à mão? No painel do app, em Webhooks do Instagram, cole os dois valores abaixo e assine os campos messages, messaging_seen, messaging_referral e comments.",
              )}
            </p>
            <ParaColar rotulo={t("URL do webhook")} valor={estado.webhook_url} />
            <ParaColar rotulo={t("Token de verificação")} valor={estado.verify_token} />
          </div>
        </Card>
      )}
    </div>
  );
}
