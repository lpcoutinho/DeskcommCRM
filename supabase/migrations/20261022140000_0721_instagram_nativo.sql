-- manifest: Canal de Instagram nativo pela API da Meta (provider meta_social) — conta, token cifrado e validade na sessão, no CHECK do provider e no arquivo do webhook
--
-- 0721 · Instagram nativo (Graph API com login do Instagram), sem intermediário.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um provider de canal de mensagem novo, `meta_social`, para as redes da Meta
-- que NÃO são WhatsApp. Hoje só o Instagram; o Messenger entra depois pelo
-- MESMO provider, porque o que o canal permite (janela de 24h, sem modelos,
-- sem grupos) é igual nas duas redes — muda o transporte, não a capability.
-- A rede da conexão fica em `metadata.social_platform`, a mesma chave do canal
-- social intermediado, que é o que a apresentação já lê.
--
-- Cada instalação usa o PRÓPRIO App Meta. A credencial é por organização,
-- colada pela tela:
--
--   meta_social_account_id      id da conta profissional (o `entry.id` do
--                               webhook e o remetente dos envios). É o sessionRef.
--   meta_social_token_encrypted token de acesso, cifrado por fn_encrypt_oauth.
--   meta_social_token_expires_at validade conhecida do token; NULL = ainda não
--                               sabida (o token recém-gerado não pode ser
--                               renovado nas primeiras 24h, e é a renovação que
--                               informa a validade).
--
-- O segredo do app (que assina o webhook) mora na coluna que já existe para
-- isso, `webhook_secret_encrypted` — guardar em outra coluna seria a mesma
-- credencial em dois lugares.
--
-- ─── Por que recriar os CHECKs inteiros ─────────────────────────────────────
-- Mesmo desenho da 0387: `channel_sessions_provider_check` é o vocabulário
-- fechado e `channel_sessions_provider_ref_check` exige a coluna do provider da
-- vez NOT NULL. `webhook_events_log_provider_check` entra junto porque a rota
-- genérica arquiva o corpo cru com o provider da sessão ANTES de conferir a
-- assinatura. Alargamento puro nos três: nenhuma linha que passava deixa de passar.
--
-- ─── Índice único entre ativos ──────────────────────────────────────────────
-- A conta é identificador da Meta: duas organizações (ou duas linhas ativas)
-- com a mesma conta fariam a busca da credencial devolver duas linhas. A dedup
-- com sufixo `-conflito-<id>` torna a primeira passada idempotente.

alter table public.channel_sessions
  add column if not exists meta_social_account_id text,
  add column if not exists meta_social_token_encrypted bytea,
  add column if not exists meta_social_token_expires_at timestamptz;

comment on column public.channel_sessions.meta_social_account_id is
  'Id da conta profissional na Meta (Instagram) — o entry.id do webhook. É o sessionRef deste canal. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.meta_social_token_encrypted is
  'Token de acesso da conta, cifrado por fn_encrypt_oauth. Nunca volta à tela depois de gravado.';
comment on column public.channel_sessions.meta_social_token_expires_at is
  'Validade conhecida do token. NULL = ainda não sabida; a renovação diária a preenche.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'meta_social'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'meta_social' and meta_social_account_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy',
    'stripe', 'asaas',
    'meta_social'
  ));

with ativos as (
  select id,
         row_number() over (
           partition by meta_social_account_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and meta_social_account_id is not null
)
update public.channel_sessions s
   set meta_social_account_id = s.meta_social_account_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_meta_social_account_id_ativo_unique
  on public.channel_sessions (meta_social_account_id)
  where archived_at is null and meta_social_account_id is not null;

notify pgrst, 'reload schema';
