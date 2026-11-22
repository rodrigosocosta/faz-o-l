# Faz o L 📺

Transmissão de tela **com áudio**, em **1080p/720p** e com **quase zero de delay** para a galera do seu servidor do Discord. Self-hosted numa VPS e sobe com um comando.

- 🎥 Até **2 pessoas transmitindo ao mesmo tempo**
- 👀 Até **15 espectadores**, que podem **assistir às 2 lives juntas** (lado a lado ou com uma em destaque)
- 🔊 Som do jogo/vídeo junto com a tela (estéreo, 128 kbps)
- ⚡ WebRTC: atraso típico de **100–300 ms**
- 🎚️ Quem assiste escolhe a qualidade (Original/Economia) e o volume de cada live
- 🤖 Bot do Discord: comando `/live` e aviso no canal quando alguém começa a transmitir
- 🔐 Login com a conta do Discord, podendo liberar só pra membros do seu servidor
- 🐳 Docker Compose + HTTPS automático (Let's Encrypt)

> **Por que um site, e não o Go Live dentro do Discord?** A API do Discord não deixa bots enviarem vídeo nem transmitirem tela. Então o Faz o L é um site com servidor de vídeo próprio, e o bot faz a ponte com o Discord (link, avisos, login).

## Como funciona

```
 Streamer (navegador)                               Espectadores (navegador)
   tela + áudio ──WebRTC──▶ ┌───────────── VPS ─────────────┐ ──WebRTC──▶ até 15 pessoas
                            │ Caddy ou Traefik (HTTPS)      │
                            │  ├─ app (Node): site, login,  │
                            │  │   vagas, bot do Discord    │◀──▶ Discord (bot /live + avisos)
                            │  └─ LiveKit (SFU WebRTC)      │
                            └───────────────────────────────┘
```

O streamer envia o vídeo **uma vez** pra VPS e o [LiveKit](https://livekit.io) (servidor de mídia open source) repassa pra cada espectador, sem recodificar. Por isso o atraso fica baixo. O vídeo também vai numa segunda versão menor (simulcast), que é a opção "Economia" pra quem tem internet fraca.

## Requisitos

| | Mínimo | Recomendado |
|---|---|---|
| VPS | 1 vCPU, 1 GB RAM | 2 vCPU, 2 GB RAM |
| Sistema | Linux com Docker (Ubuntu 22.04/24.04 recomendado) | |
| Domínio | Um (sub)domínio apontando pro IP da VPS (dá pra usar o [DuckDNS](https://www.duckdns.org) de graça) | |
| Banda de upload da VPS | ~100 Mbps | 250 Mbps+ |

**A banda é o que mais pesa.** Cada espectador recebe cada live que está assistindo:

| Qualidade | Por live | 15 pessoas × 2 lives |
|---|---|---|
| 1080p 60fps | ~8 Mbps | ~240 Mbps |
| 1080p 30fps (padrão) | ~5 Mbps | ~150 Mbps |
| 720p 30fps | ~2,5 Mbps | ~75 Mbps |
| Modo "Economia" | ~1–2,5 Mbps | ~30–75 Mbps |

Atenção também ao **limite de tráfego mensal** da VPS: 150 Mbps durante 1 hora dá ~67 GB.

## Instalação (5 minutos)

### 1. Prepare o Discord (opcional, mas recomendado)

1. Abra o [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → nome "Faz o L".
2. **OAuth2** → copie o **Client ID** e o **Client Secret** e, em **Redirects**, adicione `https://SEU_DOMINIO/auth/callback`.
3. **Bot** → **Reset Token** e copie o token. Não precisa ligar nenhum "Privileged Intent".
4. No Discord, ligue o **Modo desenvolvedor** (Configurações → Avançado) para copiar com o botão direito o **ID do servidor** e o **ID do canal** de avisos.

Sem nada disso o site funciona igual: qualquer pessoa com o link entra digitando um apelido.

### 2. Na VPS

Aponte o domínio (registro **A**) para o IP da VPS e rode:

```bash
git clone https://github.com/rodrigosocosta/faz-o-l.git && cd faz-o-l && ./install.sh
```

O instalador instala o Docker se precisar, pergunta domínio e dados do Discord, gera as senhas e sobe tudo. No final ele mostra o link pra convidar o bot.

**Já usa Coolify (ou Traefik) na VPS?** Pode instalar igual. O `install.sh` percebe que as portas 80/443 já são do Traefik e usa o proxy dele pro HTTPS, sem mexer nos seus outros apps. O Faz o L continua fora do painel do Coolify, gerenciado pelo `docker compose`.

<details>
<summary>Como funciona por baixo / Traefik que não é do Coolify</summary>

O `docker-compose.yml` tem só o LiveKit e o app. O HTTPS vem de um arquivo extra, que o instalador grava em `COMPOSE_FILE` no `.env`:

- `docker-compose.caddy.yml`: VPS limpa, Caddy próprio nas portas 80/443.
- `docker-compose.traefik.yml`: Traefik existente (via labels). Os padrões são os do Coolify v4. Pra outro Traefik, defina no `.env` `TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT_HTTP`, `TRAEFIK_ENTRYPOINT_HTTPS` e `TRAEFIK_CERTRESOLVER`, e use `COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml`.

</details>

### 3. Libere as portas

No firewall do painel da VPS (Hostinger, Contabo, Oracle etc.). O `ufw` o script já configura:

| Porta | Pra quê |
|---|---|
| 80/tcp, 443/tcp | Site + HTTPS (certificado automático) |
| 7882/udp | Vídeo WebRTC (principal) |
| 7881/tcp | Vídeo WebRTC (plano B pra redes que bloqueiam UDP) |

Pronto: abra `https://SEU_DOMINIO` ou use `/live` no Discord.

## Como usar

**Canais:** cada servidor do Discord vira um canal de transmissão, com a sua sala, os seus clipes e os seus avisos.
- Quem está em `CREATOR_DISCORD_IDS` vê o botão **Criar canal num servidor do Discord** no site. Esse botão coloca o bot no servidor e transforma essa pessoa no **dono** do canal.
- Só o dono convida: botão **⚙ Canal** no site (links que expiram em 1, 7 ou 30 dias, com limite de usos opcional) ou o comando `/convite` no Discord. Ali ele também escolhe os canais de texto dos avisos de live e dos clipes, e remove membros.
- Se o bot for adicionado a um servidor por fora do site, ele sai sozinho depois de 1 minuto.

**Clipes e perfis:** depois de clipar dá pra pôr título e descrição (os dois opcionais). As durações do ✂ Clipar (de 10 s a 3 min) e, no app desktop, os atalhos globais (padrão **Ctrl+F9** 30 s, **Ctrl+F10** 1 min e **Ctrl+F11** 3 min) são configuráveis em Transmitir → Botões de clipe. Os atalhos clipam a sua live ou a que estiver em destaque e publicam direto. Quem for marcado com `@usuario` (o @ do Discord) fica com o clipe no perfil. O perfil (`/u/usuario`, clicando no nome de alguém) mostra os clipes feitos das lives da pessoa e os clipes em que ela foi marcada. Só aparecem clipes dos canais em que quem está vendo também é membro.

**Pra transmitir:** use Chrome ou Edge no computador → **Transmitir minha tela** → escolha a tela/janela/aba.
- **Windows:** marque **"Compartilhar áudio do sistema"** ao escolher a tela inteira.
- **Aba do navegador** (YouTube, Netflix etc.): marque **"Compartilhar áudio da guia"**. Funciona em qualquer sistema.
- **macOS/Linux:** o navegador só captura áudio de **abas**, não do sistema inteiro.
- **Jogo / vídeo** prioriza fluidez; **Texto / código** prioriza nitidez.

**Pra assistir:** qualquer navegador, inclusive celular. Passe o mouse na live pra mexer no volume, na qualidade, no destaque (⤢) ou na tela cheia (⛶, ou duplo clique).

## Comandos úteis

```bash
docker compose logs -f app       # logs do site/bot
docker compose logs -f livekit   # logs do servidor de vídeo
./install.sh update              # baixa a versão nova e reinicia
./install.sh discord             # configura/altera bot e login do Discord depois da instalação
docker compose down              # desliga tudo
```

## Configuração (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `DOMAIN` | — | Domínio do site (obrigatório) |
| `MAX_STREAMERS` | `2` | Pessoas transmitindo ao mesmo tempo |
| `MAX_VIEWERS` | `15` | Espectadores |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | — | Ativam o login com Discord |
| `CREATOR_DISCORD_IDS` | — | IDs de usuário do Discord que podem criar canais (colocar o bot num servidor) |
| `DISCORD_BOT_TOKEN` | — | Ativa o bot (`/live`, `/convite`, avisos de live e clipes) |
| `LIVEKIT_NODE_IP` | auto | IP público da VPS |
| `LIVEKIT_VERSION` | `v1.13.11` | Tag da imagem `livekit/livekit-server` |

Depois de editar o `.env`: `docker compose up -d`.

## Desenvolvimento local

Precisa de Node 20+ e do [LiveKit](https://docs.livekit.io/home/self-hosting/local/) instalado.

```bash
livekit-server --dev            # sobe o LiveKit em ws://localhost:7880 (chave devkey / secret)
```

```bash
cd app && npm install
SESSION_SECRET=dev LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret LIVEKIT_PUBLIC_URL=ws://localhost:7880 npm run dev
```

Abra http://localhost:3000. O `localhost` conta como contexto seguro, então a captura de tela funciona sem HTTPS. Os avisos do bot dependem dos webhooks do LiveKit, que no modo `--dev` não vêm configurados.

## Problemas comuns

- **Fica em "Conectando…" / sem vídeo:** a porta **7882/udp** (ou 7881/tcp) está bloqueada no firewall do provedor da VPS.
- **Certificado HTTPS não sai:** o DNS ainda não aponta pra VPS, ou a porta 80 está fechada. Veja com `docker compose logs caddy` (ou, com Coolify, `docker logs coolify-proxy`).
- **Live sem som:** a caixa de compartilhar áudio não foi marcada na janela do navegador, ou você está no macOS compartilhando uma janela (só abas têm áudio lá).
- **Travando para quem assiste:** escolha **Economia** na live, ou transmita em 720p/30fps.
- **"Você não é membro deste canal":** peça um link de convite pro dono do canal (botão ⚙ Canal no site ou `/convite` no Discord).

## Stack

[LiveKit](https://github.com/livekit/livekit) (SFU WebRTC) · Node.js + Express · [discord.js](https://discord.js.org) · Caddy ou Traefik · HTML/CSS/JS sem build.

## Licença

[MIT](LICENSE)
