# Instagram nativo pela API da Meta

## Escopo desta entrega

`Conexões → Instagram` conecta a conta profissional do Instagram da organização
pela API do Instagram com login do Instagram, usando o **app Meta da própria
empresa**. Não há intermediário: o canal das redes sociais intermediado
(`docs/specs/redes-sociais-nativas.md`) continua existindo e não muda.

Entra nesta entrega:

- conectar a conta (token + chave secreta do app), com passo a passo na tela;
- mensagens diretas na caixa de entrada existente: entrada, resposta humana,
  resposta do agente, eco do que foi respondido pelo app do Instagram, leitura,
  mídia recebida;
- webhook do app configurado pela tela (com o ID do app) ou à mão;
- renovação diária do token (60 dias) e saúde da conexão no vigia existente.

Entregas seguintes: publicação e agendamento de posts (módulo opcional,
`docs/specs/publicacoes-nas-redes.md`), comentários e o Facebook (Messenger) —
as duas abaixo.

## Modelo

Provider `meta_social` no seam de canais, um para as redes da Meta que não são
WhatsApp. A rede da conexão fica em `channel_sessions.metadata.social_platform`
(`instagram` hoje; `facebook` quando o Messenger entrar), a mesma chave que a
apresentação já lê no canal intermediado. Capabilities: sem texto livre fora da
janela de 24h, sem modelos, sem banimento por volume, sem grupos, sem custo por
mensagem.

Colunas novas em `channel_sessions` (migration 0740 + apêndice do baseline):

| Coluna | O que é |
|---|---|
| `meta_social_account_id` | id da conta profissional (o `entry.id` do webhook). É o `sessionRef`. Único entre sessões ativas |
| `meta_social_token_encrypted` | token de acesso, cifrado por `fn_encrypt_oauth` |
| `meta_social_token_expires_at` | validade conhecida do token; `NULL` até a primeira renovação |

A chave secreta do app (que assina o webhook) mora em `webhook_secret_encrypted`,
a coluna que já existe para isso.

Contato: `contacts.social_identity = instagram:<conta>:<IGSID>`, sem telefone.
Conversa: `provider_conversation_id = <IGSID>`, que é o destinatário do envio.
Mensagem: `external_id = social:<conta>:<mid>`, o mesmo formato que o envio
devolve. É assim que o eco do próprio envio é deduplicado.

## Segurança

- A rota exige administrador (e MFA quando cadastrado). Token e chave nunca
  voltam num GET; a auditoria registra só a operação (`channel.connected`,
  `channel.token_refreshed`).
- O token vai no header `Authorization`, nunca na URL. A credencial do app
  (`<id>|<chave>`), usada só para configurar o webhook do app, vai no corpo do POST.
- Webhook: `X-Hub-Signature-256` conferida com a chave secreta do app **antes**
  de ingerir; o corpo cru é arquivado antes da conferência (como nos outros
  canais da rota genérica). O evento só entra se a conta do corpo é a da sessão
  do token do caminho.
- Handshake (`GET` com `hub.verify_token`): o token de verificação é um HMAC da
  chave secreta do app com o id da sessão. É estável, único por conexão e não
  ocupa coluna.
- Mídia recebida é baixada da CDN da Meta **sem** o token, com cada
  redirecionamento passando pela checagem anti-SSRF.

## Entrada e saída

`webhooks/channel/[token]` → `inbound.ts` (assinatura, conta) →
`meta-social/ingest.ts` → `ingestZernioInbound` com `socialMessage` (a mesma
gravação do canal social intermediado) → `pos-entrada`.

`metaSocialAdapter.send` → `POST graph.instagram.com/<v>/me/messages` com
`recipient.id = provider_conversation_id`. Resposta sem `message_id` é falha.
Anexo com legenda é recusado: no Instagram anexo e texto são duas mensagens, e a
segunda voltaria como envio feito fora do CRM, pausando a IA.

## Operação

- O canal nasce com a IA pausada (`pre_go_live`), como os outros canais.
- Configurar o webhook pela tela **substitui** o endereço do app para o
  Instagram. A tela avisa antes, porque outra automação ligada ao mesmo app
  deixa de receber.
- A Meta só entrega webhook de app **publicado** (modo Ativo). Atender contas
  sem papel no app exige a análise do app pela Meta (acesso avançado).
- `instagram-token` (diário, 04:41): renova tokens com validade desconhecida ou
  a menos de 20 dias do fim. Token com menos de 24h não renova (regra da Meta) e
  não conta como falha. Token morto aparece pelo vigia de conexão
  (`checkHealth` → `token_invalido_reconecte`), que abre e fecha o aviso na Central.

## Sistema vivo

