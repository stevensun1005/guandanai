import json, pathlib, subprocess, sys, unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'/'guanzero'))
from history_reference import history
class HistoryTest(unittest.TestCase):
    def test_python_node_parity(self):
        code = "import {readFileSync} from 'node:fs'; import {history} from './scripts/guanzero/history.mjs'; console.log(JSON.stringify(JSON.parse(readFileSync('tests/fixtures/positions.json')).map(s=>Array.from(history(s)))));"
        actual = json.loads(subprocess.check_output(['node','--input-type=module','-e',code],cwd=ROOT))
        positions = json.loads((ROOT/'tests/fixtures/positions.json').read_text())
        self.assertEqual(actual, [history(s) for s in positions])
if __name__ == '__main__': unittest.main()
