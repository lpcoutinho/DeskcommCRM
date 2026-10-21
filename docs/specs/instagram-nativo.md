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

Fica para as próximas entregas: comentários (resposta automática e DM a partir
de comentário), publicação e agendamento de posts (módulo opcional, ADR-0002) e
Messenger.

## Modelo

Provider `meta_social` no seam de canais, um para as redes da Meta que não são
WhatsApp. A rede da conexão fica em `channel_sessions.metadata.social_platform`
(`instagram` hoje; `facebook` quando o Messenger entrar), a mesma chave que a
apresentação já lê no canal intermediado. Capabilities: sem texto livre fora da
janela de 24h, sem modelos, sem banimento por volume, sem grupos, sem custo por
mensagem.

Colunas novas em `channel_sessions` (migration 0721 + apêndice do baseline):

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

## Fontes verificadas (documentação da Meta, via Meta MCP)

- Plataforma do Instagram: Webhooks (assinatura com a chave secreta do app,
  `/me/subscribed_apps`, campos e permissões, app publicado).
- Refresh Access Token (`GET /refresh_access_token`, 24h mínimas, 60 dias).
- Private Replies e Content Publishing (para as próximas entregas).
