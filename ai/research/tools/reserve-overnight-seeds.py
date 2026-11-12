"""Reserve sparse match roots; all200 possible derived deals avoid both historical meanings."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import numpy as np

parser = argparse.ArgumentParser(__doc__)
parser.add_argument('--workspace', type=Path, required=True)
parser.add_argument('--campaign', type=Path, required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('audit',Path(__file__).with_name('audit-research-seeds.py'))
audit = importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
baseline = audit.audit(args.workspace,1_280_000_000,1)
known = set()
for item in baseline['files']:
    path = Path(item['path']);raw = path.read_bytes()[:item['prefixBytes']]
    if path.name.endswith('.gz'):raw = gzip.decompress(raw)
    if path.name.endswith(('.jsonl','.gz')):known.update(map(int,re.findall(rb'"seed"\s*:\s*(\d+)',raw)))
    else:known.update(audit.seeds_in(json.loads(raw)))
mod = 2**32
literal = np.sort(np.array(list(known),dtype=np.int64))
derived = np.sort((literal*1009)%mod)
roots = np.arange(2_000_000_000,2_010_000_000,dtype=np.int64)
deals = (roots*1009)%mod
# Circular distances exclude [-199,+199] against old match-derived starting deals,
# and [0,+199] against literal deals. This is the pointwise equivalent of range_conflicts.
i = np.searchsorted(derived,deals)
valid = ((deals-derived[(i-1)%len(derived)])%mod >= 200) & ((derived[i%len(derived)]-deals)%mod >= 200)
j = np.searchsorted(literal,deals)
valid &= (literal[j%len(literal)]-deals)%mod >= 200
for lo,hi in baseline['futureRootRanges']:valid &= (roots<lo)|(roots>=hi)
roots,deals = roots[valid],deals[valid]
order = np.argsort(deals);roots,deals = roots[order],deals[order]
chosen=[];last=-200
for root,deal in zip(roots,deals):
    if int(deal)-last>=200:
        chosen.append(int(root));last=int(deal)
        if len(chosen)==240000:break
assert len(chosen)==240000 and len(set(chosen))==240000
new=np.sort((np.array(chosen,dtype=np.int64)*1009)%mod)
assert np.diff(new).min()>=200 and int(new[0])+mod-int(new[-1])>=200
# Validate historical no-overlap independently on the chosen vectors, with two lookups each.
for old,left,right in [(derived,199,199),(literal,0,199)]:
    ix=np.searchsorted(old,new)
    assert ((new-old[(ix-1)%len(old)])%mod>left).all()
    assert ((old[ix%len(old)]-new)%mod>right).all()
run=args.campaign/'experiments/seed-reservation';run.mkdir(parents=True,exist_ok=True)
file=run/'protocol.json'
assert not file.exists(),'Never overwrite a reservation'
file.write_text(json.dumps({'purpose':'Reserved NEW sparse match roots, not completed games','seeds':chosen,'perSlot':60000},separators=(',',':'))+'\n')
heldout=audit.audit(args.workspace,1_280_000_000,3000)
heldout['purpose']='Independent overnight acceptance; not training or development'
heldout['trainingRootList']={'file':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'perSlot':60000,'slots':4,'totalUnique':240000}
heldout['trainingAudit']='Sparse240000 roots; exact circular intervals of200 derived deals mutually disjoint and disjoint from historical match-root and literal-deal interpretations; unused reservations excluded literally only. These are reservations, not completed games.'
(args.campaign/'seed-audit.full.json').write_text(json.dumps(heldout,indent=2)+'\n')
print(json.dumps({'files':len(heldout['files']),'known':heldout['knownUniqueRootSeeds'],'heldout':len(heldout['seeds']),'training':heldout['trainingRootList']}))
