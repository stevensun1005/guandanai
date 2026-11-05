import json, pathlib, subprocess, sys, unittest
ROOT = next(p for p in pathlib.Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT/'ai/guanzero/training'))
from history_reference import history
class HistoryTest(unittest.TestCase):
    def test_python_node_parity(self):
        code = "import {readFileSync} from 'node:fs'; import {history} from './ai/guanzero/training/history.mjs'; console.log(JSON.stringify(JSON.parse(readFileSync('ai/shared/fixtures/positions.json')).map(s=>Array.from(history(s)))));"
        actual = json.loads(subprocess.check_output(['node','--input-type=module','-e',code],cwd=ROOT))
        positions = json.loads((ROOT/'ai/shared/fixtures/positions.json').read_text())
        self.assertEqual(actual, [history(s) for s in positions])
if __name__ == '__main__': unittest.main()
