import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ConfigTests(unittest.TestCase):
    def test_traefik_publishes_only_the_ui_and_respects_ports(self):
        settings={**os.environ,'SIGNOZ_DOMAIN':'signoz.example.test','SIGNOZ_PORT':'8081','TRAEFIK_NETWORK':'test-proxy','TRAEFIK_ENTRYPOINT_HTTP':'web','TRAEFIK_ENTRYPOINT_HTTPS':'websecure','TRAEFIK_CERTRESOLVER':'test-cert'}
        data=json.loads(subprocess.check_output(['sh',str(ROOT/'observability/stack.sh'),'--traefik','config','--format','json'],env=settings))
        ui=data['services']['fazol-signoz-signoz-0']
        self.assertEqual(ui['ports'][0]['published'],'8081')
        self.assertEqual(ui['ports'][0]['host_ip'],'127.0.0.1')
        self.assertEqual(ui['ports'][0]['target'],8080)
        self.assertEqual(data['networks']['traefik']['name'],'test-proxy')
        labels=ui['labels']
        self.assertEqual(labels['traefik.http.routers.fazol-signoz.rule'],'Host(`signoz.example.test`)')
        self.assertEqual(labels['traefik.http.routers.fazol-signoz.entrypoints'],'websecure')
        self.assertEqual(labels['traefik.http.routers.fazol-signoz.tls'],'true')
        self.assertEqual(labels['traefik.http.routers.fazol-signoz.tls.certresolver'],'test-cert')
        self.assertEqual(labels['traefik.http.services.fazol-signoz.loadbalancer.server.port'],'8080')
        for name,service in data['services'].items():
            if name!='fazol-signoz-signoz-0': self.assertNotIn('traefik',service.get('networks',{}),name)

    def test_storage_is_isolated_from_ingestion(self):
        data=json.loads(subprocess.check_output(['docker','compose','-f',str(ROOT/'observability/pours/deployment/compose.yaml'),'config','--format','json']))
        collector=set(data['services']['ingester']['networks'])
        self.assertIn('ingestion',collector)
        self.assertEqual(data['networks']['ingestion']['name'],'fazol-observability')
        for name,service in data['services'].items():
            if name!='ingester': self.assertNotIn('ingestion',service.get('networks',{}),name)
        self.assertNotIn('ports',data['services']['ingester'])

    def test_stack_reads_environment_from_project_root(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);obs=root/'observability';(obs/'pours/deployment').mkdir(parents=True)
            shutil.copy(ROOT/'observability/stack.sh',obs/'stack.sh')
            (root/'.env').write_text('OTEL_ENVIRONMENT=staging\n')
            (obs/'pours/deployment/compose.yaml').write_text('services:\n  ingester:\n    image: test:1\n    environment:\n      OTEL_ENVIRONMENT: ${OTEL_ENVIRONMENT:-production}\n')
            output=subprocess.check_output(['sh',str(obs/'stack.sh'),'config'],text=True)
            self.assertIn('OTEL_ENVIRONMENT: staging',output)

if __name__=='__main__': unittest.main()
