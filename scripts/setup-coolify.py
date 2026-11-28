#!/usr/bin/env python3
"""Register an existing Faz o L installation in Coolify; --deploy performs cutover."""
import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = 'https://github.com/rodrigosocosta/faz-o-l'
COMPOSE_LOCATION = '/docker-compose.coolify.yml'
ENV_KEYS = ('DOMAIN LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_NODE_IP LIVEKIT_VERSION LIVEKIT_PUBLIC_URL '
            'SESSION_SECRET MAX_STREAMERS MAX_VIEWERS ROOM_NAME DISCORD_CLIENT_ID '
            'DISCORD_CLIENT_SECRET DISCORD_BOT_TOKEN CREATOR_DISCORD_IDS DISCORD_GUILD_ID '
            'DISCORD_NOTIFY_CHANNEL_ID DISCORD_CLIPS_CHANNEL_ID TRAEFIK_NETWORK '
            'TRAEFIK_ENTRYPOINT_HTTP TRAEFIK_ENTRYPOINT_HTTPS TRAEFIK_CERTRESOLVER').split()


class SetupError(Exception):
    pass


def compose_spec():
    # JSON is also valid YAML: one dependency-free template for the script and Git.
    def labels(service, port, route):
        prefix = 'traefik.http.routers.fazol-' + service
        return ['traefik.enable=true', 'traefik.docker.network=${TRAEFIK_NETWORK:-coolify}',
                prefix + '.rule=' + route,
                prefix + '.entrypoints=${TRAEFIK_ENTRYPOINT_HTTPS:-https}',
                prefix + '.tls=true',
                prefix + '.tls.certresolver=${TRAEFIK_CERTRESOLVER:-letsencrypt}',
                prefix + '.service=fazol-' + service,
                'traefik.http.services.fazol-' + service + '.loadbalancer.server.port=' + str(port)]
    app_labels = labels('app', 3000, 'Host(`${DOMAIN}`)') + [
        'traefik.http.middlewares.fazol-https.redirectscheme.scheme=https',
        'traefik.http.routers.fazol-http.rule=Host(`${DOMAIN}`)',
        'traefik.http.routers.fazol-http.entrypoints=${TRAEFIK_ENTRYPOINT_HTTP:-http}',
        'traefik.http.routers.fazol-http.middlewares=fazol-https',
        'traefik.http.routers.fazol-http.service=fazol-app']
    livekit_config = '''port: 7880
logging:
  level: info
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
  node_ip: "${LIVEKIT_NODE_IP:-}"
keys:
  ${LIVEKIT_API_KEY:?Defina LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET:?Defina LIVEKIT_API_SECRET}
webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - http://fazol-app:3000/api/livekit/webhook
room:
  empty_timeout: 300
'''
    app_env = {k: '${' + k + ':-}' for k in ENV_KEYS if not k.startswith('TRAEFIK_')}
    app_env.update({'LIVEKIT_HOST': 'http://fazol-livekit:7880',
                    'PUBLIC_URL': 'https://${DOMAIN:?Defina DOMAIN}',
                    'RECORDER_URL': 'http://fazol-recorder:8090', 'CLIPS_DIR': '/data/clips',
                    'DB_FILE': '/data/app/fazol.db', 'MAX_STREAMERS': '${MAX_STREAMERS:-2}',
                    'MAX_VIEWERS': '${MAX_VIEWERS:-15}', 'ROOM_NAME': '${ROOM_NAME:-faz-o-l}',
                    'SESSION_SECRET': '${SESSION_SECRET:?Preserve SESSION_SECRET}'})
    # Coolify rejects :? inside volume names, but accepts it in environment values.
    # Keep Compose's required-value checks here so missing settings still fail.
    for name in ('clips', 'appdata', 'recorder_buffer'):
        key = 'FAZOL_' + name.upper() + '_VOLUME'
        app_env[key] = '${' + key + ':?Informe o volume existente}'
    return {
        'services': {
            'livekit': {'image': 'livekit/livekit-server:${LIVEKIT_VERSION:-v1.13.11}',
                        'restart': 'unless-stopped', 'ports': ['7881:7881/tcp', '7882:7882/udp'],
                        'networks': {'default': {'aliases': ['fazol-livekit']}, 'traefik': {}},
                        'environment': {'LIVEKIT_CONFIG': livekit_config},
                        'labels': labels('rtc', 7880, 'Host(`${DOMAIN}`) && PathPrefix(`/rtc`)')},
            'app': {'build': './app', 'restart': 'unless-stopped',
                    'networks': {'default': {'aliases': ['fazol-app']}, 'traefik': {}},
                    'environment': app_env, 'labels': app_labels,
                    'volumes': ['clips:/data/clips', 'appdata:/data/app']},
            'recorder': {'build': './recorder', 'restart': 'unless-stopped',
                         'networks': {'default': {'aliases': ['fazol-recorder']}},
                         'environment': {'LIVEKIT_WS_URL': 'ws://fazol-livekit:7880',
                                         'LIVEKIT_API_KEY': '${LIVEKIT_API_KEY}',
                                         'LIVEKIT_API_SECRET': '${LIVEKIT_API_SECRET}',
                                         'CLIPS_DIR': '/data/clips', 'BUFFER_DIR': '/data/buffer'},
                         'volumes': ['clips:/data/clips', 'recorder_buffer:/data/buffer'],
                         'depends_on': ['livekit']}},
        'volumes': {name: {'external': True, 'name': '${FAZOL_' + name.upper() + '_VOLUME}'}
                    for name in ('clips', 'appdata', 'recorder_buffer')},
        'networks': {'traefik': {'external': True, 'name': '${TRAEFIK_NETWORK:-coolify}'}}}


