"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  conferirFormato,
  LIMITE_DA_LEGENDA,
  type ProblemaDeFormato,
  MIMES_ACEITOS,
  type Formato,
  type Midia,
  type StatusDoPost,
} from "@/lib/publicacoes/esquema";

/**
 * A agenda de publicações: escrever o post, escolher a conta e a hora, e ver o
 * que saiu, o que está na fila e o que falhou — com o MOTIVO da falha na linha,
 * porque é dali que a pessoa decide entre corrigir e tentar de novo.
 */

const ROTA = "/api/v1/publicacoes";
const CHAVE = ["publicacoes"];

interface Conta {
  id: string;
  nome: string;
  rede: string;
}

interface Post {
  id: string;
  channel_session_id: string | null;
  formato: Formato;
  legenda: string;
  midias: Midia[];
  status: StatusDoPost;
  agendado_para: string | null;
  ultimo_erro: string | null;
  link_publico: string | null;
  publicado_em: string | null;
  created_at: string;
  previa_url: string | null;
}

type MidiaNaTela = Midia & { previa_url: string | null };

const ABAS: { valor: "fila" | "publicado" | "falhou" | "rascunho"; status: StatusDoPost[] }[] = [
  { valor: "fila", status: ["agendado", "publicando"] },
  { valor: "publicado", status: ["publicado"] },
  { valor: "falhou", status: ["falhou"] },
  { valor: "rascunho", status: ["rascunho", "cancelado"] },
];

