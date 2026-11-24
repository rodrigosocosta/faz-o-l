# Logs de navegador e desktop

Escopo autorizado: encaminhar logs dos clientes ao SigNoz já instalado na VPS.

- O cliente web captura erros não tratados e console.warn/error após login.
- O desktop preserva o arquivo local e mantém 120 eventos em uma fila nativa.
- O site servido dentro do Tauri drena até 30 eventos por chamada e os encaminha com seu cookie HTTP-only; clientes antigos continuam funcionando.
- POST /api/client-logs exige sessão e Origin igual ao servidor, JSON de até 32 KiB, até 30 eventos e 120 eventos por minuto por usuário. Filas de clientes têm limite de 120 eventos; cada lote fica abaixo de 24 KiB.
- O backend sanitiza as mensagens, aceita somente atributos definidos pelo servidor e usa o exporter OpenTelemetry existente. Nenhuma credencial SigNoz é enviada aos clientes.
- Logs aparecem sob service.name=fazol-app, filtráveis por client.platform (browser/desktop), client.version e client.target. São relatos do cliente, não evidência de segurança.
- Não são capturados corpos de requisição, cookies, telas, áudio, histórico de navegação nem objetos completos de exceção. O texto de mensagens operacionais passa pelo saneamento do servidor.
- Logs de clientes sem sessão não são enviados. Filas são descartáveis; falhas de rede não bloqueiam o uso do app. Erros anteriores à inicialização da página podem não ser capturados.

Verificação: testes HTTP reais do endpoint e OTLP, testes de fila e transporte, teste Rust independente da fila e cargo check. A ativação de logs nativos exige distribuir uma nova compilação desktop; atualizar só a VPS ativa os logs da página web/webview.