def run(command, timeout=120):
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (subprocess.SubprocessError, OSError) as error:
        # Docker/Compose error output can contain environment values. Do not echo it.
        raise SetupError('Falha no comando ' + command[0] + '. Confira o serviço e as permissões; nenhum segredo foi exibido.') from error


def private_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
    path.chmod(0o600)


def save_state(path, state):
    private_json(path, {k: v for k, v in state.items() if k != 'env'})


def volume_at(mounts, destination):
    for mount in mounts:
        if mount['Destination'] == destination and mount['Type'] == 'volume' and mount.get('Name'):
            return mount['Name']
    raise SetupError('Não encontrei um volume Docker existente em ' + destination + '. Migração interrompida.')


def application_env(environment):
    values = {k: str(v) for k, v in environment.items() if k in ENV_KEYS}
    domain = urllib.parse.urlparse(environment.get('PUBLIC_URL', '')).hostname
    if domain:
        values['DOMAIN'] = domain
    if not values.get('DOMAIN'):
        raise SetupError('DOMAIN/PUBLIC_URL não encontrado na instalação.')
    return values


def discover(directory):
    if not (directory / '.env').is_file():
        raise SetupError('O diretório precisa conter o .env da instalação atual.')
    compose = json.loads(run(['docker', 'compose', '--project-directory', str(directory),
                             '--env-file', str(directory / '.env'), '-f', str(directory / 'docker-compose.yml'),
                             '-f', str(directory / 'docker-compose.traefik.yml'), 'config', '--format', 'json']))
    project = compose['name']
    if project == 'coolify':
        raise SetupError('O projeto Docker não pode ser o próprio Coolify.')
    ids = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).split()
    if not ids:
        raise SetupError('Não encontrei os containers da instalação atual.')
    containers = json.loads(run(['docker', 'inspect', *ids]))
    services = {}
    for container in containers:
        labels = container['Config'].get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if name in ('app', 'recorder', 'livekit'):
            if name in services:
                raise SetupError('Mais de um container do serviço ' + name + '. Confira a instalação.')
            services[name] = container
    if set(services) != {'app', 'recorder', 'livekit'}:
        raise SetupError('Precisamos encontrar app, recorder e livekit antes da migração.')
    env = application_env(compose['services']['app']['environment'])
    for key in ('LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'SESSION_SECRET'):
        if not env.get(key):
            raise SetupError('Variável obrigatória ausente: ' + key)
    volumes = {'appdata': volume_at(services['app']['Mounts'], '/data/app'),
               'clips': volume_at(services['app']['Mounts'], '/data/clips'),
               'recorder_buffer': volume_at(services['recorder']['Mounts'], '/data/buffer')}
    if volume_at(services['recorder']['Mounts'], '/data/clips') != volumes['clips']:
        raise SetupError('API e gravador não compartilham o mesmo volume de clipes.')
    for name, volume in volumes.items():
        run(['docker', 'volume', 'inspect', volume])
        env['FAZOL_' + name.upper() + '_VOLUME'] = volume
    run(['docker', 'network', 'inspect', env.get('TRAEFIK_NETWORK') or 'coolify'])
    return {'env': env, 'volumes': volumes, 'project': project,
            'containers': [services[n]['Id'] for n in ('app', 'recorder', 'livekit')],
            'backup_image': services['app']['Image']}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class API:
    def __init__(self, url, token):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise SetupError('URL do Coolify inválida.')
        if parsed.scheme == 'http' and parsed.hostname != 'localhost':
            try:
                address = ipaddress.ip_address(parsed.hostname)
                allowed = address.is_loopback or address in ipaddress.ip_network('100.64.0.0/10')
            except ValueError:
                allowed = False
            if not allowed:
                raise SetupError('Use HTTPS ou um endereço local/Tailscale para informar o token.')
        self.base = url.rstrip('/') + '/api/v1'
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect)

    def __call__(self, method, path, data=None):
        request = urllib.request.Request(self.base + path, method=method,
                    headers={'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json',
                             'Content-Type': 'application/json'},
                    data=None if data is None else json.dumps(data).encode())
        try:
            with self.opener.open(request, timeout=30) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as error:
            context = method + ' ' + path
            if error.code == 422:
                fields = []
                try:
                    body = json.loads(error.read(65536))
                    errors = body.get('errors', {})
                    if isinstance(errors, dict):
                        # Only field names, never values or upstream error text.
                        fields = [key for key in errors if isinstance(key, str)
                                  and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]{0,79}', key)
                                  and self.token not in key][:12]
                except (ValueError, AttributeError, OSError):
                    pass
                detail = ' Campos recusados: ' + ', '.join(fields) + '.' if fields else ''
                raise SetupError('Coolify HTTP 422 em ' + context +
                                 ': validação dos dados enviados falhou.' + detail) from error
            hint = ' Confira o token e as permissões.' if error.code in (401, 403) else ' Confira a configuração da API.'
            raise SetupError('Coolify HTTP ' + str(error.code) + ' em ' + context + '.' + hint) from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise SetupError('Não foi possível ler a API do Coolify. Confira endereço e conexão.') from error


