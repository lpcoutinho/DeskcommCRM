/**
 * A PRIMEIRA RENDERIZAÇÃO DO CLIENTE MOSTRA AS MESMAS PREFERÊNCIAS QUE O SERVIDOR MANDOU.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR (issue #690) ═══
 *
 * `NotificationPrefsClient` inicializava com
 * `useState<NotifyPrefs>(() => lerPrefs())`. O inicializador de `useState` roda
 * de novo na hidratação — que É a primeira renderização do cliente, a mesma que
 * o React compara contra o HTML que o servidor mandou. `lerPrefs()` decide a
 * fonte por `typeof window === "undefined"`: sem `window` devolve o padrão (tudo
 * ligado); com `window`, lê `localStorage` de verdade.
 *
 * Quem desligou o push de mensagem produzia, nesse instante, um cliente dizendo
 * `push: false` contra um servidor dizendo `push: true` — em dez `Switch` e no
 * `data-testid` que `canalLigado("message", "push")` alimentava durante o
 * render. É a mesma classe que o PR #666 consertou no seletor de tema
 * (`lib/theme.tsx`), e esta é a segunda instância viva dela.
 *
 * ═══ POR QUE A RECEITA ABAIXO É FIEL, E NÃO UM TRUQUE DE jsdom ═══
 *
 * `renderToStaticMarkup` nunca roda `useEffect` — é o mesmo motivo que
 * `lib/theme.test.tsx` e `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx`
 * usam. Isso o torna um substituto fiel tanto do HTML do servidor quanto da
 * saída da PRIMEIRA renderização do cliente (a que a hidratação compara),
 * porque nos dois casos nenhum efeito rodou ainda. Em jsdom `window` sempre
 * existe, então "renderizar como servidor" exige apagá-lo de propósito durante
 * a chamada — `renderToStaticMarkup` não toca em nenhuma API de DOM.
 *
 * ═══ SABOTAGEM QUE ESTE ARQUIVO JÁ REPROVOU ═══
 *
 * Voltar `useState<NotifyPrefs>(() => lerPrefs())` (o defeito de volta, com o
 * conserto no lugar): as duas asserções de igualdade ficam vermelhas — a
 * primeira passada do cliente passa a dizer `alerts-enable` enquanto o servidor
 * continua dizendo `alerts-toggle`.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationPrefsClient as NotificationPrefsClientType } from "./_client";
import type * as Prefs from "@/lib/notifications/prefs";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
// O assunto aqui é o store das preferências, não a permissão do navegador.
vi.mock("@/hooks/notifications/useNotificationPermission", () => ({
  useNotificationPermission: () => ({
    permission: "granted",
    enabled: true,
    request: async () => "granted",
    setEnabled: () => {},
  }),
}));

const pushClient = vi.hoisted(() => ({
  encerrarPushDesteAparelho: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => {}),
}));
vi.mock("@/lib/notifications/push_client", () => pushClient);

const CHAVE = "notify.prefs.v1";

let NotificationPrefsClient: typeof NotificationPrefsClientType;
let prefs: typeof Prefs;

beforeEach(async () => {
  window.localStorage.clear();
  // O cache do external store (`prefsEmCache`) mora no MÓDULO, não no
  // componente — é o que faz `getSnapshot` devolver sempre a mesma referência
  // sem reler o storage a cada render. Mas isso faria um teste vazar cache para
  // o de depois; `resetModules` + reimportar dá a cada `it` um módulo (e um
  // cache) genuinamente zerado, igual a uma aba nova.
  vi.resetModules();
  ({ NotificationPrefsClient } = await import("./_client"));
  prefs = await import("@/lib/notifications/prefs");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  pushClient.encerrarPushDesteAparelho.mockClear();
  pushClient.syncPushSubscription.mockClear();
});

/** O que o servidor Node (sem `window`) produz — `renderToStaticMarkup` nunca roda efeito. */
function renderizarComoServidor(): string {
  const janelaReal = globalThis.window;
  // @ts-expect-error — apagar de propósito para `typeof window === "undefined"` ser verdade.
  delete globalThis.window;
  try {
    return renderToStaticMarkup(<NotificationPrefsClient />);
  } finally {
    globalThis.window = janelaReal;
  }
}

/** O que a PRIMEIRA renderização do cliente produz — mesma chamada, `window` de verdade. */
function renderizarComoPrimeiraPassadaDoCliente(): string {
  return renderToStaticMarkup(<NotificationPrefsClient />);
}

function montar(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<NotificationPrefsClient />);
  });
  return container;
}