/** `datetime-local` fala a hora do navegador; a API recebe ISO com fuso. */
function paraIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function quando(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Um literal por ramo: `t()` não recebe variável (a chave tem de existir no dicionário). */
function useFraseDoProblema(): (p: ProblemaDeFormato) => string {
  const t = useT();
  return (p) => {
    switch (p) {
      case "sem_midia":
        return t("Escolha pelo menos uma imagem ou vídeo.");
      case "midias_demais":
        return t("Um post leva no máximo 10 mídias.");
      case "imagem_uma":
        return t("Post de imagem leva uma imagem só.");
      case "video_um":
        return t("Reels e vídeo levam um vídeo só.");
      case "story_um":
        return t("Story leva uma imagem ou um vídeo.");
      case "carrossel_varias":
        return t("Carrossel leva de 2 a 10 mídias.");
    }
  };
}

function NovoPost({ contas, aoSalvar }: { contas: Conta[]; aoSalvar: () => void }) {
  const t = useT();
  const fraseDoProblema = useFraseDoProblema();
  const [conta, setConta] = useState(contas[0]?.id ?? "");
  const [formato, setFormato] = useState<Formato>("imagem");
  const [legenda, setLegenda] = useState("");
  const [midias, setMidias] = useState<MidiaNaTela[]>([]);
  const [hora, setHora] = useState("");
  const [subindo, setSubindo] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const nomesDosFormatos: Record<Formato, string> = {
    imagem: t("Imagem"),
    video: t("Vídeo"),
    carrossel: t("Carrossel"),
    reel: t("Reels"),
    story: t("Story"),
  };
  const problema = midias.length > 0 ? conferirFormato(formato, midias) : null;

  const subir = async (arquivos: FileList | null) => {
    if (!arquivos?.length) return;
    setSubindo(true);
    try {
      for (const arquivo of Array.from(arquivos)) {
        const fd = new FormData();
        fd.append("arquivo", arquivo);
        const r = await fetch(`${ROTA}/midias`, { method: "POST", body: fd });
        const j = (await r.json().catch(() => null)) as {
          data?: MidiaNaTela;
          error?: { message?: string };
        } | null;
        if (!r.ok || !j?.data) {
          toast.error(t(j?.error?.message ?? "Não foi possível enviar o arquivo."));
          return;
        }
        setMidias((atual) => [...atual, j.data!].slice(0, 10));
      }
    } finally {
      setSubindo(false);
    }
  };

  const salvar = async (modo: "rascunho" | "agendar" | "agora") => {
    const agendar_para =
      modo === "rascunho" ? null : modo === "agora" ? new Date().toISOString() : paraIso(hora);
    if (modo === "agendar" && !agendar_para) {
      toast.error(t("Escolha a data e a hora da publicação."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post(ROTA, {
        channel_session_id: conta,
        formato,
        legenda,
        midias: midias.map(({ caminho, mime }) => ({ caminho, mime })),
        agendar_para,
      });
      toast.success(
        modo === "rascunho"
          ? t("Rascunho salvo.")
          : modo === "agora"
            ? t("Post na fila: sai em até um minuto.")
            : t("Post agendado."),
      );
      setLegenda("");
      setMidias([]);
      setHora("");
      aoSalvar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível salvar o post."));
    } finally {
      setSalvando(false);
    }
  };

  const pronto = conta && midias.length > 0 && !problema && !subindo && !salvando;

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="publicacoes-novo">
      <h2 className="text-sm font-semibold">{t("Novo post")}</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pub-conta">{t("Conta")}</Label>
          <select
            id="pub-conta"
            value={conta}
            onChange={(e) => setConta(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {contas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pub-formato">{t("Formato")}</Label>
          <select
            id="pub-formato"
            value={formato}
            onChange={(e) => setFormato(e.target.value as Formato)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {(Object.keys(nomesDosFormatos) as Formato[]).map((f) => (
              <option key={f} value={f}>
                {nomesDosFormatos[f]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pub-midias">{t("Imagens e vídeos")}</Label>
        <Input
          id="pub-midias"
          type="file"
          multiple={formato === "carrossel"}
          accept={MIMES_ACEITOS.join(",")}
          disabled={subindo || midias.length >= 10}
          onChange={async (e) => {
            await subir(e.target.files);
            e.target.value = "";
          }}
        />
        {midias.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {midias.map((m, i) => (
              <div key={m.caminho} className="relative h-20 w-20 overflow-hidden rounded-md border border-border bg-muted">
                {m.previa_url && m.mime.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element -- URL assinada e temporária do Storage
                  <img src={m.previa_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {t("Vídeo")}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={t("Remover")}
                  className="absolute right-1 top-1 rounded bg-background/80 px-1 text-xs"
                  onClick={() => setMidias((atual) => atual.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {subindo && <p className="text-xs text-muted-foreground">{t("Enviando…")}</p>}
        {problema && <p className="text-xs text-destructive">{fraseDoProblema(problema)}</p>}
      </div>

      {formato !== "story" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pub-legenda">{t("Legenda")}</Label>
          <Textarea
            id="pub-legenda"
            value={legenda}
            maxLength={LIMITE_DA_LEGENDA}
            rows={4}
            onChange={(e) => setLegenda(e.target.value)}
          />
          <p className="text-right text-xs text-muted-foreground">
            {legenda.length}/{LIMITE_DA_LEGENDA}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pub-hora">{t("Publicar em")}</Label>
        <Input
          id="pub-hora"
          type="datetime-local"
          className="max-w-xs"
          value={hora}
          onChange={(e) => setHora(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => salvar("agendar")} disabled={!pronto || !hora}>
          {t("Agendar")}
        </Button>
        <Button variant="outline" onClick={() => salvar("agora")} disabled={!pronto}>
          {t("Publicar agora")}
        </Button>
        <Button variant="ghost" onClick={() => salvar("rascunho")} disabled={!pronto}>
          {t("Salvar rascunho")}
        </Button>
      </div>
    </Card>
  );
}

export function Publicacoes({ podeGerenciar }: { podeGerenciar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [aba, setAba] = useState<(typeof ABAS)[number]["valor"]>("fila");
  const { data, isLoading } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: { posts: Post[]; contas: Conta[] } }>(ROTA)).data,
    // A fila anda sozinha: a lista se atualiza enquanto a pessoa olha.
    refetchInterval: 30_000,
  });
  const recarregar = () => qc.invalidateQueries({ queryKey: CHAVE });

  const contas = data?.contas ?? [];
  const posts = useMemo(() => data?.posts ?? [], [data]);
  const nomeDaConta = (id: string | null) => contas.find((c) => c.id === id)?.nome ?? t("conta desconectada");
  const visiveis = posts.filter((p) => ABAS.find((a) => a.valor === aba)!.status.includes(p.status));

  const rotuloDoStatus: Record<StatusDoPost, string> = {
    rascunho: t("Rascunho"),
    agendado: t("Agendado"),
    publicando: t("Publicando"),
    publicado: t("Publicado"),
    falhou: t("Falhou"),
    cancelado: t("Cancelado"),
  };

  const acao = async (fn: () => Promise<unknown>, sucesso: string) => {
    try {
      await fn();
      toast.success(sucesso);
      await recarregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível concluir."));
    }
  };

  const tentarDeNovo = (p: Post) =>
    acao(
      () =>
        apiClient.patch(`${ROTA}/${p.id}`, {
          channel_session_id: p.channel_session_id,
          formato: p.formato,
          legenda: p.legenda,
          midias: p.midias,
          agendar_para: new Date().toISOString(),
        }),
      t("Post de volta na fila."),
    );

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4" data-testid="publicacoes">
      {contas.length === 0 ? (
        <Card className="flex flex-col gap-2 p-4">
          <p className="text-sm font-medium">{t("Nenhuma conta que publica está conectada.")}</p>
          <p className="text-xs text-muted-foreground">
            {t("Conecte a conta profissional do Instagram em Conexões › Instagram para agendar posts.")}
          </p>
          <Link href="/app/connections?aba=instagram" className="text-sm font-medium text-primary hover:underline">
            {t("Abrir Conexões")}
          </Link>
        </Card>
      ) : (
        podeGerenciar && <NovoPost contas={contas} aoSalvar={recarregar} />
      )}

      <Tabs value={aba} onValueChange={(v) => setAba(v as typeof aba)}>
        <TabsList>
          <TabsTrigger value="fila">{t("Na fila")}</TabsTrigger>
          <TabsTrigger value="publicado">{t("Publicados")}</TabsTrigger>
          <TabsTrigger value="falhou">{t("Falharam")}</TabsTrigger>
          <TabsTrigger value="rascunho">{t("Rascunhos")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {visiveis.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nada por aqui.")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visiveis.map((p) => (
            <li key={p.id}>
              <Card className="flex gap-3 p-3" data-testid="publicacao-item">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                  {p.previa_url && p.midias[0]?.mime.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element -- URL assinada e temporária do Storage
                    <img src={p.previa_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      {t("Vídeo")}
                    </span>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={p.status === "falhou" ? "destructive" : "secondary"}>
                      {rotuloDoStatus[p.status]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {nomeDaConta(p.channel_session_id)} ·{" "}
                      {p.status === "publicado" ? quando(p.publicado_em) : quando(p.agendado_para)}
                    </span>
                  </div>
                  <p className="truncate text-sm">{p.legenda || t("(sem legenda)")}</p>
                  {p.status === "falhou" && p.ultimo_erro && (
                    <p className="text-xs text-destructive">
                      {p.ultimo_erro === "interrompido_confira_no_instagram"
                        ? t("A publicação foi interrompida e pode ter saído. Confira no perfil antes de tentar de novo.")
                        : p.ultimo_erro}
                    </p>
                  )}
                  {p.link_publico && (
                    <a href={p.link_publico} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                      {t("Ver no Instagram")}
                    </a>
                  )}
                </div>
                {podeGerenciar && (
                  <div className="flex shrink-0 flex-col gap-1">
                    {p.status === "agendado" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          acao(() => apiClient.patch(`${ROTA}/${p.id}`, { acao: "cancelar" }), t("Post cancelado."))
                        }
                      >
                        {t("Cancelar")}
                      </Button>
                    )}
                    {(p.status === "falhou" || p.status === "rascunho" || p.status === "cancelado") && (
                      <Button size="sm" variant="outline" onClick={() => tentarDeNovo(p)}>
                        {t("Publicar agora")}
                      </Button>
                    )}
                    {p.status !== "publicado" && p.status !== "publicando" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => acao(() => apiClient.delete(`${ROTA}/${p.id}`), t("Post apagado."))}
                      >
                        {t("Apagar")}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
