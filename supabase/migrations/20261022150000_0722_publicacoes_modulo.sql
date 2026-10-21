-- manifest: Módulo opcional de publicações (ADR-0002): agendar e publicar posts nas redes conectadas — provisionadora da tabela e do bucket, claim da fila e o aviso publicacao_falhou na Central
--
-- 0722 · Publicações nas redes sociais, como MÓDULO DE TABELA (ADR-0002).
--
-- ─── Por que módulo, e não núcleo ───────────────────────────────────────────
-- A régua da doutrina de extensões: se nenhuma organização ativar isto, a
-- operação comum continua inteira? Sim — atender, vender e acompanhar não
-- dependem de publicar posts. Então a tabela NÃO entra no baseline para todos:
-- ela nasce em `fn_publicacoes_provisionar()`, chamada só onde o administrador
-- da instalação instala o módulo (`fn_modulo_instalar('publicacoes', …)`).
--
-- ─── O que entra no baseline para todos ─────────────────────────────────────
-- Só FUNÇÕES, que compilam sem a tabela (D7: PL/pgSQL, nunca `language sql`
-- sobre tabela do módulo, nunca `%rowtype`):
--   fn_publicacoes_provisionar()        a casa do schema do módulo (D2/D4/D5);
--   fn_publicacoes_reivindicar(int, uuid[])  o claim da fila de publicação.
-- E o `kind` novo da Central, `publicacao_falhou`, porque o vocabulário do
-- aviso é do núcleo (a Central existe para todos) e o CHECK é um bloco único.
--
-- ─── A tabela ───────────────────────────────────────────────────────────────
-- `publicacoes_posts`: um post por linha, com a mídia em `midias` (jsonb, lista
-- de 1 a 10 caminhos no bucket privado `publicacoes`, que o servidor cria pela
-- API do Storage no primeiro upload — e que é só deste módulo: a retenção de
-- mídia de conversa varre órfão em `whatsapp-media`, e apagaria a mídia de um
-- post agendado). Não há FK para contacts
-- nem coluna de dado de pessoa: o post é da EMPRESA, não de um titular.
--
-- Ciclo de vida: rascunho → agendado → publicando → publicado | falhou;
-- cancelado a qualquer momento antes de publicar. Quem leva a `publicando` e
-- `publicado` é a rodada do servidor (service role); a sessão só escreve
-- rascunho, agendado e cancelado — a RLS por operação abaixo garante.
--
-- ─── Publicação em dobro é pior que não publicar ────────────────────────────
-- Um post que ficou em `publicando` (o processo morreu no meio) NÃO volta para a
-- fila: a Meta pode tê-lo publicado antes da queda. Ele vira `falhou` com o
-- motivo `interrompido_confira_no_instagram`, e a pessoa decide. Mesma régua do
-- `recover-stuck-messages`: reenvio em dobro é pior que não-envio.

-- ---- o kind novo da Central (bloco único da constraint, #159) ----
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice',
    'proposal_acceptance_rate_drop',
    'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    'task_due',
    'task_overdue',
    -- (migration 0722) Um post agendado não saiu: a rede recusou, a mídia não
    -- carregou ou a publicação foi interrompida. Sem isto a pessoa só descobria
    -- olhando o Instagram no dia seguinte.
    'publicacao_falhou',
    'other'
  ));