describe("as preferências de notificação não divergem entre o SSR e a primeira renderização do cliente", () => {
  it("com o push de mensagem desligado, a primeira passada do cliente bate com o servidor", () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));

    const doServidor = renderizarComoServidor();
    const doCliente = renderizarComoPrimeiraPassadaDoCliente();

    // Os dois precisam dizer "alerts-toggle" — é o que `getServerSnapshot`
    // devolve, e é o que a hidratação tem de bater ANTES de o React trocar
    // para `getSnapshot`, o valor real.
    expect(doServidor).toContain('data-testid="alerts-toggle"');
    expect(
      doCliente,
      "A primeira renderização do cliente leu o localStorage direto no " +
        "inicializador do useState, produzindo 'alerts-enable' — diferente do " +
        "que o servidor mandou ('alerts-toggle'). É o hydration mismatch.",
    ).toContain('data-testid="alerts-toggle"');
    expect(doCliente).toBe(doServidor);
  });

  it("com o interruptor legado `alerts.enabled=0`, a primeira passada do cliente também bate", () => {
    // `prefsPadrao()` consulta esta chave antes de qualquer outra: é um
    // SEGUNDO caminho para o mesmo `localStorage`, e o que passasse por um não
    // passaria necessariamente pelo outro.
    window.localStorage.setItem("alerts.enabled", "0");

    const doServidor = renderizarComoServidor();
    const doCliente = renderizarComoPrimeiraPassadaDoCliente();

    expect(doServidor).toContain('data-testid="alerts-toggle"');
    expect(doCliente).toBe(doServidor);
  });

  it("GUARDA DE VACUIDADE: depois do commit, a preferência real aparece", () => {
    // Sem este caso, os dois de cima passariam num componente que nunca lê o
    // localStorage — "sempre ligado" bateria com "sempre ligado" para sempre, e
    // o defeito oposto (a preferência do usuário nunca é aplicada) ficaria
    // invisível.
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));

    expect(montar().innerHTML).toContain('data-testid="alerts-enable"');
  });

  it("gravarCanal avisa os ouvintes: o interruptor reflete a troca sem recarregar", () => {
    const container = montar();
    expect(container.innerHTML).toContain('data-testid="alerts-toggle"');

    act(() => {
      prefs.gravarCanal("message", "push", false);
    });

    expect(container.innerHTML).toContain('data-testid="alerts-enable"');
  });
});

describe("o interruptor de Push de mensagem liga e desliga a inscrição do aparelho", () => {
  async function clicar(container: HTMLElement, rotulo: string) {
    const botao = container.querySelector(`[aria-label="${rotulo}"]`) as HTMLElement;
    await act(async () => {
      botao.click();
    });
  }

  it("desligar encerra o push deste aparelho", async () => {
    const container = montar();
    await clicar(container, "Nova mensagem via push");
    expect(pushClient.encerrarPushDesteAparelho).toHaveBeenCalledTimes(1);
    expect(pushClient.syncPushSubscription).not.toHaveBeenCalled();
  });

  it("religar com a permissão concedida reinscreve o aparelho", async () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();
    await clicar(container, "Nova mensagem via push");
    expect(pushClient.syncPushSubscription).toHaveBeenCalledTimes(1);
    expect(pushClient.encerrarPushDesteAparelho).not.toHaveBeenCalled();
  });

  it("outras categorias e o in-app não mexem na inscrição", async () => {
    const container = montar();
    await clicar(container, "Lead ganho via push");
    await clicar(container, "Nova mensagem via in_app");
    expect(pushClient.encerrarPushDesteAparelho).not.toHaveBeenCalled();
    expect(pushClient.syncPushSubscription).not.toHaveBeenCalled();
  });

  // A inscrição é do aparelho e o servidor não separa categorias: sem ela,
  // nenhum push chega. A tela não pode mostrar os outros como ligados.
  it("com o push de mensagem desligado, os outros pushes aparecem desligados e travados, com o porquê", () => {
    window.localStorage.setItem(CHAVE, JSON.stringify({ message: { in_app: true, push: false } }));
    const container = montar();
    const lead = container.querySelector('[aria-label="Lead ganho via push"]') as HTMLButtonElement;
    expect(lead.getAttribute("aria-checked")).toBe("false");
    expect(lead.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Desligar o push de mensagem desliga todos os avisos deste aparelho fora do app.",
    );
  });

  it("com o push de mensagem ligado, os outros pushes seguem a própria preferência (controle)", () => {
    const container = montar();
    const lead = container.querySelector('[aria-label="Lead ganho via push"]') as HTMLButtonElement;
    expect(lead.getAttribute("aria-checked")).toBe("true");
    expect(lead.disabled).toBe(false);
  });
});
