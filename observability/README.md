# Observabilidade com SigNoz

O servidor pode enviar traces, logs e métricas para uma instância própria do SigNoz. A instalação padrão do Faz o L continua funcionando sem essa stack. A instrumentação do desktop é independente desta integração.

## Ativar

Reserve pelo menos **4 GB de RAM adicionais** para o SigNoz, além dos recursos do Faz o L. Use Docker Engine com Compose v2. Os arquivos gerados e o lock do Foundry já estão no repositório; não é necessário instalar Foundry para iniciar.

Na raiz do projeto:

```bash
sh observability/stack.sh up
```

O comando aguarda até dez minutos pela inicialização, incluindo as migrações do ClickHouse. Verifique o resultado com `sh observability/stack.sh status`. Os serviços usam o projeto `fazol-signoz` e volumes próprios. Somente o collector participa da rede de ingestão `fazol-observability`; os bancos e o painel usam uma rede separada da aplicação.

Acrescente o overlay ao `COMPOSE_FILE` do `.env`, mantendo o proxy escolhido:

```dotenv
# Com Caddy
COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml:docker-compose.observability.yml
# Com Traefik, use docker-compose.traefik.yml no lugar de docker-compose.caddy.yml.
OTEL_ENVIRONMENT=production
APP_VERSION=seu-commit-ou-tag
```

Recrie os serviços a partir desta branch:

```bash
docker compose up -d --build
```

O painel fica em <http://127.0.0.1:8080>. No primeiro acesso, siga a configuração da conta de administrador. Numa VPS, abra um túnel a partir do seu computador:

```bash
ssh -L 8080:127.0.0.1:8080 usuario@sua-vps
```

Depois abra o mesmo endereço local. Nenhuma porta de ingestão é publicada no host e o painel não recebe uma rota automática no Caddy/Traefik.

## Publicar por HTTPS no Coolify/Traefik

O overlay `compose.traefik.yml` publica somente o painel na rede do proxy. Os bancos e o collector não entram nessa rede. Na raiz do projeto, configure no `.env`:

```dotenv
SIGNOZ_DOMAIN=signoz.seudominio.com
SIGNOZ_PORT=8081
TRAEFIK_NETWORK=coolify
```

Crie o registro DNS do subdomínio para o IP da VPS. A porta local 8081 evita o conflito com o painel do Traefik na 8080; ela continua vinculada somente ao loopback.

Primeiro inicie `sh observability/stack.sh up`, ainda sem a opção de publicação. Crie a conta do administrador acessando a interface por um túnel SSH:

```bash
ssh -L 18081:127.0.0.1:8081 usuario@sua-vps
```

Abra `http://127.0.0.1:18081` no computador e conclua o cadastro. Depois publique o painel pela VPS:

```bash
sh observability/stack.sh --traefik config --quiet
sh observability/stack.sh --traefik up
```

O Traefik emite o certificado para `SIGNOZ_DOMAIN`. Se o proxy usar nomes diferentes, configure `TRAEFIK_ENTRYPOINT_HTTP`, `TRAEFIK_ENTRYPOINT_HTTPS` e `TRAEFIK_CERTRESOLVER` como no overlay do Faz o L. Os padrões são `http`, `https` e `letsencrypt`.

Para operar a publicação use também a opção `--traefik` nos comandos de status, logs, render e parada. Usar `up` sem essa opção depois remove a publicação pelo proxy, mantendo o acesso local. O `COMPOSE_FILE` do app inclui apenas `docker-compose.observability.yml`; o overlay HTTPS do SigNoz é aplicado pelo seu próprio script e não entra no Compose do app.

## O que observar

### Logs do navegador e do desktop

Após atualizar o app na VPS e recarregar a página, usuários autenticados enviam erros não tratados e `console.warn/error` em lotes de até 30 eventos. No SigNoz, filtre **Logs** por `service.name = fazol-app` e `client.platform = browser` ou `desktop`. A versão está em `client.version`; o componente, em `client.target`.

