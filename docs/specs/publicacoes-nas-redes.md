# Publicações nas redes (módulo opcional)

## Escopo

`CRM › Publicações` agenda e publica posts nas contas conectadas que publicam
conteúdo. Hoje é o Instagram pela API da Meta (`docs/specs/instagram-nativo.md`).
Formatos: imagem, vídeo (vai para a grade como reels), carrossel (2 a 10),
reels e story.

É **módulo de tabela** (ADR-0002): o administrador da instalação instala
`publicacoes` em `/admin/modulos`. Sem o módulo, a tela, as rotas e a porta do
menu não existem (404), e o banco não tem a tabela.

Destino: **extensão** pela régua da doutrina — se nenhuma organização usar, a
operação comum continua inteira. O que entrou no núcleo é só o que o módulo
consome dele: o ponto `publicarConteudo?` do adapter (capacidade de canal) e o
`kind` `publicacao_falhou` da Central.

## Modelo

`publicacoes_posts` (nasce em `fn_publicacoes_provisionar()`):

| Coluna | O que é |
|---|---|
| `channel_session_id` | a conta onde publicar (conexão excluída → `null`, o post fica) |
| `formato` | `imagem` / `video` / `carrossel` / `reel` / `story` |
| `legenda` | até 2.200 caracteres (limite da Meta) |
| `midias` | jsonb, 1 a 10 `{ caminho, mime }`; o esquema é `lib/publicacoes/esquema.ts` |
| `status` | `rascunho` → `agendado` → `publicando` → `publicado` \| `falhou`; `cancelado` |
| `agendado_para`, `proxima_tentativa_em`, `tentativas`, `ultimo_erro` | a fila |
| `id_container`, `id_externo`, `link_publico`, `publicado_em` | o que a rede devolveu |

Mídia: bucket privado `publicacoes`, criado pelo servidor no primeiro upload
(`lib/publicacoes/armazenamento.ts`), caminho `<organização>/<uuid>.<ext>`. Não é
`whatsapp-media`: a retenção de mídia de conversa apaga órfão lá.

RLS por operação: todo papel lê; `manager` cria, edita, cancela e apaga, só nos
estados da pessoa; ninguém escreve `publicado` pela sessão; post já publicado não
se edita nem se apaga; a conta tem de ser da mesma organização.

## A fila

Cron `publicacoes` (a cada minuto) → `lib/publicacoes/fila.ts`:

1. `fn_publicacoes_reivindicar(limite, organizações_paradas)` leva o que venceu
   (`SKIP LOCKED`), marca `publicando` e conta a tentativa.
2. A mídia é assinada por 1 hora, porque a rede baixa a URL de fora.
3. `getAdapter(provider).publicarConteudo` monta o container, espera ficar
   pronto e publica.
4. Desfechos:
   - **publicado**: grava o link.
   - **processando**: volta à fila em 1 minuto com o `id_container`, sem montar
     outro.
   - **erro passageiro**: reagenda com espera de 2, 4, 8 e 16 minutos, até 5
     tentativas.
   - **erro definitivo**: `falhou`, com aviso `publicacao_falhou` na Central.

**Publicar em dobro é pior que não publicar.** Post que ficou em `publicando` por
mais de 15 minutos (o processo caiu no meio) vira `falhou` com
`interrompido_confira_no_instagram` e aviso na Central. Ele nunca volta sozinho
para a fila. Container que já aparece `PUBLISHED` também não é republicado.

## Sistema vivo

- **Entrada:** a tela (pessoa). **Saída:** o post na rede e o link na lista.
- **Porta:** `CRM › Publicações` (hub do CRM, "Preparar a venda").
- **Registro:** auditoria `publicacao.criada|alterada|removida|publicada|falhou`.
- **Anti-morte:** a fila com retentativa e o fechamento do que foi interrompido.
- **Laço de retorno:** falha vira aviso na Central com o motivo, e o post fica
  em "Falharam" com o botão de publicar de novo.

## O que ainda não foi medido

Publicação real na Meta, e o tempo de processamento de vídeo com conta real.
Os testes cobrem o contrato com respostas simuladas da Graph e o banco de verdade
(RLS, claim).
