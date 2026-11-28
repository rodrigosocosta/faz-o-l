# Faz o L — app desktop (Windows)

App nativo para **transmitir** com mais qualidade e fluidez do que pelo navegador. Para assistir, o app abre o mesmo site do servidor, então nada muda para quem só assiste.

| | Navegador | App desktop |
|---|---|---|
| Captura | O navegador copia os quadros | Windows Graphics Capture (GPU) |
| Qualidade | até 1080p60 | até **1440p60**, bitrate maior |
| Codec | H.264 | **H.264, VP9 ou AV1** |
| Áudio | Sistema ou aba (pode pegar eco) | **Sistema inteiro menos o próprio app** (sem eco) |
| RAM | Chrome inteiro | ~100 MB (Tauri + WebView2) |

> **Versão 0.1:** a codificação ainda é feita pela CPU (o SDK de Rust do LiveKit não usa NVENC/AMF/QuickSync no Windows). A codificação pela placa de vídeo é o próximo passo.

## Como funciona

- **Tauri 2**: janela leve usando o WebView2 que já vem no Windows. Ela carrega o site do seu servidor do Faz o L.
- Quando a página está dentro do app, o botão **Transmitir** chama o núcleo em Rust ([src-tauri/src](src-tauri/src)):
  - [`capture.rs`](src-tauri/src/capture.rs): captura do monitor (Windows Graphics Capture) → I420.
  - [`audio.rs`](src-tauri/src/audio.rs): áudio WASAPI por processo, no modo que *exclui* o próprio app.
  - [`stream.rs`](src-tauri/src/stream.rs): conecta no LiveKit (SDK oficial em Rust) e publica a tela e o áudio.
- O app transmite como o participante `<seu id>:tela`, com um token que o servidor emite em `/api/desktop/token`.
- Só o site do servidor configurado consegue chamar os comandos nativos (capability remota do Tauri).

## Compilar

Pré-requisitos (uma vez só):

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```bash
winget install --id Rustlang.Rustup -e
```

E o Node 20+ para a CLI do Tauri.

Gerar o instalador:

```bash
cd desktop && npm install && npm run build
```

O instalador sai em `desktop/src-tauri/target/release/bundle/nsis/`.

Para o app já abrir o seu servidor sem perguntar, defina o endereço na compilação:

```bash
FAZOL_SERVER_URL=https://live.seudominio.com npm run build
```

Sem isso, na primeira vez o app pede o endereço do servidor (fica salvo em `%APPDATA%\com.fazol.desktop\server.txt`; apague o arquivo para trocar).

## Releases automáticas

Todo push na `main` (incluindo merges de PRs, mesmo que alterem apenas o site)
compila o instalador Windows e publica uma Release no GitHub quando o build termina
com sucesso. A tag é `vX.Y.Z`, incrementando o patch da maior versão entre as tags
existentes e a configuração do app. Por exemplo, `v0.1.9` gera `v0.1.10`.
Reexecutar um commit que já tem uma tag estável reutiliza essa versão.

As tags manuais `alpha-X.Y.Z`, `beta-X.Y.Z`, `rc-X.Y.Z` e `vX.Y.Z` continuam
publicando a versão indicada. A execução manual pela aba Actions publica uma
release quando usa a `main` ou uma tag válida; em outras branches, gera apenas
o instalador nos Artifacts. As publicações são serializadas; o GitHub mantém
uma execução ativa e uma pendente, podendo substituir a pendente por um push
mais recente.

Configure `FAZOL_SERVER_URL` nas variáveis do Actions para embutir o servidor.
A publicação exige a assinatura e o `latest.json` necessários para atualizar os apps. Configure
os secrets `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
correspondentes à chave pública de `src-tauri/tauri.conf.json`. Sem a chave privada,
o workflow falha antes de compilar/publicar uma release. Builds manuais de outras
branches ainda podem gerar instaladores sem atualização automática.

O `./install.sh update` continua atualizando os containers na VPS; a release
é publicada pelo GitHub Actions após o push na `main`.

## Atualização automática do app instalado

O app consulta a última release ao abrir. Ao encontrar uma versão superior,
baixa em segundo plano, valida a
assinatura e instala/reabre automaticamente. Se houver uma transmissão nativa em
andamento, aguarda ela terminar para instalar. O botão **Procurar atualização**
continua permitindo uma consulta imediata nas configurações.

Falhas aparecem no log. Para tentar novamente, use **Procurar atualização** ou
reabra o app. Consultas simultâneas são ignoradas enquanto já houver uma
verificação, download, espera pela transmissão ou instalação.

Quem estiver apenas assistindo pode ter
a janela reiniciada: a espera atual protege a transmissão nativa. O site e os
containers da VPS continuam sendo atualizados com `./install.sh update`.

## Aviso do Windows na instalação

Sem assinatura de código, o Windows mostra **"O Windows protegeu o computador"**. Clique em **Mais informações → Executar assim mesmo**. Para tirar o aviso é preciso assinar o instalador (ex.: Azure Trusted Signing).
