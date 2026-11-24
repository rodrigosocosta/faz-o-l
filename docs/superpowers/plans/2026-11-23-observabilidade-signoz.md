# Observabilidade SigNoz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Entregar SigNoz próprio opcional com traces, logs e métricas do servidor Faz o L.
**Architecture:** SDKs OpenTelemetry exportam OTLP/HTTP em lotes para um collector interno. Foundry gera a stack SigNoz e um overlay conecta o app, gravador e métricas Prometheus do LiveKit. Implantação padrão funciona sem telemetria.
**Tech Stack:** Node.js ESM, Express 4, OpenTelemetry JS/Go, Go net/http, Docker Compose, SigNoz Foundry.
**Spec:** `docs/superpowers/specs/2026-11-23-observabilidade-signoz-design.md`, aprovado em 2026-11-23.

## Global Constraints

- Serviços `fazol-app`, `fazol-recorder`, `fazol-livekit`; painel em `127.0.0.1:8080`.
- Ingestão interna, persistência de dados, nenhuma alteração no checkout paralelo do desktop.
- Telemetria opt-in; exportação indisponível não impede operações da aplicação.
- Métricas sem IDs/URLs completas; nenhuma exportação de cookies, tokens, query strings ou payloads.
- Dependências e imagens fixadas; configuração gerada reproduzível.

## Review Focus

- URLs de OAuth e mensagens de erro com segredos: sanitizar antes da exportação e testar payload OTLP.
- Collector indisponível: rotas respondem; shutdown/exportação com prazo limitado.
- Rotas dinâmicas e SSE: métricas não usam IDs nem ficam aguardando conexões longas sem limite.
- `fetch` em ESM e contexto assíncrono: `traceparent` deve chegar ao Go com o mesmo trace ID.
- Compose com Caddy ou Traefik: overlay não substitui configuração LiveKit nem publica ingestão.

---

### Task 1: Telemetria da API

**Files:** criar `app/src/telemetry.js`, `app/src/logger.js`, `app/telemetry.test.mjs`; modificar bootstrap, rotas com logs, package.json/lock e Dockerfile.
**Interfaces:** `initTelemetry()` retorna `{ shutdown, flush }`; `httpTelemetry(req,res,next)` usa rota Express normalizada; `tracedFetch(url,options)` propaga contexto HTTP; `logger.info/warn/error(message, attributes)` emite console e OTLP.

- [x] Escrever testes com servidor OTLP/HTTP local e Express real: trace entrante/filho, métricas, log correlacionado, URL com query secreta, rota desconhecida, collector fora do ar e modo desabilitado.
- [x] Rodar `rtk node --test telemetry.test.mjs`; observar falha pela integração ausente.
- [x] Implementar SDK com contexto AsyncLocalStorage, spans HTTP/cliente explícitos (evita hooks ESM globais), logger e métricas periódicas; iniciar antes da API por import dinâmico.
- [x] Atualizar chamadas fetch para o recorder e logs operacionais; manter contratos HTTP.
- [x] Rodar testes de telemetria, sintaxe e smoke test; commit `feat: instrumenta API com OpenTelemetry`.

### Task 2: Telemetria do gravador

**Files:** criar `recorder/telemetry.go`, `recorder/telemetry_test.go`, `recorder/http_test.go`; modificar `main.go`, go.mod/go.sum.
**Interfaces:** `initTelemetry(ctx) (func(context.Context) error,error)` configura providers; `instrumentHTTP(handler) http.Handler` extrai W3C, normaliza rotas e mede HTTP; `makeClip(ctx,req)` e `audioStreams(ctx,path)` criam spans internos; logger slog com handler de console e bridge OTLP.

- [x] Testar receptor OTLP local, extração de traceparent, métricas/logs correlacionados, falha HTTP de clipe, query/erro secreto, modo desabilitado e collector ausente.
- [x] Rodar testes; observar falha por símbolos/comportamento ausentes.
- [x] Implementar providers em lotes/timeouts limitados, HTTP mux testável, spans de espera e comandos, métricas de clipes/salas/gravações e tratamento de shutdown.
- [x] Rodar `rtk go test ./...`, `rtk go test -race ./...`, `rtk go vet ./...` e build; commit `feat: instrumenta gravador com OpenTelemetry`.

### Task 3: Stack SigNoz e integração Compose

**Files:** criar `observability/casting.yaml`, lock/configuração gerada Foundry, comandos de operação e collector adicional; `docker-compose.observability.yml`; atualizar `.env.example`, `.gitignore`, CI e Dockerfiles quando necessário.
**Interfaces:** `observability/stack.sh render|up|down|status` administra stack persistente; collector alcançável em rede compartilhada; OTLP/HTTP em `http://fazol-otel-collector:4318`, scraping LiveKit em porta interna.

- [x] Validar base Compose; registrar que overlay ainda não existe.
- [x] Consultar releases/fontes oficiais, fixar versões e renderizar Foundry; personalizar portas/rede por patches de origem.
- [x] Acrescentar overlay com SDKs habilitados e Prometheus LiveKit; desabilitado sem overlay.
- [x] Validar configuração do collector e Compose com ambos proxies; verificar bind local de UI/ausência de portas de ingestão públicas.
- [x] Subir stack isolada se Docker disponível e validar saúde/ingestão sem tocar serviços existentes; commit `feat: adiciona stack SigNoz opcional`.

### Task 4: Verificação integrada e documentação

**Files:** `observability/README.md`, README principal e script de integração OTLP em `observability/`.
**Interfaces:** comando reproduzível exercita Node → Go contra receptor OTLP e permite verificar ingestão no SigNoz.

- [x] Testar trace único Node → Go sem Discord/LiveKit; erros do gravador aparecem no mesmo trace e sem segredos.
- [x] Documentar ativação, acesso por SSH, retenção, recursos, atualização e desativação sem apagar volumes.
- [x] Rodar testes finais e validações Compose; conferir escopo da branch; solicitar uma revisão independente do diff completo e corrigir achados importantes com testes.
- [x] Registrar limitações reais de ambiente/gravação e commits; manter branch pronta para revisão, sem merge/push solicitado.

## Resultado da execução

- API: 2 testes de integração OTLP aprovados; sintaxe e smoke test existente aprovados.
- Gravador: 5 testes aprovados com race detector; go vet e build aprovados.
- Configuração: 2 testes aprovados para rede de ingestão separada e ambiente da raiz; Compose com Caddy e Traefik validados.
- Imagens de produção Node e Go compiladas. Integração real Node → Go aprovada contra receptor local e SigNoz.
- SigNoz saudável; spans e logs com mesmo trace e métricas HTTP/clipes/LiveKit persistidos. Volumes preservados ao recriar a stack.
- Revisão independente: sete achados importantes corrigidos; bancos fora da rede de ingestão, erros de upstream limitados, SSE observado na abertura, ambiente coerente, processos encerrados fora da contagem, severidade/contexto de logs e rotas de página normalizadas.
- Decisões: middleware explícito para ESM; endpoint LiveKit só interno também sem overlay; collector com configuração estática, sem OpAmp.
- Limite de validação: uma live com mídia e a geração de um arquivo real por ffmpeg não foram exercitadas.