def register(api, state, state_path, server_uuid=None):
    if not state.get('server_uuid'):
        servers = api('GET', '/servers')
        choices = [s for s in servers if s['uuid'] == server_uuid] if server_uuid else [s for s in servers if s['name'] == 'localhost']
        if len(choices) != 1:
            raise SetupError('Não foi possível escolher o servidor. Informe --server-uuid.')
        state['server_uuid'] = choices[0]['uuid']
        save_state(state_path, state)
    if not state.get('project_uuid'):
        projects = [p for p in api('GET', '/projects') if p['name'] == 'Faz o L']
        if len(projects) > 1:
            raise SetupError('Há mais de um projeto chamado Faz o L. Confira o painel.')
        state['project_uuid'] = projects[0]['uuid'] if projects else api('POST', '/projects', {'name': 'Faz o L'})['uuid']
        save_state(state_path, state)
    settings = {'name': 'Faz o L', 'git_repository': state['repository'], 'git_branch': state['branch'],
                'git_commit_sha': 'HEAD', 'build_pack': 'dockercompose', 'base_directory': '/',
                'docker_compose_location': COMPOSE_LOCATION, 'is_raw_compose_deployment_enabled': True,
                'is_auto_deploy_enabled': False, 'is_preview_deployments_enabled': False,
                'instant_deploy': False}
    if not state.get('application_uuid'):
        payload = dict(settings, project_uuid=state['project_uuid'], server_uuid=state['server_uuid'],
                       environment_name='production', docker_compose_raw=json.dumps(compose_spec()))
        state['application_uuid'] = api('POST', '/applications/public', payload)['uuid']
        save_state(state_path, state)
    else:
        existing = api('GET', '/applications/' + state['application_uuid'])
        if existing.get('git_repository', '').rstrip('/').removesuffix('.git') != state['repository']:
            raise SetupError('A aplicação salva aponta para outro repositório. Nenhuma configuração foi alterada.')
        api('PATCH', '/applications/' + state['application_uuid'], settings)
    if state.get('env'):
        api('PATCH', '/applications/' + state['application_uuid'] + '/envs/bulk',
            {'data': [{'key': k, 'value': v, 'is_preview': False, 'is_literal': True}
                      for k, v in state['env'].items()]})


