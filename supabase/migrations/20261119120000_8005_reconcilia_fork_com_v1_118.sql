-- manifest: **Reconcilia o fork com a v1.118.0 do original.** Migrations do original posteriores à 8004 recriaram objetos sem o que o fork acrescentou: a 9240 recriou `emit_event` sem a reserva de `comment.received`; a 9243 recriou `fn_lgpd_cascade_redact_contact` sem a redação de `social_comments`; a 9327, a 9333 e a 9397 reconstruíram `agent_inbox_items_kind_check` sem `publicacao_falhou`; e a 9342 e a 9418 reconstruíram `channel_sessions_provider_check`, `channel_sessions_provider_ref_check` e `webhook_events_log_provider_check` sem `meta_social`. Esta devolve o que é do fork sobre as versões finais do original, as mesmas do apêndice do `supabase/baseline.sql`. Alargamento puro nos CHECKs (aceitam mais valores, nenhuma linha que passava deixa de passar). Idempotente. Prova em `tests/invariants/fork-reconciliacao-8005.test.ts`.
--
-- 8005 · Exclusiva do fork. O bloco 8xxx é reservado ao fork para não colidir com a numeração do
-- original (0xxx e 9xxx). Sucede a 8004. Na próxima sincronização, confira se migration nova do
-- original recriou um destes objetos: se recriou, esta precisa de sucessora com timestamp posterior.


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
    -- (migration 0109, issue #129) Mensagem outbound nasce `sending` e, quando o
    -- envio nunca acontece, fica `sending` para sempre — o self-hoster vê uma
    -- mensagem eternamente "enviando", sinal de progresso para algo que não vai
    -- acontecer. O cron `recover-stuck-messages` marca `failed` e usa este kind
    -- para o defeito APARECER na Central de avisos.
    --
    -- Entra NESTA lista, e não num bloco novo no fim do arquivo: o #159 do @jmpo
    -- mostrou que reconstruir a mesma constraint em N blocos quebra o
    -- `update.sh` de todo clone que já tenha uma linha de vocabulário posterior
    -- — os blocos antigos rodam antes e falham em cadeia. Um bloco por
    -- constraint, vigiado por tests/unit/baseline-constraint-reconstruida.test.ts.
    'message_send_stuck',
    -- (migration 0129) O cliente manda foto/áudio e o agente age como se nada
    -- tivesse chegado. Acontece quando o modelo configurado não enxerga imagem,
    -- ou quando falta a chave de transcrição — e antes disto a derivação
    -- devolvia string vazia EM SILÊNCIO: nenhum erro, nenhum log, e o operador
    -- concluindo que o agente ignorou o cliente de propósito.
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    -- (migration 0111, spec 16 §3.2) O papel Operador declara promessa em aberto:
    -- o assistente prometeu algo ao cliente e o cumprimento não foi registrado.
    -- A invariante sagrada da spec é "nenhuma promessa deixa de ser cumprida", e
    -- uma promessa sem dono precisa aparecer onde o humano olha — não no log do
    -- worker. Entra NESTA lista pela mesma razão que a de cima.
    'promise_unfulfilled',
    -- (migration 0124, spec 17 §4b) Dado que o assistente ouviu na conversa e
    -- ninguém confirmou até o prazo. `info`, não `warn`: nada quebrou — uma
    -- informação não foi aproveitada, e tratar isso como falha ensinaria a
    -- ignorar os avisos que são falha de verdade. Entra NESTA lista pela mesma
    -- razão das de cima (bloco único por constraint, #159).
    'contact_proposal_expired',
    -- (migration 0159) O gasto passou do aviso que a pessoa definiu e a IA
    -- CONTINUA respondendo — `warn`, nunca `critical`, e um kind SEPARADO de
    -- `budget_exceeded`: colapsar os dois faria o alerta de "parou" perder o
    -- significado. É este kind que torna possível a condição do gate "ninguém é
    -- bloqueado sem ter sido avisado no mês" — sem ele, o salto de 79% para 101%
    -- entre duas chamadas calaria a IA sem nenhum sinal anterior.
    --
    -- Entra NESTA lista, e AQUI no fim, por duas razões distintas: bloco único
    -- por constraint (#159), e porque `tests/unit/midia-nao-lida.test.ts` procura
    -- `'midia_nao_lida'` nos primeiros 2000 caracteres a partir do `add
    -- constraint` — um valor comentado inserido ACIMA dele empurra-o para fora da
    -- janela e reprova um teste que não tem nada a ver com o kind novo (medido:
    -- offset 1532 -> 2275). Kind novo entra no fim da lista.
    'budget_warning',
    -- (migration 0181) O material que a pessoa enviou não entrou na base: falta
    -- chave de embedding, a extração do arquivo falhou, ou nenhum trecho foi
    -- gravado. Antes disto o worker devolvia `skipped` para o próprio log, o drain
    -- tratava `skipped` como sucesso, e a linha da fonte seguia dizendo `ready`.
    -- Irmão direto de `midia_nao_lida`: mesma chave, mesmo silêncio.
    'conhecimento_nao_indexado',
    -- (migration 0206, spec 18) Chamada de voz WhatsApp (WaCalls) recebida que
    -- nunca teve answered_at — o "chamou e ninguém atendeu" precisa de dono,
    -- mesma razão de midia_nao_lida/conhecimento_nao_indexado. Entra NESTA
    -- lista, não em bloco novo (#159, bloco único por constraint).
    'voice_call_missed',
    'case_stale',
    -- (migration 0292) O aviso de caso não chegou ao WhatsApp da equipe,
    -- em definitivo. Nasce com `ref_kind='agent_case'` para levar AO CASO —
    -- que continua esperando — e não a uma tela genérica. A fonte da verdade
    -- sobre "o aviso saiu?" continua sendo `entregas_de_aviso_de_caso`:
    -- qualquer membro apaga um item da Central pelo PostgREST hoje.
    'aviso_de_caso_nao_entregue',
    -- (migration 0312) O fluxo de follow-up publicado que NUNCA vai disparar:
    -- gatilho automático (silêncio, etapa, caso, falta) só cria inscrição se
    -- algum agente publicado arma o ponteiro, e sem esse vínculo os produtores
    -- saem por `pointers_armados = 0` em silêncio — `active` na tela, morto no
    -- motor. Entra NESTA lista e no FIM dela, pelas duas razões de sempre
    -- (bloco único por constraint, #159; e a janela de 2000 caracteres que
    -- `tests/unit/midia-nao-lida.test.ts` varre a partir do `add constraint`).
    'followup_sem_agente',
    -- (migration 0339, doc 11 decisão B) O canal de WhatsApp em modo de teste
    -- SEM número autorizado não responde a ninguém — e o esquecimento é o
    -- defeito: as mensagens chegam no Inbox e a IA nunca fala, então quem
    -- instalou conclui que o produto está quebrado. O cron canal-mudo-watcher
    -- abre este aviso depois de 3 dias e o FECHA quando deixa de valer.
    --
    -- Entra NESTA lista, e não num bloco novo no fim do arquivo: reconstruir a
    -- mesma constraint em N blocos quebra o `update.sh` de todo clone com
    -- vocabulário posterior (lição do #159).
    'canal_mudo_sem_numero',
    -- (migration 0464) a proposta comercial: vencimento sem decisão, queda da taxa
    -- de aceite e promessa de proposta que não virou proposta.
    'proposal_expired_notice', 'proposal_acceptance_rate_drop', 'proposal_promised_not_created',
    -- (migration 0466, D3) proposta presa em 'enviando' há mais de 5min — o
    -- mesmo padrão do 'message_send_stuck', cron próprio (proposta-travada).
    'proposta_travada',
    -- (migration 0475) a IA rascunhou uma proposta e falta confirmar o modelo
    -- sugerido (plano N1) ou falta preço de catálogo — a Central acompanha
    -- até as duas pendências sumirem, ou até a proposta ser enviada/descartada.
    'proposta_pronta_para_revisao',
    -- (migration 0501) a organização voltou de uma suspensão e há conversas que
    -- receberam mensagem enquanto ela estava parada: a IA não respondeu nem vai
    -- responder sozinha. Um item por reativação, aberto por fn_reativar_organizacao.
    'org_reativada',
    -- (migration 0500) O Jev percebeu, numa mensagem em que a regra de hoje não
    -- viu nada, um pedido para falar com uma pessoa ou para parar de receber
    -- mensagens, e a empresa escolheu "Avisar a equipe". Um kind por pedido, e
    -- não `other`: a Central dá rótulo e destino por kind, e o `other` não leva
    -- a uma conversa (lib/ai/inbox-destino.ts); e o aviso é um por CONVERSA e
    -- pedido. O Jev só abre o aviso — quem passa a conversa é a regra de hoje
    -- ou uma pessoa, e quem bloqueia é só o STOP do próprio cliente. NESTA
    -- lista pelas razões de sempre (#159; a janela do `midia-nao-lida.test.ts`).
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    -- (migration 0589, issue #2389) A pausa de uma conexão era silenciosa para
    -- todo mundo menos para quem clicou. O audit registrava `channel.disabled`
    -- / `channel.enabled`, mas audit é histórico para quem procura, não
    -- comunicação — a Central é onde a operação inteira olha. O item nasce na
    -- pausa e se resolve sozinho na retomada ou no arquivamento, com o motivo
    -- no corpo (laço do canal-mudo-watcher, só que instantâneo).
    'canal_pausado',
    -- (migration 0601) a cobrança do revendedor fala com a empresa: os avisos
    -- da régua (teste acabando, venceu, suspende em breve, suspensa) nascem sem
    -- referência, e o de 80% do teto de IA do plano nasce com ref_kind plano. Os
    -- dois abrem Configurações › Plano e cobrança, só para quem administra.
    'cobranca',
    -- (migration 0614) o admin da plataforma trocou o e-mail de login de uma
    -- pessoa da equipe (PATCH .../members/[userId]/email): a empresa fica
    -- sabendo pela Central — com o nome e a data, nunca o endereço.
    'email_de_login_trocado',
    -- (migration 0655, issue #2529) A tarefa vencida só aparecia em vermelho
    -- para quem ABRIA a lista de tarefas: quem não abria perdia o prazo em
    -- silêncio. O cron `task-reminder` varre `crm_tasks` com prazo na janela e
    -- nasce com estes DOIS kinds — um por momento, e não um genérico: a
    -- Central dá rótulo e destino por kind, e "tarefa perto do vencimento" e
    -- "tarefa venceu sem conclusão" pedem leituras diferentes de quem abre.
    -- Nascem com `ref_kind='task'`, levando à lista de tarefas. Entra NESTA
    -- lista pelas razões de sempre (bloco único por constraint, #159).
    'task_due',
    'task_overdue',
    -- (migration 8002) Um post agendado do módulo de publicações não saiu: a
    -- rede recusou, a mídia não carregou ou a publicação foi interrompida.
    -- Entra NESTA lista pelas razões de sempre (bloco único por constraint, #159).
    'publicacao_falhou',
    -- (Spec 32) A volta de uma queda do número recupera sozinha as conversas do
    -- período, só de quem tem ficha. `recuperacao_da_queda` é o resumo para o
    -- administrador (ref_kind='channel_session', um aberto por conexão);
    -- `cliente_sem_resposta_na_queda` aponta a conversa cuja última mensagem
    -- recuperada é do cliente sem resposta (ref_kind='conversation', um aberto
    -- por conversa). Cada um com índice único parcial próprio, no apêndice da
    -- migration 9033. Entram NESTA lista (bloco único por constraint, #159).
    'recuperacao_da_queda',
    'cliente_sem_resposta_na_queda',
    -- (migration 9027, issue #3371) A conta da assinatura do ChatGPT morreu em
    -- silêncio no cliente Obralivre: `401 · Provided authentication token is
    -- expired` em 107 turnos, ~26 h sem a IA responder. Entra NESTA lista pelas
    -- razões de sempre (#159, bloco único por constraint) e o item nasce SEM
    -- referência: o destino é a tela de Credenciais, para quem administra.
    'assinatura_desconectada',
    -- (migration 9327, issue #3635) A revisão do modelo no canal OFICIAL DIRETO
    -- só virava linha em `meta_templates`: quem conecta direto pela Cloud API
    -- descobria a reprovação no disparo que não saiu. Kind próprio, e não o
    -- `channel_template_review` do parceiro, porque o destino e o rótulo daquele
    -- apontam para a aba do parceiro. Nasce com `ref_kind='channel_session'`,
    -- um aberto por conexão. Entra NESTA lista (#159, bloco único).
    'channel_template_review_direct',
    -- (migration 9333, issue #3966) O número pediu para esperar a IA qualificar
    -- antes de distribuir e o prazo venceu sem a IA passar a conversa. A conversa
    -- entra na distribuição e este aviso conta a quem cuida do agente que ele
    -- não está passando adiante. Entra NESTA lista (#159, bloco único).
    'routing_ia_wait_expired',
    -- (migration 9397, issue #4696) O retorno COMBINADO com o cliente que não
    -- vai sair: o atendimento mudou antes do disparo e o job `followup_turn` foi
    -- descartado por `service_boundary_stale`. O descarte está certo; o silêncio
    -- não estava — 11 em 17 dias, um deles com o cliente esperando um contato
    -- que nunca sairia. Nasce com `ref_kind='conversation'` (destino clicável) e
    -- dedup por (kind, conversa). Entra NESTA lista (#159, bloco único).
    'followup_descartado',
    'other'
  ));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  -- 'wacalls' (0233), 'zernio_social' (0368), 'datafy' (0387), 'telegram'
  -- (9342) e 'meta_social' (8001) somados AQUI — UM bloco só por constraint
  -- (não duplicar drop+add por migration).
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'wacalls'::text, 'zernio_social'::text, 'datafy'::text, 'telegram'::text, 'meta_social'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    -- 'zernio_social' (migration 0368) endereça pelo MESMO `zernio_account_id`:
    -- é o mesmo intermediário, com outra superfície de canal.
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null) or
    -- Bot do Telegram (migration 9342): endereça pelo id do robô.
    (provider = 'telegram'   and telegram_bot_id      is not null) or
    (provider = 'meta_social' and meta_social_account_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy',
    -- (migration 0601) os provedores de cobrança do revendedor. A linha deles
    -- nasce com organization_id nulo e corpo {id,type}: é ponteiro, nunca o
    -- corpo do provedor, e fica invisível ao tenant pela própria policy.
    -- (migration 9418) o Efi Bank entra no mesmo encaixe (issue #4056).
    'stripe', 'asaas', 'efi',
    -- (migration 9342, #3486) o robô do Telegram. Sem ele aqui, todo update do
    -- robô logava "não consegui abrir a linha" e o corpo cru não era guardado
    -- (medido na prova de tela). O corpo do update não carrega o token.
    'telegram',
    -- (migration 8001) Instagram nativo pela API da Meta.
    'meta_social'
  ));

CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_contact uuid;
  v_origin jsonb;
begin
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  -- `ai.case_opened`/`ai.case_closed` entram pela mesma razão (0279): o caso é
  -- do motor, e um evento de caso forjado por login move o funil e acorda o
  -- agente em nome de uma decisão que ninguém tomou.
  -- `contact.birthday` entra pela 0551: só o cron (`contact-birthdays`, sem
  -- sessão) o emite, e a partir desta migration ele alcança a origem e manda
  -- WhatsApp de verdade — forjado por login, seria envio em nome de um
  -- aniversário que ninguém fez.
  -- `contact.phone_added` entra pela 0670, pela mesma razão do aniversário:
  -- quem o emite é o servidor (o PATCH de contatos, com a chave de serviço,
  -- depois de gravar o número), e ele alcança a origem e manda WhatsApp.
  -- `lead.date_field_due` entra pela 0743, como o aniversário: quem o emite é
  -- só o cron `lead-date-field-due` (sem sessão), e a partir dela ele alcança a
  -- origem e manda WhatsApp.
  -- `lead.stage_stale` entra pela 9206, pela mesma razão do gatilho de data do
  -- funil: quem o emite é só a varredura `lead-time-triggers` (sem sessão), e
  -- a partir dela ele alcança a origem e manda WhatsApp — forjado por login,
  -- seria envio em nome de uma etapa que ninguém parou.
  -- `comment.received` entra pela 8003: nasce só do INSERT em `social_comments`
  -- (a ingestão do webhook), e a regra que ele acorda responde em público e
  -- manda DM. Forjado por login, seria resposta a um comentário que não chegou.
  -- Revogação do turno é fato da tomada nativa, nunca um pedido do login.
  -- `conversation.closed` entra pela 9212: quem o emite é o gatilho do
  -- encerramento (o servidor), e a partir dele uma automação reage ao
  -- atendimento encerrado e manda mensagem ao cliente — forjado por login,
  -- seria mensagem em nome de um encerramento que ninguém fez.
  -- `ai.case_updated` entra pela 9240: quem o emite é o servidor, na mesma
  -- transação da resposta do cliente, e ele manda WhatsApp à equipe com um
  -- comando preso àquela atualização — forjado por login, seria um ciclo de
  -- atendimento que ninguém abriu.
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','ai.case_updated','contact.birthday','contact.phone_added',
    'lead.date_field_due','lead.stage_stale','conversation.autonomous_turn_revoked',
    'conversation.closed','comment.received'
  ) then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Desfecho e responsável do negócio só nascem do gatilho de `crm_leads`
  -- (`fn_emit_event_on_lead_change`), quando a linha muda de fato. Nenhum
  -- emissor do app os pede por RPC; os consumidores produzem efeito real
  -- (push, webhook de saída, conversão de anúncio).
  if auth.uid() is not null
     and p_event_type in ('lead.won','lead.lost','lead.reopened','lead.assigned')
     and coalesce(current_setting('deskcomm.desfecho_pelo_negocio', true), '') <> 'on' then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Estes campos autorizam efeitos operacionais; não são payload público.
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  -- A ORIGEM E RESERVADA AO SERVIDOR — ENTAO O SERVIDOR TEM DE ESCREVE-LA.
  --
  -- O bloco acima recusa `service_origin` vindo de chamador autenticado (42501,
  -- e com razao: e o campo que AUTORIZA efeito operacional, nao payload
  -- publico). So que ninguem o escrevia no lugar dele. Efeito medido: quem move
  -- o negocio pela IA carimba a origem no servidor (`agent-stage-sync`,
  -- `appointment-stage-move`, `handoff-stage-move`) e o follow-up nasce; quem
  -- move PELO QUADRO — o operador, pela rota HTTP autenticada — emitia um
  -- evento SEM origem, `fn_service_event_origin` caia no `service_stale` final
  -- (40001), `serviceForEvent` engolia como `stale_origin` e o follow-up nunca
  -- nascia. Sem erro em lugar nenhum: o gatilho de etapa era inalcancavel pelo
  -- caminho que o produto oferece na tela.
  --
  -- O retrato e tirado AQUI, no instante da emissao, que e exatamente a
  -- semantica de procedencia que a 0223 quer: "quando este evento nasceu, o
  -- atendimento estava assim". A resolucao do contato vem da mesma tabela de
  -- `fn_service_event_contact` — se ela nao souber resolver o tipo, nao ha o que
  -- carimbar e o evento segue sem origem, como antes.
  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    select f.contact_id into v_contact
      from public.fn_service_event_contact(v_org_id, p_event_type, p_entity_kind, p_entity_id) f;
    if v_contact is not null
       and exists(select 1 from public.contacts
                   where organization_id=v_org_id and id=v_contact
                     and not is_anonymized and is_merged_into is null) then
      v_origin := jsonb_build_object('kind','command',
        'observed', public.fn_service_observe_command(v_org_id, v_contact));
    end if;
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb)
       || case when v_origin is null then '{}'::jsonb else jsonb_build_object('service_origin', v_origin) end,
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;

revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public, anon;
grant  execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

create or replace function public.fn_lgpd_cascade_redact_contact(p_organization_id uuid, p_contact_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'extensions', 'pg_temp'
    as $$
declare
  v_identidade_social text;
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
  v_variantes text[] := '{}';
  v_secao record;
  v_secoes jsonb := '{}'::jsonb;
  -- (9243)
  v_fundida_em uuid;
  v_avatar text;
  v_absorvida uuid;
  v_leads uuid[];
  v_absorvidas int := 0;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized, is_merged_into, avatar_storage_path
    into v_already, v_fundida_em, v_avatar
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  -- O rótulo NÃO deriva mais do id (issue #2342): `fn_lgpd_rotulo_anonimizado`
  -- gera um sufixo OPACO (aleatório, gravado no passo 1 abaixo). Antes, o
  -- sufixo eram os 8 primeiros caracteres do uuid do contato — quem tem o
  -- banco casava `Cliente Anonimizado #7a5f0011` com a linha `7a5f0011-…` e
  -- reidentificava o titular pelo próprio rótulo (pseudonimização, não
  -- anonimização: RGPD considerando 26, LGPD art. 12 e art. 13 §4).
  v_anon_label := public.fn_lgpd_rotulo_anonimizado(p_contact_id);

  -- Seções de módulo (D8, 0485): a redação delas é do gatilho
  -- `trg_lgpd_secoes_de_modulo`, que não devolve contagem — mas a contagem é
  -- EVIDÊNCIA (vai para `cascaded_to` no audit e no retorno). Uma chave por
  -- seção declarada, com o nome da tabela, contando pela MESMA `ligacao` do
  -- gatilho ($1 = organização, $2 = contato). Conta ANTES do passo 1 (que
  -- dispara o gatilho): a seção que soltar a própria ligação seguiria contada.
  -- Sem o módulo a tabela não existe e a chave não aparece. Seção com ligação
  -- vazia não é contada: o erro nomeado (`modulo_secao_invalida`) é do gatilho.
  for v_secao in
    select tabela, ligacao from public.modulo_secoes_lgpd order by modulo, tabela
  loop
    if to_regclass(format('public.%I', v_secao.tabela)) is not null
       and btrim(v_secao.ligacao) <> '' then
      execute format('select count(*) from public.%I where (%s)', v_secao.tabela, v_secao.ligacao)
        into v_count using p_organization_id, p_contact_id;
      v_secoes := v_secoes || jsonb_build_object(v_secao.tabela, v_count);
    end if;
  end loop;

  -- A identidade social é lida ANTES do passo 1: a virada de `is_anonymized`
  -- dispara o gatilho que a anula, e é ela que alcança os comentários (8003).
  select social_identity into v_identidade_social
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  -- (9043) As variantes do principal E dos telefones extras, lidas ANTES de
  -- apagar os extras (passo 1b): o candidato da prospecção casado pelo número
  -- extra também é da pessoa que pediu para ser esquecida.
  select coalesce(array_agg(distinct v), '{}')
    into v_variantes
    from (
      select unnest(public.fn_telefone_variantes(c.phone_number)) as v
        from contacts c
       where c.id = p_contact_id and c.organization_id = p_organization_id
      union all
      select unnest(public.fn_telefone_variantes(t.phone_number))
        from contact_phones t
       where t.contact_id = p_contact_id and t.organization_id = p_organization_id
    ) as todas;

  -- O arquivo da mensagem mora sob a organização dela: as outras formas não entram
  -- na fila (9243), como no passo 6d.
  select coalesce(array_agg(distinct media_storage_path) filter (
           where media_storage_path like p_organization_id::text || '/%'), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 0b. a foto de perfil (9243). A fila antes do ponteiro: sem a linha, o arquivo
  -- ficaria no bucket sem ninguém capaz de achá-lo. O caminho é estável por
  -- contato, então a linha terminal de um pedido anterior é reaberta. Só o caminho
  -- exato que o cron grava entra na fila.
  if v_avatar = p_organization_id::text || '/avatars/' || p_contact_id::text || '.jpg' then
    perform public.fn_fila_de_remocao_de_arquivo(p_organization_id, p_request_id, 'whatsapp-media', v_avatar);
  end if;

  -- 1. contacts (irreversible)
  update contacts set
    avatar_storage_path = null,
    avatar_updated_at = case when v_avatar is null then avatar_updated_at else now() end,
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    phone_number = null,
    phone_type = null,
    phone_whatsapp = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 1b. contact_phones (9043) — os telefones extras, com o `lid` de cada um.
  -- Depois do passo 1: o gatilho de redação das mensagens de grupo, que roda
  -- no `update` acima, ainda precisava lê-los.
  delete from contact_phones
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_phones', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    -- `external_id` guarda o TELEFONE do titular (número no inbound, id do
    -- provider no outbound) e sobrevivia legível na linha que RESTA da
    -- anonimização — a última PII viva do pedido de exclusão. Zerar não quebra
    -- nada que dependa da coluna: o unique (organization_id, external_id)
    -- trata NULL como distinto de todo NULL, a citação (`reply_to_message_id`)
    -- aponta para o id da linha e não para o `external_id`, e o eco do provider
    -- só deduplica mensagem ainda em voo — pedido de exclusão não manda nada.
    external_id = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);
  -- 5a. crm_lead_attachments (9243) — só no negócio de que o contato é o titular
  -- (`crm_leads.contact_id`): o arquivo vai para a fila e a linha sai. O negócio só
  -- ligado pela `crm_lead_links` tem outro titular e mantém os anexos, contados em
  -- `crm_lead_attachments_mantidos`. `crm_lead_attachments_storage_path_check` prende
  -- o caminho à organização e ao negócio da linha, então aqui não há outra forma a
  -- conferir.
  select coalesce(array_agg(l.id), '{}') into v_leads
    from crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contact_id;
  perform public.fn_fila_de_remocao_de_arquivo(p_organization_id, p_request_id, 'internal-media', a.storage_path)
    from crm_lead_attachments a
   where a.organization_id = p_organization_id
     and a.lead_id = any (v_leads);
  delete from crm_lead_attachments a
   where a.organization_id = p_organization_id
     and a.lead_id = any (v_leads);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('crm_lead_attachments', v_count);
  select count(distinct a.id) into v_count
    from crm_lead_attachments a
    join crm_lead_links k on k.lead_id = a.lead_id and k.organization_id = a.organization_id
   where a.organization_id = p_organization_id
     and k.target_kind = 'contact'
     and k.target_id = p_contact_id;
  v_counts := v_counts || jsonb_build_object('crm_lead_attachments_mantidos', v_count);

  -- 5b. lead_field_proposals (0772, #3316) — a proposta de campo que a IA leu
  -- num DOCUMENTO (voucher, bilhete, apólice). `trecho` é o texto do documento
  -- sobre a PESSOA e os dois valores são o dado que a IA extraiu: o MESMO
  -- tratamento do `custom_fields` do próprio negócio (passo 5) — campo, status
  -- e decisão PERMANECEM (a fila continua explicável), o conteúdo identificável
  -- sai. Alcança pelo vínculo do negócio com o contato (direto ou pela
  -- `crm_lead_links`), como os passos 4 e 5.
  -- Gate: tests/invariants/cascata-lgpd-nao-encolhe.test.ts (catraca da lista).
  update lead_field_proposals set
    trecho = v_anon_label,
    valor_proposto = null,
    valor_anterior = null,
    motivo_recusa = null,
    updated_at = now()
  where organization_id = p_organization_id
    and (
      lead_id in (
        select id from crm_leads
         where organization_id = p_organization_id
           and contact_id = p_contact_id
      )
      or lead_id in (
        select lead_id from crm_lead_links
         where target_kind = 'contact'
           and target_id = p_contact_id
           and organization_id = p_organization_id
      )
    )
    -- Redação IDEMPOTENTE: a segunda anonimização não deve contar linha de novo
    -- (o `already_anonymized` já barra, mas a condição também protege o rerun
    -- parcial que a 0414 permite).
    and (trecho is distinct from v_anon_label
         or valor_proposto is not null
         or valor_anterior is not null
         or motivo_recusa is not null);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('lead_field_proposals', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 6b. crm_proposals (migration 0477, #1504) — PRESERVA número, valores,
  -- itens, datas e status; redige só o que identifica a PESSOA. Ver o
  -- cabeçalho desta migration para o porquê de cada coluna.
  -- O PDF que o cliente recebeu (bucket `propostas`, `<org>/<proposta>.pdf`)
  -- tem o nome dele impresso: redigir as colunas e deixar o arquivo seria
  -- anonimizar a linha e manter o documento. Vai para a mesma fila de expurgo
  -- da mídia (passo 7), com o bucket CERTO — a mensagem que levou o PDF
  -- aponta para o mesmo caminho, mas o passo 7 só enfileira `whatsapp-media`.
  -- Lido ANTES de o passo seguinte zerar `pdf_path`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'propostas', pdf_path
    from crm_proposals
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and pdf_path is not null and length(pdf_path) > 0
     -- só arquivo DESTA organização: o expurgo nunca alcança o PDF de outra
     and pdf_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update crm_proposals set
    destinatario_nome = v_anon_label,
    briefing_json = '{}'::jsonb,
    resumo_comercial = null,
    -- o texto do documento como foi montado e como foi editado à mão: é o
    -- conteúdo do PDF, com o mesmo nome dentro.
    rendered_snapshot = null,
    secoes_editadas = null,
    pdf_path = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('crm_proposals', v_count);

  -- CAMPANHAS: o que foi DITO à pessoa e o endereço para onde foi.
  update campaign_recipients set
    rendered_body = null,
    recipient_address = null,
    variables = '{}'::jsonb,
    last_error_detail = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_recipients', v_count);

  -- LISTA DE EXCLUSÃO: solta o vínculo e apaga a cauda do telefone.
  update campaign_suppressions set
    address_tail = null,
    reason = null,
    contact_id = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_suppressions', v_count);

  -- 6c. sales — a comanda SAIU desta cascata (PR #1907, item 1).
  -- Este passo alterava a comanda pelo NOME, e as cinco tabelas da comanda
  -- saíram do baseline para nascerem só na instalação do módulo (ADR-0002
  -- D2/D3): sem o módulo a tabela não existe e a alteração abortava a
  -- ANONIMIZAÇÃO INTEIRA com `relation "sales" does not exist` — 68
  -- ocorrências no CI do #1907 — além de violar a D8 (migration 0485), que
  -- proíbe o núcleo nomear tabela de módulo. A redação da comanda acontece
  -- agora pela SEÇÃO declarada `financeiro/sales` em `modulo_secoes_lgpd`,
  -- que `trg_lgpd_secoes_de_modulo` aplica nos DOIS caminhos de anonimização
  -- (a cascata e a virada `is_anonymized` de `fn_lgpd_anonymize_contact`) —
  -- e pula, sem erro, onde o módulo não está instalado (`to_regclass`), que é
  -- exatamente o contrato.
  -- 6d. conversation_notes (migration 0483, F3 da #1863) — a nota interna é
  -- texto escrito SOBRE a pessoa durante o atendimento, e o anexo dela é mídia
  -- ancorada na conversa: os dois entram no alcance do titular. A 0477 já
  -- mostrou o desenho (arquivo vai para a fila ANTES de a coluna ser zerada).
  -- O bucket é `internal-media`, e não o do passo 7: a nota nunca sobe no
  -- `whatsapp-media` (é o bucket do canal do CLIENTE), e enfileirar o caminho
  -- num bucket onde ele não está deixaria a remoção apontando para o nada —
  -- a mesma falha de não ter anonimizado, um endereço mais para a direita.
  -- Por isso os caminhos de nota também NÃO entram em `v_media_paths`: essa
  -- lista só existe para o passo 7, que enfileira `whatsapp-media`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'internal-media', n.media_storage_path
    from conversation_notes n
   where n.organization_id = p_organization_id
     and n.conversation_id in (
       select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
     )
     and n.media_storage_path is not null and length(n.media_storage_path) > 0
     and n.media_storage_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update conversation_notes set
    body = '[nota interna anonimizada]',
    media_storage_path = null,
    media_mime = null,
    media_size_bytes = null
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
       where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversation_notes', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  update prospecting_candidates set suppression_salt = gen_random_bytes(32)
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)))
    and suppression_salt is null;
  update prospecting_candidates set
    suppression_place = hmac(convert_to(place_id, 'UTF8'), suppression_salt, 'sha256'),
    suppression_phone = case when phone is null then null
      else hmac(convert_to(phone, 'UTF8'), suppression_salt, 'sha256') end,
    place_id = 'redacted:' || id::text,
    phone = null,
    data = jsonb_build_object('key', 'redacted:' || id::text,
      'name', v_anon_label, 'phone', null, 'website', null,
      'category', null, 'address', null, 'maps_url', null,
      'rating', null, 'reviews', null, 'emails', '[]'::jsonb, 'socials', '[]'::jsonb),
    status = 'skipped', service_boundary = null, error = null, updated_at = now()
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)));
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('prospecting_candidates', v_count);

  -- agent_cases — o que a IA escreveu SOBRE a pessoa quando travou (migration 0280).
  update agent_cases set
    title = v_anon_label,
    summary = '[resumo anonimizado]',
    blocker = '[bloqueio anonimizado]',
    context_snapshot = '{}'::jsonb
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_cases', v_count);

  -- agent_case_events — a linha do tempo do caso (migration 0280).
  update agent_case_events set
    body = null,
    metadata = '{}'::jsonb
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_events', v_count);

  -- demandas — o assunto do pedido (migration 0280).
  update demandas set
    assunto = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('demandas', v_count);

  -- agent_inbox_items — o aviso que leva o texto do caso para a Central (migration 0280/0292).
  update agent_inbox_items set
    status = 'resolved',
    resolved_at = now(),
    body = 'Contato anonimizado.',
    ref_id = null
  where organization_id = p_organization_id
    and kind in ('handoff', 'case_stale', 'aviso_de_caso_nao_entregue')
    and (
      (ref_kind = 'contact' and ref_id = p_contact_id)
      or (ref_kind = 'conversation' and ref_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          ))
      or (ref_kind = 'agent_case' and ref_id in (
            select id from agent_cases
              where organization_id = p_organization_id
                and conversation_id in (
                  select id from conversations
                    where contact_id = p_contact_id and organization_id = p_organization_id
                )
          ))
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_inbox_items', v_count);

  -- agent_case_chat_messages — a consulta interna da equipe à IA SOBRE o caso (migration 0281).
  update agent_case_chat_messages set
    body = null,
    redacted_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id
    and redacted_at is null;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_chat_messages', v_count);

  -- passagens_de_atendimento — o BRIEFING é sobre a pessoa (migration 0291).
  update passagens_de_atendimento set
    body       = v_anon_label,
    title      = null,
    notes      = null,
    content    = null,
    tentativas = '[]'::jsonb
  where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('passagens_de_atendimento', v_count);

  -- entregas_de_aviso_de_caso — o registro do aviso ao suporte (migration 0292).
  update entregas_de_aviso_de_caso set
    erro_detalhe = null
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('entregas_de_aviso_de_caso', v_count);

  -- channel_session_groups.subject — o NOME do grupo, e a FK contact_id aponta
  -- para o placeholder do grupo (contacts.kind = 'whatsapp_group'), nunca para
  -- o titular real sendo anonimizado neste caminho — mas a FK para contacts e o
  -- nome da coluna casam o padrão automático do escopo (migration 0482), e
  -- nulificar não perde nada operacional: número, conversa e liga/desliga ficam.
  update public.channel_session_groups set
    subject = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('channel_session_groups', v_count);

  -- social_comments — o texto e o @ que a pessoa escreveu em público (8003).
  -- O comentário não tem FK para o contato: quem comenta pode nunca ter
  -- mandado DM. O vínculo é a identidade social, a mesma forma de
  -- `contacts.social_identity` (`rede:conta:participante`). A LINHA fica (as
  -- respostas e a DM privada dependem dela); o conteúdo e o vínculo saem.
  if v_identidade_social is not null then
    update public.social_comments set
      body = null,
      author_username = null,
      author_external_id = null,
      author_identity = null
    where organization_id = p_organization_id
      and author_identity = v_identidade_social;
    get diagnostics v_count = row_count;
  else
    v_count := 0;
  end if;
  v_counts := v_counts || jsonb_build_object('social_comments', v_count);

  -- 7z. as contagens das seções de módulo (calculadas antes do passo 1); o
  --     núcleo vence numa colisão de nome.
  v_counts := v_secoes || v_counts;

  -- 7y. as fichas fundidas nesta (9243), pela mesma função: mesmas regras, a marca
  -- de cada telefone delas e a própria linha de auditoria. A mais funda primeiro:
  -- quando a de cima é chamada, as de baixo já viraram, e a recursão não acompanha
  -- o comprimento da corrente. `cycle` encerra ponteiro em círculo. Só conta a fusão
  -- com data: todo caminho que funde grava `merged_at` junto com o ponteiro.
  for v_absorvida in
    with recursive alcance (id, profundidade) as (
      select c.id, 1 from contacts c
       where c.organization_id = p_organization_id and c.is_merged_into = p_contact_id
         and c.merged_at is not null
      union all
      select f.id, a.profundidade + 1
        from contacts f
        join alcance a on f.is_merged_into = a.id
       where f.organization_id = p_organization_id
         and f.merged_at is not null
    ) cycle id set em_ciclo using caminho
    select a.id
      from alcance a
      join contacts c on c.id = a.id
     where not a.em_ciclo and not c.is_anonymized
     group by a.id
     order by max(a.profundidade) desc, a.id
  loop
    perform public.fn_lgpd_cascade_redact_contact(p_organization_id, v_absorvida, p_request_id);
    v_absorvidas := v_absorvidas + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('fichas_absorvidas', v_absorvidas);

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    auth.uid(),
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id,
      'ficha_de_origem', v_fundida_em
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;

revoke all on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) to service_role;
