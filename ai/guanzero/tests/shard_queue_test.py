import json
from pathlib import Path
import tempfile
import unittest
import sys
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'training'))
from learner import ShardQueue, cleanup

class ShardQueueTest(unittest.TestCase):
    def test_resume_after_checkpoint_before_payload_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def publish(name, stamp, rows):
                path = root / (name + '.json')
                np.zeros((rows, 1647), dtype=np.int8).tofile(path.with_suffix('.x.i8'))
                np.arange(rows * 2, dtype='<f4').tofile(path.with_suffix('.y.f32'))
                path.write_text(json.dumps(dict(createdAt=stamp, schema=1, features=1647,
                                                targets=['adp', 'wp'], rows=rows)))
                return path
            old = publish('old', '01', 4)
            partial = publish('partial', '02', 3)
            committed = {'old.json': 4, 'partial.json': 1}
            old.with_suffix('.x.i8').unlink()
            queue = ShardQueue(root)
            self.assertIsNone(queue.batch(committed, 4))
            publish('fresh', '03', 3)
            queue.refresh()
            _, y, cursor, exhausted = queue.batch(committed, 4)
            self.assertEqual(y[:, 0].tolist(), [2, 4, 0, 2])
            self.assertEqual(exhausted, [old, partial])
            self.assertEqual(cursor['fresh.json'], 2)
            cleanup(exhausted)
            queue.committed(exhausted)
            self.assertEqual(len(queue.pending), 1)