def published_commit(directory, state, command=run):
    origin = command(['git', '-C', str(directory), 'config', '--get', 'remote.origin.url'])
    normalized = origin.replace('git@github.com:', 'https://github.com/').rstrip('/').removesuffix('.git')
    if normalized != state['repository'].rstrip('/').removesuffix('.git'):
        raise SetupError('O origin da instalação não corresponde ao repositório cadastrado.')
    command(['git', '-C', str(directory), 'fetch', '--no-tags', 'origin', state['branch']])
    try:
        template = json.loads(command(['git', '-C', str(directory), 'show', 'FETCH_HEAD:' + COMPOSE_LOCATION.lstrip('/')]))
    except (SetupError, json.JSONDecodeError) as error:
        raise SetupError('O Compose do Coolify ainda não está publicado na branch. Publique os arquivos antes de usar --deploy.') from error
    if template != compose_spec():
        raise SetupError('O Compose publicado difere do script. Atualize o script antes de migrar.')
    commit = command(['git', '-C', str(directory), 'rev-parse', 'FETCH_HEAD'])
    if not re.fullmatch('[0-9a-f]{40,64}', commit):
        raise SetupError('Commit remoto inválido.')
    return commit


def stop_new_application(api, state, deployment_uuid, command, sleep):
    terminal = ('finished', 'failed', 'cancelled', 'cancelled-by-user')
    if deployment_uuid:
        if api('GET', '/deployments/' + deployment_uuid).get('status') not in terminal:
            api('POST', '/deployments/' + deployment_uuid + '/cancel', {})
            for _ in range(60):
                if api('GET', '/deployments/' + deployment_uuid).get('status') in terminal:
                    break
                sleep(2)
            else:
                raise SetupError('O cancelamento ainda não foi confirmado. A instalação antiga continua parada.')
    # Stop is queued by Coolify. Wait for all writers on the original DB to exit.
    api('POST', '/applications/' + state['application_uuid'] + '/stop', {'docker_cleanup': False})
    for _ in range(60):
        writers = command(['docker', 'ps', '-q', '--filter', 'volume=' + state['volumes']['appdata']])
        if not writers:
            return
        sleep(2)
    raise SetupError('Ainda há um container usando o banco. A instalação antiga continua parada.')


