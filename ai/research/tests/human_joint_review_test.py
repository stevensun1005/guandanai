"""Synthetic paired closeout fixture; no games, weights or human records used."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('joint_review',Path(__file__).parents[1]/'tools/review-human-joint.py')
review=importlib.util.module_from_spec(spec);spec.loader.exec_module(review)

class JointReviewTests(unittest.TestCase):
    def test_common_opponent_difference_preserves_covariance_and_rejects_changed_deals(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp)
            for name in ['vs029','vsreason','029vsreason']:
                d=root/name;d.mkdir();seeds=list(range(500))if name=='vs029'else list(range(500,1000))
                plan={'workers':1,'displayName':name,'tasks':[{'seeds':seeds}]};review.write(d/'protocol.json',plan)
                summary={'completedRounds':1000,'protocolSHA256':hashlib.sha256((d/'protocol.json').read_bytes()).hexdigest(),
                         'reports':{'head-to-head':{'wins':1000,'losses':0,'draws':0,'roundWinScore':{'mean':1,'ci':[1,1]},'signedUpgradePoints':{'mean':1,'ci':[1,1]},'doubleUps':0,'doubleDowns':0}}}
                review.write(d/'summary.json',summary);review.write(d/'status.json',{'phase':'complete'})
                rows=[]
                for seed in seeds:
                    points=[1,1]if name=='vs029'else ([3,1]if seed%2==0 else[1,1])if name=='vsreason'else([-1,1]if seed%2==0 else[-3,1])
                    rows.append({'seed':seed,'games':[{'dealSHA256':str(seed),'level':2,'leader':0,'signedPoints':points[t],'team':t,'winner':t if points[t]>0 else 1-t}for t in [0,1]]})
                (d/'worker-0.jsonl').write_bytes((''.join(json.dumps(r)+'\n'for r in rows)).encode())
            review.write(root/'human-results.json',{'reports':{'029':{'test':{'accuracy':.4,'nll':2}},'final':{'test':{'accuracy':.5,'nll':1}}}})
            review.closeout(root);r=review.read(root/'results.json')
            self.assertEqual(r['pairedUpgradeGainVsOldReason']['mean'],2)
            self.assertEqual(r['pairedUpgradeGainVsOldReason']['standardError'],0)
            self.assertTrue(r['bothExploratoryGoalsMet']);self.assertFalse(r['webPublished'])
            f=root/'029vsreason/worker-0.jsonl';rows=[json.loads(s)for s in f.read_text().splitlines()];rows[0]['games'][0]['dealSHA256']='changed'
            f.write_bytes((''.join(json.dumps(r)+'\n'for r in rows)).encode())
            with self.assertRaises(AssertionError):review.closeout(root)

if __name__=='__main__':unittest.main()