- **Entrada:** webhook assinado da Meta. **Saída:** Inbox, agente, envio.
- **Porta:** aba `Conexões › Instagram`.
- **Registro:** arquivo do webhook, ledger de mensagens, auditoria.
- **Anti-morte:** renovação diária do token e vigia de conexão.
- **Laço de retorno:** um envio recusado não é declarado enviado; o eco do app
  pausa a IA; opt-out impede novas respostas; o token morto vira aviso.

## Comentários (migration 0742)

Núcleo, como a DM: comentário é a porta por onde a pessoa chega antes de
mandar mensagem.

- **Entrada.** O webhook assina `comments`. `entry[].changes[field=comments]`
  vira linha em `social_comments` (única por organização + `external_id`; o
  reenvio cai no 23505). O comentário da própria conta não entra — a resposta
  pública da regra volta por ali e dispararia a regra de novo.
- **Evento.** O INSERT emite `comment.received` (entidade `social_comment`) pelo
  gatilho do banco, reservado ao servidor no `emit_event`. O payload leva só
  ids; texto e @ ficam na linha, que a cascata de LGPD alcança.
- **Automação.** Gatilho "Quando alguém comentar numa publicação", condições
  em `comment.body`, `comment.media_external_id` e `comment.author_username`.
  Ações `reply_comment` (em público) e `private_reply_comment` (a DM que nasce
  do comentário); a porta recusa as duas em qualquer outro gatilho, inclusive
  dentro de `ai_decide`.
- **Uma resposta por comentário.** Regra e tela passam pelo mesmo caminho
  (`lib/comentarios/responder.ts`): a linha é levada por UPDATE condicional
  antes de chamar a rede. DM privada só até 7 dias depois do comentário (regra
  da Meta), e falha no privado é terminal — a chamada pode ter saído.
- **Eco da DM privada.** Volta pelo webhook de mensagens, abre a conversa no
  Inbox com o @ de quem comentou, e NÃO pausa a IA (quem respondeu foi a regra).
- **Tela.** Atendimento › Comentários: lista, selos do que foi respondido e
  resposta à mão (`agent`+).
- **LGPD.** `author_identity` (`rede:conta:autor`, a forma de
  `contacts.social_identity`) liga o comentário ao contato sem FK. A cascata
  limpa texto, @ e vínculo; o export entrega os comentários.

Conexão feita antes desta versão não assina `comments`: conecte de novo (ou use
o botão de configurar o webhook do app) para os comentários começarem a chegar.

## Facebook (Messenger) — o mesmo canal

A página do Facebook entra pelo MESMO provider `meta_social`, com
`metadata.social_platform = "facebook"`. Sem migration e sem tocar em feature:
o que muda mora em `lib/channels/meta-social/`, decidido pela rede da conexão.

| | Instagram | Página do Facebook |
|---|---|---|
| Host da Graph | `graph.instagram.com` | `graph.facebook.com` (`graph-base.ts`) |
| Token | da conta (60 dias, renovado todo dia) | da PÁGINA (não expira; sem renovação) |
| Validação | `me?fields=user_id,username,…` | `me?fields=id,name,category` — `category` só existe em página, então o token de USUÁRIO é recusado com a frase certa |
| Webhook (`object`) | `instagram` | `page` |
| Campos assinados | messages, messaging_seen, messaging_referral, comments | messages, message_echoes, message_reads, messaging_referrals, feed |
| Envio | `me/messages` | `me/messages` + `messaging_type: RESPONSE` |
| Comentário | `changes[field=comments]`; resposta em `/<id>/replies` | `changes[field=feed]` com `item=comment, verb=add`; resposta em `/<id>/comments` |
| Leitura | `read.mid` aplicada | `read.watermark` contada, não aplicada |
| Publicação | container → `media_publish` (todos os formatos) | `/photos`, `/videos`, `/feed` com fotos anexadas — sem reels nem story |

Uma conexão por rede: `buscarSessaoInstagram(org, rede)`. A rota é a mesma nas
duas (`app/api/v1/channels/_conexao-social.ts`), atrás de `channels/instagram` e
`channels/facebook`; a tela é `CanalInstagramClient` com `rede`.

**Publicar na página não tem container**: a chamada que sobe a foto/vídeo
PUBLICA. Por isso, depois dela, falha sem resposta clara (rede, prazo, 5xx) é
DEFINITIVA ("confira na página") — só limite de chamadas volta para a fila.

Os formatos de cada conexão vêm do adapter (`formatosQuePublica`), não da tela:
o seletor de publicações só oferece o que a conta publica, e a rota recusa o
resto.

## Fontes verificadas (documentação da Meta, via Meta MCP)

- Plataforma do Instagram: Webhooks (assinatura com a chave secreta do app,
  `/me/subscribed_apps`, campos e permissões, app publicado).
- Refresh Access Token (`GET /refresh_access_token`, 24h mínimas, 60 dias).
- Private Replies e Content Publishing (para as próximas entregas).
