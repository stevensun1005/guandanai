#!/bin/zsh
# Window-5 V2a (PLAN section 4; window 4's V2a.sh with the window-4 E1/MPS wait removed and the
# window-5 deadlines, review F10): belief v2a = belief v1's recipe exactly (hidden 512, batch 1024,
# lr 3e-4, weight decay 0.01, dropout 0.3 / input dropout 0.1, suit augmentation, val-mod 10, eval
# every 1000) with max-steps 40,000, learner seed 20261112 and --minutes=55, on EXISTING data only:
# window-3 S4a data-v1b (41-108) first, then window-1 H/data and H/data-v2, whole blocks in seed
# order, capped at 4,000,000 rows in RAM. Development reading (val log loss by band vs v1).
# No structure head (train.py has none; stated).
# Run by queue.sh at 23:50 (after W5-0), alone with C2 slots 0-1 (MPS + 1 core):
#   V2a.sh --smoke                                  200 steps on CPU on 2 blocks per directory
#   V2a.sh --run --deadline=<ISO> --workers=<n>     the stage
# Memory rule (F2, registered): rows that fit = (free+inactive - 4 GiB - 2.5 GiB) / 1,416 B;
# >= 4 M -> 4 M; 2-4 M -> trained with the cap stated; < 2 M -> not trained (exit 5): D5, ACC5,
# G1-v2a and H1-v2a are SKIPPED and C2 gets +1 slot (queue.sh). "NOTE V2a-training started" in
# stages.log is the event that starts C2 slots 0-1 (C7).
# Registration (C2): after a verified export, and only when this script's own SHA-256 equals
# protocol.json scripts["V2a.sh"], it appends to RT/protocol-addendum.jsonl
#   <ISO> REGISTER v2a sha256=<onnx sha> path=<onnx> rows=<n> steps=<n> stopReason=<r> script=<sha>
# steps < 40,000 -> every later reading carries "v1 recipe, truncated at n steps" (C10).
# Honours RT/STOP and RT/V2a/STOP (checked every 50 steps; the final network is still evaluated and
# exported, stopReason says so). Trainer: src-e/ai/danMCai/belief/train.py through
# scripts/v2a_train.py (window 4's, byte copy); python = the trainer venv (never /usr/bin/python3).
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
SRCD=$SRC
TRAINPY=$SRCD/ai/danMCai/belief/train.py
WRAP=$R/scripts/v2a_train.py
D_H=/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/data
D_H2=/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/data-v2
D_S4=/Users/stevensun/guandan-runtime.noindex/window3-20261109/S4/data-v1b
DATA=$D_S4,$D_H,$D_H2
V1PT=/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.pt
V1SHA=16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9
CAP=4000000
ROWBYTES=1416   # 1238 x + 162 y + 16 meta (uint8/uint32) per row
RECIPE=(--hidden=512 --batch=1024 --lr=0.0003 --weight-decay=0.01 --dropout=0.3 --input-dropout=0.1
  --augment-suits=1 --val-mod=10 --eval-every=1000 --seed=20261112)
