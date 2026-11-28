# Migrar a instalação existente para o Coolify

O script `scripts/setup-coolify.py` usa Python 3.9+ e a API do Coolify. Foi preparado
contra o contrato da versão **4.7.9**. O cadastro pode ser feito antes de publicar
o código. A migração de containers exige que o Compose esteja publicado no GitHub.

O projeto e a aplicação criados chamam-se **Faz o L**, no ambiente **production**.
O script não altera Razao Mais, o próprio Coolify, o firewall ou o proxy.

## 1. Copiar o script e cadastrar

No Windows, com o Tailscale conectado:

```powershell
scp scripts\setup-coolify.py root@<IP-TAILSCALE-DA-VPS>:/tmp/setup-coolify.py
```

No Coolify, habilite a API nas configurações da instância, se necessário. Em
**Keys & Tokens → API tokens**, crie um token com permissões de leitura, escrita e
deploy. Cole o token somente no prompt oculto do script na VPS. O script não salva
o token, não o coloca em argumentos de processos e não exibe respostas com segredos.

No terminal da VPS:

```bash
python3 /tmp/setup-coolify.py --install-dir /opt/faz-o-l --dry-run
python3 /tmp/setup-coolify.py --install-dir /opt/faz-o-l
```

Use `sudo python3` se não estiver como root. Se Python não estiver instalado em
Debian/Ubuntu: `sudo apt-get update && sudo apt-get install -y python3`.

A prévia identifica os volumes sem fazer chamadas à API. O cadastro preserva o
site atual, importa as configurações usando o parser do Docker Compose e salva
apenas IDs e nomes de volumes em `/opt/faz-o-l/.coolify-migration/state.json`.
Esse arquivo não contém tokens ou valores do `.env`. Reexecutar o cadastro
reutiliza os IDs salvos. O script não faz `git pull`, commit ou push.

Se houver vários servidores, informe `--server-uuid UUID`. O padrão seleciona
exatamente um servidor chamado `localhost`. `--api-url` permite outro endereço;
o padrão local é `http://127.0.0.1:8000`.

## 2. Publicar o código e fazer a primeira migração

Antes de migrar, publique na branch `main` o Compose `docker-compose.coolify.yml`,
o código atual da aplicação e os arquivos de workflow. Enquanto houver mudanças
somente locais, não clique em Deploy no painel. O script com `--deploy` confere o
Compose da branch remota e bloqueia a troca se ele estiver ausente ou diferente.
Nenhuma publicação é feita pelo script.

Quando a publicação tiver sido revisada e os testes concluídos, execute na VPS,
em um momento sem transmissões ou criação de clipes:

```bash
python3 /tmp/setup-coolify.py --install-dir /opt/faz-o-l --deploy
```

O script fixa o commit encontrado na branch, para os três containers antigos,
salva um snapshot consistente do volume do banco e solicita o deploy ao Coolify.
Banco e clipes continuam nos mesmos volumes, declarados como **externos** para
evitar a criação de volumes vazios. Os containers antigos ficam parados,
disponíveis para recuperação; não são excluídos. As lives são interrompidas durante
a troca. O snapshot fica em `.coolify-migration/backup-*/appdata.tar.gz`.

Se o deploy falhar, o script tenta cancelar a execução e parar a aplicação nova.
Só reativa os containers antigos depois de confirmar que não há outro container
em execução usando o volume do banco. Se não conseguir essa confirmação, deixa
a instalação antiga parada e informa a necessidade de intervenção. Não restaura
o snapshot automaticamente, pois isso poderia descartar gravações feitas após a
troca. Alterações de esquema do banco exigem avaliação antes de voltar a código
antigo. Confira os logs de deploy no painel em caso de falha.

Depois da migração, use o **Coolify** para os próximos deploys. Não execute
`./install.sh update` nem suba o Compose antigo em paralelo: isso pode causar
conflito nas portas e dois processos usando o mesmo banco.

Valide login, canais, reprodução, uma transmissão e criação de um clipe depois da
troca. Esses fluxos reais não são simulados pela confirmação de saúde da API.

## 3. Deploy automático após testes e release pela rede Tailscale

O painel restrito ao Tailscale não recebe webhooks públicos do GitHub. O workflow
`Deploy VPS (Coolify)` conecta um runner temporário à rede privada e chama a API
do Coolify. Ele espera os workflows **CI** e **App desktop (Windows)** terem sucesso
para o mesmo commit de push na `main`, ignora commits já substituídos na branch e
fixa o commit aprovado antes de pedir o deploy. A segunda conclusão dos workflows
não deve duplicar um deploy já enfileirado, em execução ou concluído.

O cadastro deixa a opção de auto-deploy por webhook desativada. O workflow chama a
API diretamente; não precisa marcar "Deploy on push (webhooks)" no painel.

Configure no GitHub em **Settings → Secrets and variables → Actions**:

| Tipo | Nome | Valor |
|---|---|---|
| Variable | `COOLIFY_URL` | `http://<IP-TAILSCALE-DA-VPS>:8000` |
| Variable | `COOLIFY_TAILSCALE_HOST` | `<IP-TAILSCALE-DA-VPS>` |
| Variable | `COOLIFY_APP_UUID` | UUID exibido pelo script |
| Variable | `COOLIFY_DEPLOY_ENABLED` | `true`, somente após concluir a primeira migração |
| Secret | `COOLIFY_TOKEN` | Token do Coolify com leitura, escrita e deploy |
| Secret | `TS_OAUTH_CLIENT_ID` | Client ID do cliente OAuth do Tailscale |
| Secret | `TS_OAUTH_SECRET` | Secret do cliente OAuth do Tailscale |

No Tailscale, crie a tag `tag:github-actions`, atribua a ela acesso TCP à VPS na
porta **8000** e crie um cliente OAuth com permissão **Auth Keys → Write**, limitado
a essa tag. Não é necessário liberar a porta no firewall público. Ajuste a política
da tailnet existente em vez de substituí-la. O runner não precisa acessar SSH.

O workflow fica inativo enquanto `COOLIFY_DEPLOY_ENABLED` não for `true`. O sucesso
do workflow de acionamento confirma apenas que o pedido foi aceito. A conclusão
do deploy e eventuais erros de build aparecem nos logs do Coolify.

Não há atualização periódica no app desktop; ele continua consultando releases
somente ao abrir. Após atualizar a VPS, novos acessos e recargas buscam o código web
atualizado. Abas já abertas não são recarregadas à força.

Referências: [API do Coolify](https://coolify.io/docs/api/endpoints/applications/create-public-application),
[Compose e volumes externos](https://coolify.io/docs/applications/builds/docker-compose),
[GitHub Actions na rede Tailscale](https://tailscale.com/docs/integrations/github/github-action).
