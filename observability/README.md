# Observabilidade com SigNoz

O servidor pode enviar traces, logs e métricas para uma instância própria do SigNoz. A instalação padrão do Faz o L continua funcionando sem essa stack. A instrumentação do desktop é independente desta integração.

## Ativar

Reserve pelo menos **4 GB de RAM adicionais** para o SigNoz, além dos recursos do Faz o L. Use Docker Engine com Compose v2. Os arquivos gerados e o lock do Foundry já estão no repositório; não é necessário instalar Foundry para iniciar.

Na raiz do projeto:

```bash
sh observability/stack.sh up
```

O comando aguarda até dez minutos pela inicialização, incluindo as migrações do ClickHouse. Verifique o resultado com `sh observability/stack.sh status`. Os serviços usam o projeto `fazol-signoz`, rede `fazol-observability` e volumes próprios.

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

## O que observar

| Serviço | Dados |
|---|---|
| `fazol-app` | Requisições HTTP, chamadas ao gravador, duração/volume/status por rota, memória, CPU, uptime e logs do site/bot |
| `fazol-recorder` | HTTP, espera por segmentos, execução de ffmpeg/ffprobe, resultado/duração dos clipes, salas e gravações ativas, memória, goroutines e logs |
| `fazol-livekit` | Métricas Prometheus agregadas disponíveis na versão do LiveKit em uso |

Em **Services/APM**, procure `fazol-app` e `fazol-recorder`. Ao gerar um clipe, o trace da requisição inclui a chamada HTTP entre os serviços e o processamento no gravador. Uma espera de aproximadamente dez segundos com `recorder.wait_segments` costuma indicar que ainda não há segmentos para esse clipe. Uma falha de ffmpeg aparece em `recorder.ffmpeg` com status de erro.

Em **Logs**, filtre por `service.name` e severidade. Logs produzidos durante uma operação têm o trace correspondente; eventos de background podem não ter trace. A saída do console continua disponível pelo Docker. Ela não é coletada uma segunda vez.

No explorador de **Metrics**, procure `http.server.request.duration`, `http.server.request.count`, `fazol.recorder.clips.count`, `fazol.recorder.clip.duration` e `fazol.recorder.recordings.active`. O nome final exibido pode ser normalizado pelo SigNoz. As métricas do LiveKit vêm do endpoint interno `:6789/metrics`; séries por sala, participante ou trilha são descartadas para limitar cardinalidade.

A telemetria não inclui cookies, cabeçalhos de autenticação, corpos de requisição, URLs completas ou query strings. Rotas usam o padrão (`:id`), e IDs não viram dimensões das métricas. Mensagens de logs removem credenciais e queries de URLs; evite incluir segredos em texto livre nos novos logs.

## Recursos e retenção

Em **Settings → General**, confira a retenção da instância. O ponto de partida é sete dias para logs/traces e trinta dias para métricas; reduza conforme a memória e o disco disponíveis. Retenção e usuários são estado persistente do SigNoz e não são redefinidos pelo script.

Os SDKs usam filas limitadas e exportação em lotes, com timeout de um segundo por exportação. Uma indisponibilidade do collector não bloqueia o HTTP nem o processamento de clipes. Filas cheias ou exportações malsucedidas podem perder telemetria. Não há exportação por frame ou por pacote RTP.

## Parar e desativar

```bash
sh observability/stack.sh logs
sh observability/stack.sh status
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
