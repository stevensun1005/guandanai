"""Sparse actor-root stop audits must reject out-of-reservation games and file changes."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('continuous_stop',Path(__file__).resolve().parents[1]/'tools/audit-continuous-stop.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SparseAuditTest(unittest.TestCase):
    def test_sparse_prefix_and_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);seeds=root/'seeds.json'
            seeds.write_text(json.dumps({'seeds':[201,209,301,319]}))
            reservation={'file':str(seeds),'sha256':hashlib.sha256(seeds.read_bytes()).hexdigest(),'perSlot':2}
            actor={'slot':1,'pid':123,'nextSeed':1,'matches':1,'rows':7,'decisions':7,'failures':0,'shardSequence':1}
            (root/'actor-1.json').write_text(json.dumps(actor))
            log=root/'results-1.jsonl';log.write_text(json.dumps({'seed':301,'decisions':7})+'\n')
            self.assertEqual(module.audit_actor_logs(root,0,reservation)[0]['uniqueLoggedSeeds'],1)
            log.write_text(json.dumps({'seed':319,'decisions':7})+'\n')
            with self.assertRaises(ValueError):module.audit_actor_logs(root,0,reservation)
            seeds.write_text('{}')
            with self.assertRaises(ValueError):module.audit_actor_logs(root,0,reservation)

if __name__=='__main__':unittest.main()
