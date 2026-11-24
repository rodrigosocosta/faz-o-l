import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ConfigTests(unittest.TestCase):
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
