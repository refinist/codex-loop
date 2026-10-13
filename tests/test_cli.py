import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT/'scripts/codex_loop.py'
FAKE = '''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
prompt = sys.stdin.read()
root = pathlib.Path.cwd()
with (root/'calls.jsonl').open('a') as f:
    f.write(json.dumps({'args':args,'prompt':prompt})+'\\n')
count = len((root/'calls.jsonl').read_text().splitlines())
print(json.dumps({'type':'thread.started','thread_id':'owned-worker'}), flush=True)
if (root/'slow').exists():
    (root/'worker.pid').write_text(str(os.getpid()))
    time.sleep(30)
if (root/'fail').exists():
    sys.exit(2)
output = pathlib.Path(args[args.index('--output-last-message')+1])
action = 'continue' if (root/'repeat').exists() and count == 1 else 'stop'
if not (root/'missing').exists():
    output.write_text(json.dumps({'action':action,'delay_seconds':60 if action=='continue' else None,'reason':'fixture result','noop':True,'summary':'checked'}))
print(json.dumps({'type':'turn.completed','usage':{}}),flush=True)
'''


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.state = self.root/'state.json'
        self.fake = self.root/'fake-codex'
        self.fake.write_text(FAKE)
        self.fake.chmod(0o755)
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        self.temp.cleanup()

    def cli(self,*args,check=True):
        out = subprocess.run([sys.executable,str(CLI),'--state',str(self.state),*args],capture_output=True,text=True)
        if check and out.returncode:
            self.fail(out.stderr)
        return out

    def create(self,request='check',driver='session'):
        return json.loads(self.cli('create','--project',str(self.root),'--driver',driver,request).stdout)

    def run_async(self,*args):
        process = subprocess.Popen([sys.executable,str(CLI),'--state',str(self.state),'run','--codex',str(self.fake),*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.processes.append(process)
        return process

    def wait_for(self,predicate):
        end = time.monotonic()+8
        while time.monotonic()<end:
            if predicate(): return
            time.sleep(.05)
        self.fail('Timed out waiting for fixture')

    def snapshot(self):
        return json.loads(self.state.read_text())

    def test_session_roundtrip(self):
        job = self.create()
        owned = json.loads(self.cli('claim').stdout)
        result = self.root/'decision.json'
        result.write_text(json.dumps({'action':'stop','delay_seconds':None,'reason':'done','noop':False}))
        self.cli('complete',job['id'],owned['task']['lease'],'--decision-file',str(result))
        self.assertIsNone(json.loads(self.cli('claim').stdout)['task'])

    def test_concurrent_claim_is_exclusive(self):
        self.create()
        commands = [[sys.executable,str(CLI),'--state',str(self.state),'claim'] for _ in range(6)]
        children = [subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for cmd in commands]
        outputs = [json.loads(p.communicate(timeout=5)[0]) for p in children]
        self.assertEqual(sum(item['task'] is not None for item in outputs),1)

    def test_close_restore_lifecycle(self):
        dynamic = self.create()
        fixed = self.create('5m check')
        self.cli('close')
        self.assertIsNone(json.loads(self.cli('claim').stdout)['next_at'])
        self.cli('restore')
        tasks = self.snapshot()['tasks']
        self.assertEqual(tasks[dynamic['id']]['status'],'stopped')
        self.assertEqual(tasks[fixed['id']]['status'],'waiting')

    def test_cli_complete_and_permission_flags(self):
        job = self.create(driver='cli')
        process = self.run_async()
        out, err = process.communicate(timeout=8)
        self.assertEqual(process.returncode,0,err)
        self.assertEqual(self.snapshot()['tasks'][job['id']]['status'],'stopped')
        call = json.loads((self.root/'calls.jsonl').read_text())
        self.assertIn('sandbox_mode="read-only"',call['args'])
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox',call['args'])
        self.assertIn('ONE iteration',call['prompt'])

    def test_dynamic_event_wake_resumes_owned_thread(self):
        (self.root/'repeat').touch()
        job = self.create(driver='cli')
        process = self.run_async()
        self.wait_for(lambda:self.snapshot()['tasks'][job['id']]['runs']==1)
        self.cli('wake',job['id'])
        out, err = process.communicate(timeout=8)
        self.assertEqual(process.returncode,0,err)
        calls = [json.loads(line) for line in (self.root/'calls.jsonl').read_text().splitlines()]
        self.assertEqual(len(calls),2)
        self.assertIn('resume',calls[1]['args'])
        self.assertIn('owned-worker',calls[1]['args'])
        self.assertNotIn('--last',calls[1]['args'])

    def test_cancellation_terminates_worker(self):
        (self.root/'slow').touch()
        job = self.create(driver='cli')
        process = self.run_async()
        self.wait_for(lambda:(self.root/'worker.pid').exists())
        pid = int((self.root/'worker.pid').read_text())
        self.cli('cancel',job['id'])
        process.communicate(timeout=8)
        self.assertEqual(self.snapshot()['tasks'][job['id']]['status'],'stopped')
        with self.assertRaises(ProcessLookupError): os.kill(pid,0)

    def test_timeout_blocks(self):
        (self.root/'slow').touch()
        job = self.create(driver='cli')
        process = self.run_async('--timeout','0.2')
        process.communicate(timeout=8)
        state = self.snapshot()['tasks'][job['id']]
        self.assertEqual(state['status'],'blocked')
        self.assertIn('timed out',state['reason'])

    def test_failure_does_not_retry(self):
        (self.root/'fail').touch()
        job = self.create(driver='cli')
        process = self.run_async()
        process.communicate(timeout=8)
        self.assertEqual(self.snapshot()['tasks'][job['id']]['status'],'blocked')
        self.assertEqual(len((self.root/'calls.jsonl').read_text().splitlines()),1)

    def test_single_driver(self):
        (self.root/'slow').touch()
        self.create(driver='cli')
        first = self.run_async()
        self.wait_for(lambda:(self.root/'worker.pid').exists())
        second = self.run_async()
        out, err = second.communicate(timeout=8)
        self.assertNotEqual(second.returncode,0)
        self.assertIn('already has a running driver',err)
        first.terminate()
        first.communicate(timeout=8)

    def test_close_stops_driver(self):
        (self.root/'slow').touch()
        job = self.create('5m check',driver='cli')
        process = self.run_async()
        self.wait_for(lambda:(self.root/'worker.pid').exists())
        self.cli('close')
        process.communicate(timeout=8)
        self.assertEqual(self.snapshot()['tasks'][job['id']]['status'],'blocked')
        self.assertTrue(self.snapshot()['closed'])

    def test_missing_decision_fallback(self):
        (self.root/'missing').touch()
        job = self.create(driver='cli')
        process = self.run_async()
        self.wait_for(lambda:self.snapshot()['tasks'][job['id']]['runs']==1)
        first = self.snapshot()['tasks'][job['id']]
        self.assertAlmostEqual(first['due_at']-first['finished_at'],1200)
        self.cli('wake',job['id'])
        process.communicate(timeout=8)
        self.assertEqual(self.snapshot()['tasks'][job['id']]['runs'],2)
        self.assertEqual(self.snapshot()['tasks'][job['id']]['status'],'stopped')

    def test_fixed_restore_and_dynamic_not_restored(self):
        # Register two jobs; restore is a session boundary, not a new execution.
        dynamic = self.create(driver='cli')
        fixed = self.create('5m check',driver='cli')
        process = self.run_async('--resume')
        self.wait_for(lambda:self.snapshot()['tasks'][dynamic['id']]['status']=='stopped')
        tasks = self.snapshot()['tasks']
        self.assertEqual(tasks[fixed['id']]['status'],'waiting')
        self.assertGreater(tasks[fixed['id']]['due_at'],time.time())
        self.cli('cancel','all')
        process.communicate(timeout=8)
        self.assertFalse((self.root/'calls.jsonl').exists())

    def test_mode_separation(self):
        self.create()
        result = self.cli('run','--codex',str(self.fake),check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'calls.jsonl').exists())

    def test_disable_registration(self):
        env = dict(os.environ,CODEX_LOOP_DISABLE='1')
        result = subprocess.run([sys.executable,str(CLI),'--state',str(self.state),'create','check'],env=env,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(self.state.exists())


if __name__ == '__main__':
    unittest.main()
