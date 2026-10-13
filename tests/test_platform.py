import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import loop_platform
from loop_platform import file_lock, executable_prefix


class PlatformTests(unittest.TestCase):
    def test_lock_releases_after_exception(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve()/'lock'
            with self.assertRaises(RuntimeError):
                with file_lock(path):
                    raise RuntimeError('test')
            with file_lock(path,blocking=False):
                pass

    def test_real_cross_process_lock_contention(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve()/'lock'
            code = 'from loop_platform import file_lock\nimport sys\ntry:\n with file_lock(sys.argv[1],blocking=False): pass\nexcept BlockingIOError: sys.exit(7)'
            env = dict(os.environ,PYTHONPATH=str(Path(loop_platform.__file__).parent))
            with file_lock(path):
                result = subprocess.run([sys.executable,'-c',code,str(path)],env=env,capture_output=True)
                self.assertEqual(result.returncode,7,result.stderr)
            result = subprocess.run([sys.executable,'-c',code,str(path)],env=env,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_python_launcher(self):
        with tempfile.TemporaryDirectory(prefix='loop spaces ') as tmp:
            path = Path(tmp)/'fixture.py'
            path.write_text('print("ok")',encoding='utf-8')
            result = subprocess.check_output(executable_prefix(str(path)),text=True)
            self.assertEqual(result.strip(),'ok')

    def test_npm_shim_resolved_without_shell(self):
        with tempfile.TemporaryDirectory(prefix='loop spaces ') as tmp:
            root = Path(tmp)
            shim = root/'codex.cmd'
            entry = root/'node_modules/@openai/codex/bin/codex.js'
            entry.parent.mkdir(parents=True)
            entry.write_text('',encoding='utf-8')
            with patch.object(loop_platform,'WINDOWS',True), patch.object(loop_platform.shutil,'which',side_effect=lambda name: 'node.exe' if name=='node' else str(shim)):
                self.assertEqual(executable_prefix(str(shim)),['node.exe',str(entry.resolve())])

    def test_arbitrary_batch_rejected(self):
        with patch.object(loop_platform,'WINDOWS',True), patch.object(loop_platform.shutil,'which',return_value='untrusted.cmd'):
            with self.assertRaises(ValueError): executable_prefix('untrusted.cmd')


if __name__ == '__main__':
    unittest.main()
