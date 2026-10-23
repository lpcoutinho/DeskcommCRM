"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

const ROTA = "/api/v1/social-comments";
const CHAVE = ["social-comments"];
/** O prazo da DM a partir do comentário (regra da Meta), em ms. */
const PRAZO_DO_PRIVADO_MS = 7 * 86_400_000;

interface Comentario {
  id: string;
  network: string;
  media_external_id: string | null;
  author_username: string | null;
  body: string | null;
  commented_at: string;
  public_replied_at: string | null;
  private_reply_status: "sending" | "sent" | "failed" | null;
  private_reply_error: string | null;
}

/** O comentário com o prazo do privado já medido — na busca, não na renderização. */
type ComentarioNaTela = Comentario & { prazoVencido: boolean };

type Modo = "publico" | "privado";

function quando(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * A lista dos comentários, com o que já foi respondido em cada um e a resposta
 * à mão. A resposta automática é configurada em Automações; aqui a pessoa vê o
 * que a regra fez (o selo) e responde o que a regra não cobriu.
 */
export function Comentarios({ podeResponder, podeAutomatizar }: { podeResponder: boolean; podeAutomatizar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [aberto, setAberto] = useState<{ id: string; modo: Modo } | null>(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: CHAVE,
    queryFn: async (): Promise<ComentarioNaTela[]> => {
      const lista = (await apiClient.get<{ data: Comentario[] }>(ROTA)).data;
      // O relógio é lido aqui: a renderização tem de ser pura, e a lista se
      // rebusca a cada 30 s, o que basta para um prazo contado em dias.
      const agora = Date.now();
      return lista.map((c) => ({
        ...c,
        prazoVencido: agora - new Date(c.commented_at).getTime() > PRAZO_DO_PRIVADO_MS,
      }));
    },
    // Comentário chega pelo webhook a qualquer hora: a lista se atualiza sozinha.
    refetchInterval: 30_000,
  });
  const comentarios = data ?? [];

  const abrir = (id: string, modo: Modo) => {
    setAberto({ id, modo });
    setTexto("");
  };

  const responder = async () => {
    if (!aberto || !texto.trim()) return;
    setEnviando(true);
    try {
      await apiClient.post(`${ROTA}/${aberto.id}/responder`, { modo: aberto.modo, texto });
      toast.success(aberto.modo === "publico" ? t("Resposta publicada.") : t("Mensagem privada enviada."));
      setAberto(null);
      await qc.invalidateQueries({ queryKey: CHAVE });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Não foi possível responder."));
    } finally {
      setEnviando(false);
    }
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4" data-testid="comentarios">
      {podeAutomatizar && (
        <Card className="flex flex-col gap-1 p-4">
          <p className="text-sm font-medium">{t("Responder sozinho")}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Crie uma automação com o gatilho \"Quando alguém comentar numa publicação\": por exemplo, quem comentar \"eu quero\" recebe o link no privado.",
            )}
          </p>
          <Link href="/app/webhooks?aba=automacoes" className="text-sm font-medium text-primary hover:underline">
            {t("Abrir Automações")}
          </Link>
        </Card>
      )}

      {comentarios.length === 0 ? (
        <Card className="flex flex-col gap-2 p-4">
          <p className="text-sm font-medium">{t("Nenhum comentário ainda.")}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Os comentários chegam pela conexão do Instagram ou da página do Facebook. Se a conta já está conectada e nada aparece, confira se o webhook assina o campo de comentários (comments no Instagram, feed na página).",
            )}
          </p>
          <Link href="/app/connections?aba=instagram" className="text-sm font-medium text-primary hover:underline">
            {t("Abrir Conexões")}
          </Link>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {comentarios.map((c) => {
            const podePublico = podeResponder && !c.public_replied_at;
            const podePrivado = podeResponder && !c.private_reply_status && !c.prazoVencido;
            const esteAberto = aberto?.id === c.id;
            return (
              <li key={c.id}>
                <Card className="flex flex-col gap-2 p-3" data-testid="comentario-item">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {c.author_username ? `@${c.author_username}` : t("Pessoa anonimizada")}
                    </span>
                    <span className="text-xs text-muted-foreground">{quando(c.commented_at)}</span>
                    {c.public_replied_at && <Badge variant="secondary">{t("Respondido em público")}</Badge>}
                    {c.private_reply_status === "sent" && <Badge variant="secondary">{t("Chamado no privado")}</Badge>}
                    {c.private_reply_status === "sending" && <Badge variant="secondary">{t("Enviando no privado")}</Badge>}
                    {c.private_reply_status === "failed" && (
                      <Badge variant="destructive">{t("Mensagem privada falhou")}</Badge>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{c.body ?? t("(comentário sem texto)")}</p>
                  {c.private_reply_status === "failed" && c.private_reply_error && (
                    <p className="text-xs text-destructive">{c.private_reply_error}</p>
                  )}
                  {(podePublico || podePrivado) && !esteAberto && (
                    <div className="flex flex-wrap gap-2">
                      {podePublico && (
                        <Button size="sm" variant="outline" onClick={() => abrir(c.id, "publico")}>
                          {t("Responder em público")}
                        </Button>
                      )}
                      {podePrivado && (
                        <Button size="sm" variant="outline" onClick={() => abrir(c.id, "privado")}>
                          {t("Chamar no privado")}
                        </Button>
                      )}
                    </div>
                  )}
                  {esteAberto && (
                    <div className="flex flex-col gap-2">
                      <Textarea
                        rows={3}
                        value={texto}
                        onChange={(e) => setTexto(e.target.value)}
                        maxLength={aberto.modo === "publico" ? 2200 : 1000}
                        aria-label={aberto.modo === "publico" ? t("Resposta pública") : t("Mensagem privada")}
                        placeholder={
                          aberto.modo === "publico" ? t("Te chamei no direct! 💬") : t("Oi! Aqui está o link que você pediu: …")
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {aberto.modo === "publico"
                          ? t("A resposta aparece embaixo do comentário, assinada pela conta.")
                          : t("A rede aceita uma mensagem privada por comentário. A conversa aparece no Inbox.")}
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={responder} disabled={enviando || !texto.trim()}>
                          {enviando ? t("Enviando…") : t("Enviar")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAberto(null)}>
                          {t("Cancelar")}
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