-- ---- a provisionadora do módulo ----
create or replace function public.fn_publicacoes_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create table if not exists public.publicacoes_posts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,

    -- A conta onde publicar. Conexão excluída não apaga o histórico do post.
    channel_session_id uuid references public.channel_sessions(id) on delete set null,

    -- `text` + CHECK, não enum (doutrina: enum é difícil de estender).
    formato text not null check (formato in ('imagem', 'video', 'carrossel', 'reel', 'story')),
    legenda text not null default '' check (char_length(legenda) <= 2200),

    -- Lista de { caminho, mime } no bucket privado `publicacoes`. O formato da
    -- entrada é do Zod central (`lib/publicacoes/esquema.ts`); aqui só a forma.
    midias jsonb not null default '[]'::jsonb,
    constraint publicacoes_posts_midias_lista check (
      jsonb_typeof(midias) = 'array' and jsonb_array_length(midias) between 1 and 10
    ),
    constraint publicacoes_posts_carrossel_tem_varias check (
      formato <> 'carrossel' or jsonb_array_length(midias) >= 2
    ),

    status text not null default 'rascunho'
      check (status in ('rascunho', 'agendado', 'publicando', 'publicado', 'falhou', 'cancelado')),
    agendado_para timestamptz,
    constraint publicacoes_posts_agendado_tem_hora check (status <> 'agendado' or agendado_para is not null),

    tentativas integer not null default 0 check (tentativas >= 0),
    proxima_tentativa_em timestamptz,
    ultimo_erro text,

    -- O container que a rede montou com a mídia (vídeo leva minutos para ficar
    -- pronto). Guardado para a rodada seguinte RETOMAR em vez de criar outro —
    -- criar container não publica nada; publicar é o passo seguinte.
    id_container text,
    -- O que a rede devolveu: o id da mídia publicada e o link público.
    id_externo text,
    link_publico text,
    publicado_em timestamptz,

    criado_por uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create index if not exists publicacoes_posts_org_idx
    on public.publicacoes_posts (organization_id, created_at desc);
  create index if not exists publicacoes_posts_fila_idx
    on public.publicacoes_posts (coalesce(proxima_tentativa_em, agendado_para))
    where status = 'agendado';

  -- ── RLS POR OPERAÇÃO (D5), no molde de honorários ──────────────────────────
  --   SELECT  qualquer papel da organização (a tela lista para todos);
  --   INSERT  `manager`: publicar fala pela marca em público;
  --   UPDATE  `manager`, e só nos estados da PESSOA — a sessão não escreve
  --           `publicando`/`publicado` nem mexe em post já publicado (quem
  --           escreve esses estados é a rodada do servidor);
  --   DELETE  `manager`, e post publicado ou publicando não se apaga.
  -- A conta escolhida tem de ser da MESMA organização (a FK só confere que a
  -- conexão existe).
  alter table public.publicacoes_posts enable row level security;

  drop policy if exists publicacoes_posts_select on public.publicacoes_posts;
  create policy publicacoes_posts_select
    on public.publicacoes_posts
    for select using (
      organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
    );

  drop policy if exists publicacoes_posts_insert on public.publicacoes_posts;
  create policy publicacoes_posts_insert
    on public.publicacoes_posts
    for insert
    with check ((public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'manager')))
                and status in ('rascunho', 'agendado')
                and (channel_session_id is null
                     or exists (select 1 from public.channel_sessions cs
                                 where cs.id = channel_session_id
                                   and cs.organization_id = publicacoes_posts.organization_id)));

  drop policy if exists publicacoes_posts_update on public.publicacoes_posts;
  create policy publicacoes_posts_update
    on public.publicacoes_posts
    for update
    using ((public.fn_is_platform_admin_full()
            or (organization_id in (select public.fn_user_org_ids())
                and public.fn_role_at_least(organization_id, 'manager')))
           and status not in ('publicando', 'publicado'))
    with check ((public.fn_is_platform_admin_full()
                 or (organization_id in (select public.fn_user_org_ids())
                     and public.fn_role_at_least(organization_id, 'manager')))
                and status in ('rascunho', 'agendado', 'cancelado')
                and (channel_session_id is null
                     or exists (select 1 from public.channel_sessions cs
                                 where cs.id = channel_session_id
                                   and cs.organization_id = publicacoes_posts.organization_id)));

  drop policy if exists publicacoes_posts_delete on public.publicacoes_posts;
  create policy publicacoes_posts_delete
    on public.publicacoes_posts
    for delete
    using ((public.fn_is_platform_admin_full()
            or (organization_id in (select public.fn_user_org_ids())
                and public.fn_role_at_least(organization_id, 'manager')))
           and status not in ('publicando', 'publicado'));
  revoke all on public.publicacoes_posts from anon;

  comment on table public.publicacoes_posts is
    'Posts agendados e publicados nas redes conectadas (módulo publicacoes, ADR-0002). A mídia mora no bucket privado publicacoes; a rede recebe URL assinada na hora de publicar.';

  -- O bucket `publicacoes` NÃO nasce aqui: a provisionadora só escreve nas
  -- tabelas do próprio módulo (molde da ADR-0002). Quem o garante é o servidor,
  -- pela API do Storage, no primeiro upload (`lib/publicacoes/armazenamento.ts`).

  perform public.fn_proteger_modulo_provisionado();
end;
$f$;

revoke execute on function public.fn_publicacoes_provisionar() from public, anon, authenticated;
grant execute on function public.fn_publicacoes_provisionar() to service_role;

-- ---- o claim da fila de publicação ----
-- D7: compila sem a tabela (PL/pgSQL; a tabela só é tocada em tempo de
-- execução, e a ausência dela — módulo não instalado — devolve vazio).
-- `p_pular` são as organizações paradas, resolvidas pela régua do app
-- (`idsDeOrgsParadas`): organização suspensa não publica em nome de ninguém.
create or replace function public.fn_publicacoes_reivindicar(p_limite integer, p_pular uuid[])
returns table (post_id uuid, org_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  if to_regclass('public.publicacoes_posts') is null then
    return;
  end if;

  -- Interrompido no meio NÃO volta à fila: a rede pode ter publicado antes da
  -- queda, e publicar em dobro é pior que não publicar (ver cabeçalho da 0722).
  -- E avisa na Central, como toda falha da fila: sem o aviso, o post sumiria
  -- da agenda em silêncio.
  with presos as (
    update public.publicacoes_posts p
       set status = 'falhou',
           ultimo_erro = 'interrompido_confira_no_instagram',
           updated_at = now()
     where p.status = 'publicando'
       and p.updated_at < now() - interval '15 minutes'
    returning p.organization_id
  )
  insert into public.agent_inbox_items (organization_id, kind, severity, title, body)
  select distinct pr.organization_id, 'publicacao_falhou', 'warn',
         'Uma publicação agendada não saiu',
         'A publicação foi interrompida no meio e pode ter saído ou não. Confira no perfil antes de agendar de novo — nada foi republicado automaticamente.'
    from presos pr;

  return query
  with alvo as (
    select p.id
      from public.publicacoes_posts p
     where p.status = 'agendado'
       and coalesce(p.proxima_tentativa_em, p.agendado_para) <= now()
       and not (p.organization_id = any (coalesce(p_pular, '{}'::uuid[])))
     order by coalesce(p.proxima_tentativa_em, p.agendado_para)
     limit greatest(1, least(coalesce(p_limite, 5), 50))
     for update skip locked
  )
  update public.publicacoes_posts p
     set status = 'publicando',
         tentativas = p.tentativas + 1,
         updated_at = now()
    from alvo
   where p.id = alvo.id
  returning p.id, p.organization_id;
end;
$f$;

revoke execute on function public.fn_publicacoes_reivindicar(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.fn_publicacoes_reivindicar(integer, uuid[]) to service_role;

notify pgrst, 'reload schema';
