"""Seed audit rejects reused reserved roots and malformed evidence before copying runs."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
spec = importlib.util.spec_from_file_location('windows_ab', ROOT/'ai/research/tools/prepare-windows-ab.py')
AB = importlib.util.module_from_spec(spec)
spec.loader.exec_module(AB)


class WindowsABTests(unittest.TestCase):
    def test_generic_paired_summary_uses_registered_arm_names_and_contrasts(self):
        import hashlib
        summary_spec = importlib.util.spec_from_file_location('ab_summary', ROOT/'ai/danMCai/evaluation/summarize-round-pairs.py')
        summary = importlib.util.module_from_spec(summary_spec)
        summary_spec.loader.exec_module(summary)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = [{'id': 'head-to-head', 'model': 'A', 'opponent': 'B', 'mixed': False, 'seeds': [100,101]},
                     {'id': 'A-clint', 'model': 'A', 'opponent': 'clint', 'mixed': False, 'seeds': [102,103]},
                     {'id': 'B-clint', 'model': 'B', 'opponent': 'clint', 'mixed': False, 'seeds': [102,103]}]
            plan = {'tasks': tasks, 'workers': 1, 'primaryModel': 'A', 'primaryOpponent': 'B',
                    'contrasts': [{'id':'clint', 'left':'B-clint', 'right':'A-clint', 'z':2.575829303549, 'confidenceLevel':0.99, 'direction':'A minus B'}],
                    'id':'synthetic-test', 'purpose':'unit fixture, not actual games', 'models':{}, 'rules':{}, 'pipeline':'fixture', 'pairing':'fixture', 'analysis':{}, 'plannedPairs':6}
            AB.write(root/'protocol.json', plan)
            sha = hashlib.sha256((root/'protocol.json').read_bytes()).hexdigest()
            AB.write(root/'worker-0.json', {'phase':'complete', 'protocolSHA256':sha})
            rows=[]
            for task in tasks:
                for seed in task['seeds']:
                    games=[]
                    for team in [0,1]:
                        games.append({'team':team, 'seats':[task['model'] if p%2==team else task['opponent'] for p in range(4)],
                                      'order':[0,2,1,3], 'winner':0, 'points':3, 'signedPoints':3 if team==0 else -3,
                                      'level':2, 'leader':0, 'dealSHA256':str(seed), 'turns':1})
                    rows.append({'task':task['id'], 'seed':seed, 'protocolSHA256':sha, 'games':games})
            (root/'worker-0.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
            report=summary.summarize(root/'protocol.json', root)
            self.assertEqual(report['completedRounds'],12)
            self.assertEqual(report['primaryWinner'],'inconclusive')
            self.assertEqual(report['secondaryContrasts']['clint']['confidenceLevel'],0.99)

    def test_source_seal_refuses_started_or_concurrently_edited_preparations(self):
        for mode in ['clean', 'started', 'changed']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                run = root/'run'
                (run/'learner').mkdir(parents=True)
                (run/'actors').mkdir()
                (run/'learner/checkpoint.pt').write_bytes(b'matched-checkpoint')
                AB.write(run/'config.json', {'sourceSHA256': {'old': 'hash'}})
                AB.write(root/'protocol.json', {'arms': {'A': {'run': str(run),
                    'configSHA256': AB.digest(run/'config.json'),
                    'prepared': {'checkpointSHA256': AB.digest(run/'learner/checkpoint.pt')}}}})
                if mode == 'started':
                    (run/'schedule.json').write_text('{}')
                if mode == 'changed':
                    (run/'config.json').write_text('{}')
                with patch.object(AB.subprocess, 'check_output', return_value='{"tested-source":"new-hash"}'):
                    if mode == 'clean':
                        self.assertFalse(AB.finalize(root)['started'])
                        self.assertEqual(json.loads((run/'config.json').read_text())['sourceSHA256'], {'tested-source': 'new-hash'})
                    else:
                        with self.assertRaises(ValueError):
                            AB.finalize(root)

    def test_nested_roots_are_collected_without_counting_metrics_as_seeds(self):
        self.assertEqual(list(AB.seeds_in({'rows': 123, 'nested': [{'seed': 42}], 'seeds': [7, 8]})), [42, 7, 8])

    def test_reused_training_or_gate_block_is_rejected(self):
        for seed in [1_008_000_001, 3_570_000_001, 3_680_000_001]:
            with self.subTest(seed=seed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                folder = root/'ai/danMCai/runs/prior/actors'
                folder.mkdir(parents=True)
                (folder/'results-0.jsonl').write_text(json.dumps({'seed': seed})+'\n')
                with patch.object(AB, 'ROOT', root), patch.object(AB, 'verify', return_value={'sourceRun': 'mac'}):
                    with self.assertRaisesRegex(ValueError, 'already used'):
                        AB.audit(root, root/'snapshot')

    def test_corrupt_log_is_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root/'ai/danMCai/runs/prior/actors'
            folder.mkdir(parents=True)
            (folder/'results-0.jsonl').write_text('{corrupt\n')
            with patch.object(AB, 'ROOT', root), patch.object(AB, 'verify', return_value={'sourceRun': 'mac'}):
                with self.assertRaises(json.JSONDecodeError):
                    AB.audit(root, root/'snapshot')


if __name__ == '__main__':
    unittest.main()