MODE= DL= W=1
for a in "$@"; do
  case $a in --smoke) MODE=smoke ;; --run) MODE=run ;; --deadline=*) DL=${a#*=} ;; --workers=*) W=${a#*=} ;; esac
done
STOPS=$R/STOP,$R/V2a/STOP
PYRUN=(nice -n 10 $PY -u)
[ -f $TRAINPY ] || { echo "train.py missing at $TRAINPY" >&2; exit 3; }

if [ "$MODE" = smoke ]; then
  # own folder per smoke process: launchd restarts a submitted job once it exits (preflight removes it
  # within a second), and that restart must not wipe this run's outputs
  rm -rf $R/V2a/smoke-work/unit-*(N/mm+30); U=$R/V2a/smoke-work/unit-$$; mkdir -p $U
  # 200 steps on CPU on the first 2 blocks of each directory (data readable, recipe flags, loop,
  # export, by-band v1 comparison), then the export loads in node as metrics/G1/H1 will load it.
  OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 $PYRUN $WRAP --train-py=$TRAINPY --data=$DATA --max-blocks-per-dir=2 --out=$U/model --device=cpu \
    --max-steps=200 --minutes=10 --stop-files=$STOPS --v1-pt=$V1PT --log=$U/train.log --summary=$U/train.json \
    $RECIPE --eval-every=100 || exit 1
  cd $SRCD && node --no-warnings --input-type=module -e '
    import * as ort from "onnxruntime-node";
    import { createBeliefModel } from "./ai/danMCai/belief/sampler.mjs";
    const m = await createBeliefModel(ort, process.argv[1], { threads: 1 });
    console.log("onnx loads in node:", m.featureVersion ?? "belief-v1"); await m.close?.();' $U/model/belief.onnx || exit 1
  exit 0
fi
[ "$MODE" = run ] && [ -n "$DL" ] || { echo "usage: V2a.sh --smoke | --run --deadline=<ISO> --workers=<n>" >&2; exit 2; }
END=$(zulu $DL)
mkdir -p $R/V2a
# ---- memory: the cap shrinks only if 4 GiB reserve + 2.5 GiB working set would not fit ----
# working set (verify fix): standardization's float64 chunk + its square (2 x 65536 x 1238 x 8 B =
# 1.3 GB) + torch/MPS runtime (~0.5 GB) + margin; the 10% validation copy comes after that peak
AV=$(free_inactive_mib)
FIT=$(( (AV - 4096 - 2560) * 1048576 / ROWBYTES ))
cap=$CAP
if [ $FIT -lt $CAP ]; then
  cap=$(( FIT > 0 ? FIT : 0 ))
  log "NOTE V2a: free+inactive $AV MiB: row cap reduced from $CAP to $cap (4 GiB reserve + 2.5 GiB working set kept)"
fi
[ $cap -lt 2000000 ] && { log "NOTE V2a: only $cap rows fit in memory (< 2,000,000): not trained (D5, ACC5, G1-v2a and H1-v2a will be SKIPPED; C2 gets +1 slot)"; exit 5; }
# training loop ends 6 min before the deadline (final eval, export, by-band v1 comparison, report)
TEND=$((END - 360))
rm -rf $R/V2a/model; rm -f $R/V2a/train.log $R/V2a/train.json
log "NOTE V2a-training started: belief v2a, v1 recipe (lr 3e-4, wd 0.01, dropout 0.3/0.1, val-mod 10, hidden 512, batch 1024, seed 20261112), max 40000 steps, MPS, data S4a data-v1b + H/data + H/data-v2 whole blocks capped at $cap rows, loop ends $(toronto $TEND) Toronto; train.py sha256 $(sha $TRAINPY) wrapper $(sha $WRAP); src-e $(src_commit $SRCD | cut -c1-12); no structure head (train.py has none)"
$PYRUN $WRAP --train-py=$TRAINPY --data=$DATA --cap-rows=$cap --out=$R/V2a/model --device=mps --require-device=mps \
  --max-steps=40000 --minutes=55 --deadline-epoch=$TEND --stop-files=$STOPS --v1-pt=$V1PT \
  --log=$R/V2a/train.log --summary=$R/V2a/train.json $RECIPE
rc=$?
ONNX=$R/V2a/model/belief.onnx
if [ $rc != 0 ] || [ ! -f $ONNX ]; then
  log "NOTE V2a-train rc=$rc no export (see logs/V2a.log)"; exit ${rc:-1}
fi
S=$(sha $ONNX)
REP=$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const f = (x) => x == null ? "-" : Number(x).toFixed(4);
  const b = r.byBand || {}; const band = (k) => b[k] && b[k].rows ? `${k} v2a ${f(b[k].v2aLogLossPerCopy)} v1 ${f(b[k].v1LogLossPerCopy)} uniform ${f(b[k].uniformLogLossPerCopy)} (v2a-v1 ${f(b[k].v2aMinusV1)}, ${b[k].rows} rows)` : `${k} -`;
  if (r.onnxSHA256 !== process.argv[2]) { console.log("SHA MISMATCH report " + r.onnxSHA256); process.exit(1); }
  console.log(`steps ${r.steps} (${r.stopReason}) in ${Math.round(r.trainSeconds)} s, rows ${r.rowsLoaded} (train ${r.trainRows}), val per copy v2a ${f(r.finalValidation.modelLogLossPerCopy)} vs uniform ${f(r.finalValidation.uniformLogLossPerCopy)} | ` + ["21-40","41-60","61-80","81-108"].map(band).join(" | "));' $R/V2a/train.json $S)
rc2=$?
# PLAN's output name V2a/model/belief-v2a.onnx = a hard link to train.py's belief.onnx (same bytes, same
# SHA; metrics.mjs finds train-report.json next to either)
[ $rc2 = 0 ] && ln -f $ONNX $R/V2a/model/belief-v2a.onnx
# addendum REGISTER (C2): only this script, at its registered SHA, writes it
MYSHA=$(sha $R/scripts/V2a.sh)
WANT=$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).scripts["V2a.sh"]||"")}catch{}' $R/protocol.json)
if [ $rc2 = 0 ] && [ -n "$WANT" ] && [ "$MYSHA" = "$WANT" ]; then
  REG=$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`rows=${r.rowsLoaded} steps=${r.steps} stopReason=${String(r.stopReason).replace(/\s+/g, "_")}`);' $R/V2a/train.json)
  echo "$(date -u +%FT%TZ) REGISTER v2a sha256=$S path=$ONNX $REG script=$MYSHA" >> $ADDENDUM
  REGTXT="addendum REGISTER v2a written"
else
  REGTXT="NOT registered (rc2=$rc2, V2a.sh sha $MYSHA vs protocol ${WANT:-none})"; rc2=${rc2/#0/6}
fi
log "NOTE V2a-train rc=$rc2 belief v2a $ONNX sha256 $S; $REP; $REGTXT; structure head not trained (train.py has none) (development, not acceptance)"
exit $rc2