O desktop precisa de uma compilação que inclua o comando `take_client_logs`. Ela preserva o arquivo `fazol.log` e disponibiliza uma fila nativa limitada ao webview do servidor configurado. O webview encaminha os eventos usando a sessão do usuário; nenhum token de ingestão SigNoz fica no cliente. Versões antigas continuam funcionando e enviam apenas os logs da página após atualizar o servidor.

O envio ocorre a cada 15 segundos enquanto há uma sessão autenticada e o app está aberto. Eventos anteriores ao início da página e eventos ainda na fila quando o app fecha podem não chegar. Não há captura de telas, áudio ou corpos de requisição. Objetos completos de exceção não são enviados; mensagens de diagnóstico passam pelo filtro de credenciais do servidor. Os relatos dos clientes são dados não confiáveis.

Limites: 120 eventos na fila local, até 24 KiB por lote no transporte, até 32 KiB por requisição no servidor e 120 eventos/minuto por usuário. Falhas de envio não bloqueiam a transmissão. Não é preciso alterar a stack SigNoz: basta reconstruir o serviço `app` e distribuir a nova compilação desktop.

### Eventos de produto: clipes e transmissões

O serviço `fazol-app` registra `clip.created` somente depois que o clipe foi gerado pelo recorder e salvo no banco; o evento inclui duração, tamanho, canal, criador e streamer. Nos webhooks do LiveKit, `stream.started` e `stream.ended` marcam o início/fim real da publicação de tela, com nome/ID do streamer, canal e `stream.platform` (`browser` ou `desktop`). Assim, quem está no ar pode ser encontrado em **Logs** filtrando `event.name = stream.started` e conferindo o último evento de cada `streamer.id` (um `stream.ended` posterior indica que parou).

As métricas de baixa cardinalidade são `fazol.clips.created`, `fazol.streams.started`, `fazol.streams.ended` e `fazol.streams.active`. A última é a quantidade de transmissões ativas observadas pelo processo do app; identidade e nome ficam nos logs, não como dimensões de métricas. Os contadores são cumulativos desde o início do processo e podem ser agrupados por `client.platform` nas métricas de início/fim.

| Serviço | Dados |
|---|---|
| `fazol-app` | Requisições HTTP, chamadas ao gravador, duração/volume/status por rota, contagem de clipes e transmissões, transmissões ativas, memória, CPU, uptime e logs do site/bot |
| `fazol-recorder` | HTTP, espera por segmentos, execução de ffmpeg/ffprobe, resultado/duração dos clipes, salas e gravações ativas, memória, goroutines e logs |
| `fazol-livekit` | Métricas Prometheus agregadas disponíveis na versão do LiveKit em uso |

Em **Services/APM**, procure `fazol-app` e `fazol-recorder`. Ao gerar um clipe, o trace da requisição inclui a chamada HTTP entre os serviços e o processamento no gravador. Uma espera de aproximadamente dez segundos com `recorder.wait_segments` costuma indicar que ainda não há segmentos para esse clipe. Uma falha de ffmpeg aparece em `recorder.ffmpeg` com status de erro.

Em **Logs**, filtre por `service.name` e severidade. Logs produzidos durante uma operação têm o trace correspondente; eventos de background podem não ter trace. A saída do console continua disponível pelo Docker. Ela não é coletada uma segunda vez. Erros de upstream exportam classe e mensagens operacionais controladas, sem o texto bruto potencialmente sensível.

No explorador de **Metrics**, procure `http.server.request.duration`, `http.server.request.count`, `fazol.clips.created`, `fazol.streams.started`, `fazol.streams.ended`, `fazol.streams.active`, `fazol.recorder.clips.count`, `fazol.recorder.clip.duration` e `fazol.recorder.recordings.active`. O nome final exibido pode ser normalizado pelo SigNoz. As métricas do LiveKit vêm do endpoint interno `:6789/metrics`; séries por sala, participante ou trilha são descartadas para limitar cardinalidade.