def cutover(api, state, directory, state_path, timeout=1800, command=run, sleep=time.sleep):
    # Every precondition is checked before stopping any existing container.
    commit = published_commit(directory, state, command)
    app = '/applications/' + state['application_uuid']
    jobs = api('GET', '/deployments/applications/' + state['application_uuid'] + '?take=30').get('deployments', [])
    if any(job.get('status') in ('queued', 'in_progress') for job in jobs):
        raise SetupError('Já há um deploy em andamento no Coolify. Aguarde antes de migrar.')
    api('PATCH', app, {'git_commit_sha': commit})
    snapshot_dir = state_path.parent / ('backup-' + time.strftime('%Y%m%d%H%M%S'))
    snapshot_dir.mkdir(mode=0o700)
    old_stopped = False
    deployment_requested = False
    deployment_uuid = None
    try:
        print('Parando a instalação antiga para migrar; as lives serão interrompidas.', flush=True)
        old_stopped = True
        command(['docker', 'stop', '--time', '30', *state['containers']])
        command(['docker', 'run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'tar',
                 '--mount', 'type=volume,source=' + state['volumes']['appdata'] + ',target=/source,readonly',
                 '--mount', 'type=bind,source=' + str(snapshot_dir) + ',target=/backup',
                 state['backup_image'], '-czf', '/backup/appdata.tar.gz', '-C', '/source', '.'])
        deployment_requested = True
        response = api('POST', app + '/start', {})
        deployment_uuid = response.get('deployment_uuid')
        if not deployment_uuid:
            raise SetupError('A API não informou o identificador do deploy.')
        print('Deploy ' + deployment_uuid + ' iniciado. Acompanhe os logs no Coolify.', flush=True)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = api('GET', '/deployments/' + deployment_uuid).get('status')
            if status == 'finished':
                health = api('GET', app).get('status', '')
                if health in ('running', 'running:healthy'):
                    state['migrated'] = True
                    save_state(state_path, state)
                    print('Migração concluída. Banco e clipes usam os volumes originais.', flush=True)
                    return
            elif status in ('failed', 'cancelled', 'cancelled-by-user'):
                raise SetupError('O primeiro deploy não terminou com sucesso.')
            sleep(5)
        raise SetupError('Tempo de espera do primeiro deploy esgotado.')
    except BaseException as failure:
        if old_stopped:
            print('Falha na migração. Tentando parar o deploy novo e reativar os containers antigos.', flush=True)
            try:
                if deployment_requested:
                    stop_new_application(api, state, deployment_uuid, command, sleep)
                command(['docker', 'start', *state['containers']])
                print('Containers antigos reativados. Snapshot do banco em ' + str(snapshot_dir), flush=True)
            except (SetupError, KeyboardInterrupt):
                print('Não foi possível concluir a recuperação. Pare a aplicação nova no Coolify antes de reativar a antiga.', file=sys.stderr)
        raise failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dir', default='/opt/faz-o-l')
    parser.add_argument('--api-url', default='http://127.0.0.1:8000')
    parser.add_argument('--repository', default=REPOSITORY)
    parser.add_argument('--branch', default='main')
    parser.add_argument('--server-uuid')
    parser.add_argument('--dry-run', action='store_true', help='Inspect volumes and setting names; do not call the API.')
    parser.add_argument('--deploy', action='store_true', help='Stop the old stack and perform the first deployment.')
    parser.add_argument('--print-compose', action='store_true')
    args = parser.parse_args()
    if args.print_compose:
        print(json.dumps(compose_spec(), indent=2))
        return
    if hasattr(os, 'geteuid') and os.geteuid() != 0:
        raise SetupError('Execute como root (sudo python3 ...).')
    directory = Path(args.install_dir).resolve()
    if ',' in str(directory):
        raise SetupError('O caminho da instalação não pode conter vírgulas.')
    state_path = directory / '.coolify-migration' / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if state and (state['repository'] != args.repository or state['branch'] != args.branch or state['api_url'] != args.api_url):
        raise SetupError('Os argumentos diferem do cadastro salvo. Confira .coolify-migration/state.json.')
    if state.get('migrated'):
        print('A instalação já foi migrada. Use o Coolify para os próximos deploys.')
        return
    state.update(discover(directory))
    state.update(repository=args.repository, branch=args.branch, api_url=args.api_url)
    print('Volumes existentes: ' + ', '.join(state['volumes'].values()), flush=True)
    if args.dry_run:
        print('Prévia concluída. Nenhum container ou cadastro foi alterado.')
        return
    token = getpass.getpass('Token da API do Coolify (não será salvo nem exibido): ').strip()
    if not token:
        raise SetupError('Token não informado.')
    api = API(args.api_url, token)
    register(api, state, state_path, args.server_uuid)
    print('Cadastro pronto: Projects > Faz o L > production > Faz o L', flush=True)
    print('Application UUID: ' + state['application_uuid'], flush=True)
    if args.deploy:
        cutover(api, state, directory, state_path)
    else:
        print('O site atual continua rodando. Publique o Compose no GitHub antes de executar --deploy.')
    print('Deploy automático: configure o workflow Tailscale conforme docs/coolify.md. Não é necessário abrir o firewall.')


if __name__ == '__main__':
    try:
        main()
    except (SetupError, OSError, ValueError, KeyError) as error:
        print('Erro: ' + str(error), file=sys.stderr)
        sys.exit(1)
