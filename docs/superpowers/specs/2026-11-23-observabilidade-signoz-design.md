# Observabilidade do servidor com SigNoz próprio

Data: 2026-11-23
Estado: aprovado e implementado
Branch: `feat/observabilidade-signoz`, baseada na `main` em `624ffcd`.
Worktree: `/home/dric0s/.codex/worktrees/f245/faz-o-l`.

## Intenção e escopo

Investigar erros, indisponibilidade e lentidão no Faz o L a partir de uma instância própria do SigNoz mantida pelo projeto. A escolha de hospedar o SigNoz foi confirmada pelo usuário. A proposta de escopo é reunir logs, métricas e traces da API Node.js e do gravador Go, e métricas do LiveKit. O trabalho de desktop/Linux acontece em paralelo no checkout original.

Hoje o Docker Compose inicia `app`, `recorder` e `livekit`, com Caddy ou Traefik em arquivos adicionais. A API usa Express e módulos ESM; ela chama o gravador com `fetch` para entrar nas salas e gerar clipes. O gravador recebe HTTP por `net/http` e chama ffmpeg/ffprobe. Os serviços escrevem logs no console e não têm uma configuração de observabilidade no repositório.

## Abordagens

1. Usar um SigNoz existente: exigiria apenas instrumentação e encaminhamento; depende de uma instância externa. O usuário escolheu hospedar no projeto.
2. Hospedar SigNoz e coletar apenas logs e métricas: menos mudanças de código, mas dificulta seguir uma falha entre API e gravador.
3. Hospedar SigNoz e integrar logs, métricas e traces: proposta recomendada pelo agente, porque permite relacionar a requisição de um clipe com seu processamento. O escopo completo foi aprovado pelo usuário.

## Arquitetura proposta

Manter a implantação atual do Faz o L utilizável por conta própria. Acrescentar `observability/` com configuração declarativa do SigNoz e comandos locais de operação. Usar Foundry para gerar a stack Docker Compose suportada pelo SigNoz, com versões fixadas no arquivo de lock. Os arquivos gerados devem ser reproduzíveis; personalizações ficam na configuração e nos patches de origem.

Um overlay Compose opcional conecta os serviços do Faz o L ao collector. A comunicação de ingestão ocorre na rede Docker por OTLP. A interface do SigNoz fica, por padrão, em `127.0.0.1:8080`, acessível localmente ou por túnel SSH. O painel não entra no domínio público do site automaticamente. As portas de ingestão não precisam ser expostas publicamente. Volumes persistentes guardam os dados e os comandos de parada preservam esses volumes.

Logs estruturados da API e do gravador serão exportados por OTLP, mantendo também a saída no console. Os logs gerados dentro de uma operação carregam `trace_id` e `span_id`; eventos de background podem não ter um trace. Não haverá uma segunda coleta dos mesmos logs do console. O LiveKit será observado pelo endpoint Prometheus interno; seu formato e disponibilidade serão conferidos na versão usada pelo projeto.

## Instrumentação

- **API (`fazol-app`):** carregar o SDK OpenTelemetry antes do Express e das bibliotecas instrumentadas, considerando ESM e `fetch`/Undici. Criar spans de requisições HTTP e das chamadas ao gravador, com propagação W3C `traceparent`. Exportar duração, volume e status das requisições e métricas do processo. Padronizar os logs operacionais existentes com severidade, serviço e contexto de trace. Registrar erros sem repetir cabeçalhos, cookies ou payloads.
- **Gravador (`fazol-recorder`):** inicializar OpenTelemetry antes do servidor HTTP. Extrair o contexto de trace recebido da API. Criar spans para pedidos de clipe, espera de segmentos e execução de ffmpeg/ffprobe, com status de erro e duração. Medir resultado e duração dos clipes e quantidade de salas/gravações ativas. Publicar logs de processamento e de background com severidade e serviço.
- **LiveKit (`fazol-livekit`):** configurar o endpoint de métricas e scraping interno. Observar os sinais disponíveis de salas, participantes, banda e falhas; não assumir nomes de séries sem verificá-los.

Os nomes de serviço e o ambiente são recursos comuns dos três sinais. Métodos, rotas normalizadas, resultados e códigos HTTP são dimensões de métricas. IDs de usuário, canal, sala, clipe e URLs completas não serão dimensões. Rotas dinâmicas usam o padrão da rota, e consultas de URL, tokens OAuth e conteúdos de clipes ficam fora da telemetria. Captura de exceções será configurada para não expor URLs com credenciais.

## Operação e limites

Observabilidade deve ser habilitada explicitamente por configuração. Sem habilitá-la, os serviços mantêm o comportamento atual. Com o collector indisponível, exportação acontece em lotes com filas e timeouts limitados, sem impedir servir HTTP ou gerar clipes. Evitar tentativas por pacote RTP, frame ou segmento no caminho de mídia; medir operações e estados agregados.

O projeto terá instruções para subir, verificar, parar e atualizar a stack, configurar recursos e retenção e encontrar os serviços no APM, nos logs e no explorador de métricas do SigNoz. A documentação deve indicar a memória adicional exigida pelo SigNoz, separadamente dos requisitos atuais do Faz o L. Padrão proposto: sete dias de logs e traces; retenção de métricas e ajustes de capacidade serão documentados conforme a versão fixada.

Esta entrega não exige um provedor externo de notificações nem cria regras de alerta com limites inventados. O APM e os exploradores nativos do SigNoz serão o ponto inicial para a investigação. Dashboards específicos, alertas e instrumentação do desktop podem ser evoluídos com dados reais depois da ingestão validada.

## Verificação e critérios de aceite

1. Preservar as alterações do desktop no checkout original e manter todas as mudanças desta entrega na branch de observabilidade.
2. Validar sintaxe, smoke test atual do app e testes/build do gravador.
3. Validar Compose com Caddy e Traefik, tanto sem observabilidade quanto com o overlay.
4. Testar exportação com receptor OTLP local: verificar a mesma identidade de trace na chamada API → gravador, erros, métricas e logs relacionados. Os testes não dependem de Discord ou de um servidor remoto.
5. Testar que desabilitar a telemetria ou perder o collector não impede as rotas instrumentadas de responder.
6. Com Docker disponível, subir a stack SigNoz isolada e comprovar ingestão de requisição de teste, logs e métricas. Uma gravação real com ffmpeg depende de uma live; se ela não estiver disponível, declarar essa limitação, sem afirmar que o fluxo completo foi validado.
7. Conferir que endpoints de observabilidade não foram publicados por Caddy/Traefik e que os exemplos não contêm segredos.

## Decisões delegadas à implementação

Escolher versões compatíveis e fixadas do SDK, collector, SigNoz e Foundry; definir os arquivos e scripts mínimos; adaptar os detalhes de rede ao Compose gerado; e resolver escolhas de bibliotecas de logs sem alterar contratos da API. Mudanças que aumentem o escopo ou exijam um serviço externo voltam ao usuário.

## Referências consultadas

- [Instalação própria com Docker e Foundry](https://signoz.io/docs/install/docker/)
- [Exemplo oficial de Compose do Foundry](https://github.com/SigNoz/foundry/tree/main/docs/examples/docker/compose)
- [Instrumentação Node.js](https://signoz.io/docs/instrumentation/javascript/opentelemetry-nodejs/)
- [Instrumentação Go](https://signoz.io/docs/instrumentation/opentelemetry-golang/)