A telemetria não inclui cookies, cabeçalhos de autenticação, corpos de requisição, URLs completas ou query strings. Rotas usam o padrão (`:id`), e IDs não viram dimensões das métricas. Mensagens de logs removem credenciais, caminhos e queries de URLs; evite incluir segredos em texto livre nos novos logs.

## Recursos e retenção

Em **Settings → General**, confira a retenção da instância. O ponto de partida é sete dias para logs/traces e trinta dias para métricas; reduza conforme a memória e o disco disponíveis. Retenção e usuários são estado persistente do SigNoz e não são redefinidos pelo script.

Os SDKs usam filas limitadas e exportação em lotes, com timeout de um segundo por exportação. Uma indisponibilidade do collector não bloqueia o HTTP nem o processamento de clipes. Filas cheias ou exportações malsucedidas podem perder telemetria. Não há exportação por frame ou por pacote RTP.

## Parar e desativar

```bash
sh observability/stack.sh logs
sh observability/stack.sh status
sh observability/stack.sh config
sh observability/stack.sh down
```

`down` preserva os volumes. Para desativar a instrumentação, remova apenas `:docker-compose.observability.yml` de `COMPOSE_FILE` e rode `docker compose up -d`. As outras stacks e seus volumes permanecem independentes. Se o Compose avisar que a rede ainda está em uso, recrie primeiro o app sem o overlay e repita a parada do SigNoz.

## Alterar ou atualizar a stack

Versões: Foundry **v0.5.0**, SigNoz **v0.151.0**, collector **v0.144.18**, ClickHouse/Keeper **25.12.5** e PostgreSQL 16 fixado por digest. As imagens do SigNoz não usam `latest`.

Instale o binário oficial do [Foundry v0.5.0](https://github.com/SigNoz/foundry/releases/tag/v0.5.0) para seu sistema, verificando o arquivo de checksums da release. Edite `casting.yaml` e seus patches, nunca os arquivos em `pours/` diretamente:

```bash
sh observability/stack.sh render
# Ou: FOUNDRYCTL=/caminho/foundryctl sh observability/stack.sh render
docker compose -f observability/pours/deployment/compose.yaml config --quiet
```

Revise e versione o casting, seu lock e os arquivos gerados juntos. Faça backup dos volumes antes de atualizar versões e siga o [guia oficial de atualização](https://signoz.io/docs/operate/upgrade/). Recrie os containers após mudar arquivos montados:

```bash
docker compose -f observability/pours/deployment/compose.yaml up -d --force-recreate --wait --wait-timeout 600
```

O collector usa configuração estática versionada; não depende de OpAmp. O arquivo gerado de OpAmp é mantido como saída do Foundry, mas não é usado pelo comando de inicialização.

## Testar sem Discord ou uma live

Com Node.js e Go nas versões do projeto:

```bash
npm --prefix app ci
npm --prefix app test
cd recorder
go test ./...
go test -race ./...
go build -o /tmp/fazol-recorder-otel .
cd ..
node observability/test-integration.mjs /tmp/fazol-recorder-otel
```

O teste integrado inicia Node e Go localmente, propaga um trace conhecido e pede um clipe sem segmentos. Ele espera o erro 409 após dez segundos e comprova que o Go recebeu o contexto da API. Os testes unitários dos SDKs verificam exportação dos três sinais, ausência de segredos e comportamento sem collector. A geração de um arquivo de clipe real ainda exige uma transmissão com mídia e ffmpeg.

Para enviar esse teste à instância real, use `TEST_OTLP_ENDPOINT` com um endereço acessível do collector dentro da rede Docker. Isso mantém o collector sem portas públicas. O teste demonstra propagação; a persistência deve ser conferida também nos exploradores do SigNoz.

Referências: [instalação oficial](https://signoz.io/docs/install/docker/), [Node.js](https://signoz.io/docs/instrumentation/javascript/opentelemetry-nodejs/) e [Go](https://signoz.io/docs/instrumentation/opentelemetry-golang/).
