import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name('setup-coolify.py')
spec = importlib.util.spec_from_file_location('setup_coolify', SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        # Recovery messages below are simulated; do not print them as real failures.
        self.console = patch.object(setup, 'print', create=True)
        self.console.start()
        self.addCleanup(self.console.stop)

    def test_template_uses_existing_external_volumes_and_private_rtc_path(self):
        compose = setup.compose_spec()
        for name in ('appdata', 'clips', 'recorder_buffer'):
            self.assertTrue(compose['volumes'][name]['external'])
            # Coolify 4.7.9 isComposeVolumeNameWithVariables accepts variables and
            # safe defaults, but rejects Compose's required-value (:?) operator.
            self.assertRegex(compose['volumes'][name]['name'],
                             r'^\$\{FAZOL_[A-Z_]+_VOLUME\}$')
            key='FAZOL_'+name.upper()+'_VOLUME'
            self.assertIn(':?',compose['services']['app']['environment'][key])
        self.assertIn('PathPrefix(`/rtc`)', str(compose['services']['livekit']['labels']))
        self.assertNotIn('env_file', compose['services']['app'])
        self.assertEqual(compose['services']['app']['build'], './app')

    def test_repository_key_accepts_coolify_short_form(self):
        expected = setup.repository_key(setup.REPOSITORY)
        for value in ('rodrigosocosta/faz-o-l', 'https://github.com/rodrigosocosta/faz-o-l.git',
                      'git@github.com:rodrigosocosta/faz-o-l.git', 'https://github.com/RodrigoSoCosta/faz-o-l/'):
            self.assertEqual(setup.repository_key(value), expected, value)
        self.assertNotEqual(setup.repository_key('someone/faz-o-l'), expected)

    def test_register_reuses_application_saved_in_short_form(self):
        calls = []
        def api(method, path, data=None):
            calls.append((method, path))
            if method == 'PATCH' and path == '/applications/application':
                self.assertEqual(data['git_repository'], 'rodrigosocosta/faz-o-l')
            if method == 'GET' and path == '/applications/application':
                return {'uuid': 'application', 'git_repository': 'rodrigosocosta/faz-o-l'}
            return {}
        with tempfile.TemporaryDirectory() as directory:
            state = {'repository': setup.REPOSITORY, 'branch': 'main', 'server_uuid': 's',
                     'project_uuid': 'p', 'application_uuid': 'application'}
            setup.register(api, state, Path(directory) / 'state.json')
        self.assertIn(('PATCH', '/applications/application'), calls)

    def test_repository_template_matches_script_payload(self):
        template = SCRIPT.parent.parent / 'docker-compose.coolify.yml'
        self.assertEqual(json.loads(template.read_text()), setup.compose_spec())

    def test_extract_keeps_credentials_but_drops_obsolete_settings(self):
        env = setup.application_env({'PUBLIC_URL': 'https://live.example.test', 'SESSION_SECRET': 'private',
                                     'COMPOSE_FILE': 'old', 'OTEL_ENABLED': 'true', 'SIGNOZ_PORT': '8080'})
        self.assertEqual(env['DOMAIN'], 'live.example.test')
        self.assertEqual(env['SESSION_SECRET'], 'private')
        self.assertNotIn('OTEL_ENABLED', env)
        self.assertNotIn('COMPOSE_FILE', env)

    def test_mount_discovery_rejects_bind_mounts_or_missing_data(self):
        mounts = [{'Type': 'volume', 'Name': 'original_appdata', 'Destination': '/data/app'},
                  {'Type': 'volume', 'Name': 'original_clips', 'Destination': '/data/clips'}]
        self.assertEqual(setup.volume_at(mounts, '/data/app'), 'original_appdata')
        with self.assertRaises(setup.SetupError): setup.volume_at(mounts, '/data/missing')
        mounts[0]['Type'] = 'bind'
        with self.assertRaises(setup.SetupError): setup.volume_at(mounts, '/data/app')

    def test_registration_never_deploys_and_resumes_without_duplicate_apps(self):
        calls = []
        def api(method, path, data=None):
            calls.append((method, path, data))
            if path == '/servers': return [{'uuid': 'server', 'name': 'localhost'}]
            if path == '/projects' and method == 'GET': return []
            if path == '/projects': return {'uuid': 'project'}
            if path == '/applications/public': return {'uuid': 'application'}
            if path == '/applications/application' and method == 'GET': return {'uuid': 'application', 'git_repository': setup.REPOSITORY}
            return {}
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / 'state.json'
            state = {'repository': setup.REPOSITORY, 'branch': 'main', 'env': {'SESSION_SECRET': 'private'}}
            setup.register(api, state, state_path)
            self.assertEqual(state['application_uuid'], 'application')
            saved = json.loads(state_path.read_text())
            self.assertNotIn('env', saved)
            self.assertNotIn('private', state_path.read_text())
            setup.register(api, state, state_path)
        creates = [c for c in calls if c[1] == '/applications/public']
        self.assertEqual(len(creates), 1)
        self.assertFalse(creates[0][2]['instant_deploy'])
        self.assertFalse(creates[0][2]['is_auto_deploy_enabled'])
        self.assertTrue(creates[0][2]['is_raw_compose_deployment_enabled'])
        self.assertFalse(any('/deploy' in c[1] for c in calls))

    def test_unpublished_template_blocks_cutover_before_stopping_containers(self):
        state = {'branch': 'main', 'repository': setup.REPOSITORY}
        run = Mock(side_effect=['', 'not json'])
        with self.assertRaises(setup.SetupError): setup.published_commit(Path('/opt/faz-o-l'), state, run)
        self.assertTrue(all(call.args[0][0] == 'git' for call in run.call_args_list))

    def test_first_deployment_backs_up_database_and_preserves_original_volumes(self):
        events = []
        state = {'application_uuid': 'app', 'containers': ['old-app', 'old-recorder', 'old-livekit'],
                 'volumes': {'appdata': 'original_db'}, 'backup_image': 'original-image'}
        def api(method, path, data=None):
            events.append((method, path, data))
            if path == '/applications/app/start': return {'deployment_uuid': 'job'}
            if path == '/deployments/job': return {'status': 'finished'}
            if path == '/applications/app' and method == 'GET': return {'status': 'running:healthy'}
            return {}
        def command(args): events.append(args); return ''
        with tempfile.TemporaryDirectory() as directory, patch.object(setup, 'published_commit', return_value='a'*40):
            root = Path(directory)
            setup.cutover(api,state,root,root/'state.json',command=command)
        self.assertTrue(state['migrated'])
        backup = next(e for e in events if isinstance(e,list) and e[:2] == ['docker','run'])
        self.assertIn('type=volume,source=original_db,target=/source,readonly',backup)
        self.assertLess(events.index(backup), next(i for i,e in enumerate(events) if isinstance(e,tuple) and e[1].endswith('/start')))
        self.assertFalse(any(isinstance(e,list) and e[:2] in (['docker','rm'],['docker','volume']) for e in events))

    def test_failed_deployment_stops_new_app_before_restarting_original_containers(self):
        events = []
        state = {'application_uuid':'app','containers':['old-app','old-recorder','old-livekit'],
                 'volumes':{'appdata':'original_db'},'backup_image':'original-image'}
        def api(method,path,data=None):
            events.append((method,path))
            if path.endswith('/start'): return {'deployment_uuid':'job'}
            if path == '/deployments/job': return {'status':'failed'}
            return {}
        def command(args): events.append(args); return ''
        with tempfile.TemporaryDirectory() as directory, patch.object(setup,'published_commit',return_value='a'*40):
            root=Path(directory)
            with self.assertRaises(setup.SetupError): setup.cutover(api,state,root,root/'state.json',command=command)
        stop_index=events.index(('POST','/applications/app/stop'))
        start_index=events.index(['docker','start',*state['containers']])
        self.assertLess(stop_index,start_index)
        self.assertNotIn('migrated',state)

    def test_uncertain_stop_of_new_app_does_not_start_two_writers_on_sqlite(self):
        state = {'application_uuid':'app','containers':['old-app'],
                 'volumes':{'appdata':'original_db'},'backup_image':'original-image'}
        command=Mock(return_value='')
        def api(method,path,data=None):
            if path.endswith('/start'): return {'deployment_uuid':'job'}
            if path == '/deployments/job': return {'status':'failed'}
            if path.endswith('/stop'): raise setup.SetupError('API indisponível')
            return {}
        with tempfile.TemporaryDirectory() as directory, patch.object(setup,'published_commit',return_value='a'*40):
            root=Path(directory)
            with self.assertRaises(setup.SetupError): setup.cutover(api,state,root,root/'state.json',command=command)
        self.assertFalse(any(c.args[0][:2]==['docker','start'] for c in command.call_args_list))

    def test_api_refuses_public_http_and_embedded_credentials(self):
        for url in ('http://example.com:8000','https://user:password@example.com'):
            with self.assertRaises(setup.SetupError): setup.API(url,'private')
        self.assertEqual(setup.API('http://100.64.0.1:8000','private').base,
                         'http://100.64.0.1:8000/api/v1')

    def test_validation_error_identifies_endpoint_and_field_without_echoing_secrets(self):
        api=setup.API('http://127.0.0.1:8000','private-token')
        body=json.dumps({'message':'private-token','errors':{
            'docker_compose_raw':['Invalid volume: password=private-value']}}).encode()
        error=urllib.error.HTTPError(api.base+'/applications/public',422,'Unprocessable',{},io.BytesIO(body))
        api.opener=Mock()
        api.opener.open.side_effect=error
        with self.assertRaises(setup.SetupError) as caught:
            api('POST','/applications/public',{'docker_compose_raw':'private-value'})
        message=str(caught.exception)
        self.assertIn('POST /applications/public',message)
        self.assertIn('docker_compose_raw',message)
        self.assertNotIn('private-token',message)
        self.assertNotIn('private-value',message)
        self.assertNotIn('token e permissões',message)

    def test_recovery_waits_for_cancellation_and_no_writers_on_database(self):
        state={'application_uuid':'app','volumes':{'appdata':'original_db'}}
        events=[]
        statuses=iter(['in_progress','in_progress','cancelled'])
        writers=iter(['new-app',''])
        def api(method,path,data=None):
            events.append((method,path))
            return {'status':next(statuses)} if method=='GET' else {}
        def command(args):
            events.append(args)
            return next(writers)
        setup.stop_new_application(api,state,'job',command,lambda _:None)
        self.assertLess(events.index(('POST','/deployments/job/cancel')),events.index(('POST','/applications/app/stop')))
        self.assertEqual(sum(isinstance(e,list) for e in events),2)

    def test_recovery_refuses_to_start_old_stack_while_database_has_a_writer(self):
        state={'application_uuid':'app','volumes':{'appdata':'original_db'}}
        with self.assertRaises(setup.SetupError):
            setup.stop_new_application(lambda *args:{},state,None,lambda args:'still-running',lambda _:None)


if __name__ == '__main__': unittest.main()
