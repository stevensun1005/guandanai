#!/bin/zsh
# Window-5 L1 "017h" (PLAN section 4; a run name only): the long-run network's start. Learner on MPS
# (trunk frozen, extras lr 1e-4), fed C2 blocks by corpus-feed.py, stopped by a watcher.
#   L1.sh --smoke                                  (a) two-slot feed: two one-round search-actor slots
#                                                  that BOTH name their block b000000 -> both arrive
#                                                  (C3); (b) wrap 017 to the mode's width; 100 learner
#                                                  steps on MPS; (c) one export with trunk bytes
#                                                  unchanged (l1_trunk_check.py); (d) STOP watcher
#   L1.sh --run --deadline=<ISO> [--workers=1]     the stage, from V2a END to 08:30 (--max-seconds)
# Mode (PLAN section 8 fallbacks): "public-belief-history" (1,295 = 215 + 1,080) when src-e has
# items 1-3 (search-actor --history, learner public-belief-history, corpus-feed.py) and the C2 slots
# write schema 2; otherwise L1-215 = extrasMode public-belief fed C1 and C2 blocks, same recipe,
# declared in stages.log and the addendum. Recipe (protocol stages.L1): init = 017 (462afc99) wrapped
# with zero extras (wrap_initial.py --width); Adam; trunk frozen; lr 1e-5 (trunk, frozen) / extras
# 1e-4; batch 2,048; replay ratio 8; capacity 1.6 M; minSamples 100 k; targetMatchWeight 0;
# anchorWeight 0; seed 20261113; exports hourly and at stop.
# Feed (C3): every finished C2 block with index mod 10 != 9 -> L1/run/shards/s{slot}-{shard}.*
# (hard links + rewritten json); mod 10 = 9 -> L1/heldout.json (L1-mse); L1/feed.jsonl.
# STOP (C4): a watcher touches L1/run/STOP on RT/STOP, RT/L1/STOP or at the deadline; the learner
# exports on stop (only if a step ran; 0 steps -> "no export" noted for L1-mse). Every export's
# SHA-256 goes to stages.log and the addendum (`REGISTER L1-<version> sha256= path=`) as it appears.
# Saved at the end: final export + learner checkpoint (model, optimizer, RNG) = the precondition
# for continuing in a later, separately authorized window (R1).
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
CT=ai/danMCai/training/continuous
SA=$CT/search-actor.mjs
L=$R/L1
MODE= DL= W=1
for a in "$@"; do
  case $a in --smoke) MODE=smoke ;; --run) MODE=run ;; --deadline=*) DL=${a#*=} ;; --workers=*) W=${a#*=} ;; esac
done
cd $SRC || { echo "frozen checkout $SRC missing" >&2; exit 3; }
[ "$(sha $M017)" = $M017SHA ] || { echo "017 sha mismatch" >&2; exit 3; }
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=3072}
PYRUN=(nice -n 10 $PY -u)
# ---- mode ----
EXTRAS=public-belief-history; WIDTH=1295; FEEDHIST=1
if ! { grep -q "HISTORY_FEATURES" $SA && grep -q '"public-belief-history"' $CT/learner.py && [ -f $CT/corpus-feed.py ] \
       && grep -q "1295" $CT/wrap_initial.py; }; then
  EXTRAS=public-belief; WIDTH=215; FEEDHIST=0
fi
[ -f $CT/corpus-feed.py ] || { echo "corpus-feed.py missing in src-e: no feeder" >&2; exit 3; }
config() { # <run dir> <capacity> <minSamples> <replayRatio> <exportSeconds> <batch>
  node -e '
    const [p, extras, cap, min, ratio, exp, batch] = process.argv.slice(1);
    const c = { schema: 1, purpose: "window-5 L1 017h (learner only; fed by corpus-feed.py)", extrasMode: extras,
      learner: { device: "mps", threads: 1, trunkFrozen: true, learningRate: 0.00001, extrasLearningRate: 0.0001,
        batch: Number(batch), replayRatio: Number(ratio), capacity: Number(cap), minSamples: Number(min),
        targetMatchWeight: 0, anchorWeight: 0, gradClip: 1, exportSeconds: Number(exp), seed: 20261113 } };
    require("fs").writeFileSync(p + "/config.json", JSON.stringify(c, null, 2) + "\n");' $1 $EXTRAS $2 $3 $4 $5 $6
}
init_run() { # <run dir>: wrapped 017 as models/v000000000.onnx + latest.json
  mkdir -p $1/models $1/shards
  if [ ! -f $1/models/latest.json ]; then
    $PYRUN $CT/wrap_initial.py --champion=$M017 --out=$1/models/v000000000.onnx --width=$WIDTH --expect-sha=$M017SHA > $1/wrap.json || return 1
    node -e 'const fs=require("fs"),c=require("crypto");const f=process.argv[1]+"/models/v000000000.onnx";
      fs.writeFileSync(process.argv[1]+"/models/latest.json",JSON.stringify({version:"v000000000",file:"v000000000.onnx",
        sha256:c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"),step:0,initial:"017 462afc99 wrapped with zero extras"},null,2))' $1
  fi
}
# watcher <run dir> <deadline epoch> <stop files...>: touches <run>/STOP on any stop file or the deadline
watcher() {
  local run=$1 dl=$2; shift 2
  while [ ! -f $run/STOP ]; do
    for f in "$@"; do [ -f $f ] && { echo "{\"by\":\"L1 watcher\",\"why\":\"$f\",\"at\":\"$(date -u +%FT%TZ)\"}" > $run/STOP; break 2; }; done
    [ $(now) -ge $dl ] && { echo "{\"by\":\"L1 watcher\",\"why\":\"deadline\",\"at\":\"$(date -u +%FT%TZ)\"}" > $run/STOP; break; }
    sleep 5
  done
}

if [ "$MODE" = smoke ]; then
  rm -rf $L/smoke-work/unit-*(N/mm+30); U=$L/smoke-work/unit-$$; mkdir -p $U
  HIST=(); [ $FEEDHIST = 1 ] && HIST=(--history=1)
  # (a) two slots, both b000000
  for s in 0 1; do
    nice -n 10 node --no-warnings $SA --out=$U/slots/slot-$s --start=$((4291000011 + s)) --rounds=1 --block-rounds=1 --workers=1 \
      --minutes=10 --belief=$BELIEF --rows=all --temperature=0.02 $HIST > $U/actor-$s.log 2>&1 || { echo "smoke actor slot $s failed"; exit 1; }
  done
  init_run $U/run || { echo "wrap failed"; exit 1; }
  $PYRUN $CT/corpus-feed.py --run=$U/run --slots-root=$U/slots --history=$FEEDHIST --heldout-mod=10 --heldout-rest=9 \
    --heldout=$U/heldout.json --feed-log=$U/feed.jsonl --once=1 > $U/feed.out 2>&1 || { echo "feeder failed: $(tail -c 300 $U/feed.out)"; exit 1; }
  node -e '
    const fs = require("fs"), d = process.argv[1]; const rows = (f) => JSON.parse(fs.readFileSync(f, "utf8")).rows;
    const want = [0, 1].map((s) => rows(`${d}/slots/slot-${s}/blocks/b000000/b000000-000000000.json`));
    const got = [0, 1].map((s) => { const f = `${d}/run/shards/s${s}-b000000-000000000.json`; return fs.existsSync(f) ? rows(f) : -1; });
    console.log(JSON.stringify({ want, got })); process.exit(want.every((w, i) => w === got[i] && w > 0) ? 0 : 1);' $U \
    || { echo "two-slot feed: not every row arrived"; exit 1; }
  # (b)+(c) 100 MPS steps with the real capacity and batch (replay ratio lifted for the tiny smoke corpus)
  config $U/run 1600000 1 100000000 1000000000 2048
  $PYRUN $CT/learner.py --run=$U/run --max-steps=100 > $U/learner.out 2>&1 || { echo "learner failed: $(tail -c 300 $U/learner.out)"; exit 1; }
  EXP=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/models/latest.json","utf8"));process.stdout.write(d.step===100?process.argv[1]+"/models/"+d.file:"")' $U/run)
  [ -n "$EXP" ] || { echo "no export at step 100"; exit 1; }
  $PY $R/scripts/l1_trunk_check.py $U/run/models/v000000000.onnx $EXP || { echo "trunk bytes changed or extras did not move"; exit 1; }
  # (d) STOP watcher
  watcher $U/run $(( $(now) + 600 )) $U/STOP-test & WP=$!
  sleep 1; touch $U/STOP-test; sleep 7
  [ -f $U/run/STOP ] || { kill $WP 2>/dev/null; echo "watcher did not write run/STOP"; exit 1; }
  echo "L1 smoke ok: mode $EXTRAS width $WIDTH; export $(basename $EXP) sha $(sha $EXP)"
  exit 0
fi
[ "$MODE" = run ] && [ -n "$DL" ] || { echo "usage: L1.sh --smoke | --run --deadline=<ISO>" >&2; exit 2; }
END=$(zulu $DL); [ $END -gt $T_L1_END ] && END=$T_L1_END
mkdir -p $L
RUN=$L/run
init_run $RUN || { log "NOTE L1: wrap of 017 to width $WIDTH failed"; exit 3; }
[ -f $RUN/config.json ] || config $RUN 1600000 100000 8 3600 2048
INIT_SHA=$(sha $RUN/models/v000000000.onnx)
if [ $EXTRAS = public-belief ]; then
  log "NOTE L1 FALLBACK L1-215 (PLAN section 8): src-e lacks item 1, 2 or 3 -> extrasMode public-belief (215), fed C1 and C2 blocks, same recipe; L1-mse without the history ablation"
  echo "$(date -u +%FT%TZ) NOTE L1 mode L1-215 fallback (extrasMode public-belief, C1 + C2 feed)" >> $ADDENDUM
  FEEDSRC=(--slots-root=$R/C2 --slot=90=$R4/C1/corpus)
else
  FEEDSRC=(--slots-root=$R/C2)
fi
log "NOTE L1 017h: extrasMode $EXTRAS (width $WIDTH), init 017 wrapped sha256 $INIT_SHA, config.json sha256 $(sha $RUN/config.json), learner.py $(sha $CT/learner.py), corpus-feed.py $(sha $CT/corpus-feed.py), src-e $(src_commit $SRC | cut -c1-12); until $(toronto $END) Toronto (--max-seconds); trunk frozen; development, no acceptance tonight"
# feeder (C3)
$PYRUN $CT/corpus-feed.py --run=$RUN $FEEDSRC --history=$FEEDHIST --heldout-mod=10 --heldout-rest=9 \
  --heldout=$L/heldout.json --feed-log=$L/feed.jsonl --interval=60 --deadline=$(iso $END) \
  --stop-file=$R/STOP,$L/STOP >> $R/logs/L1-feed.log 2>&1 &
FP=$!
watcher $RUN $END $R/STOP $L/STOP & WP=$!
$PYRUN $CT/learner.py --run=$RUN --max-seconds=$(( END - $(now) )) >> $R/logs/L1-learner.log 2>&1 &
LP=$!
seen=v000000000
while kill -0 $LP 2>/dev/null; do
  v=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.version+" "+d.file+" "+d.sha256+" "+d.step)}catch{}' $RUN/models/latest.json)
  if [ -n "$v" ] && [ "${v%% *}" != "$seen" ]; then
    set -- ${=v}; seen=$1
    [ "$(sha $RUN/models/$2)" = "$3" ] && { log "NOTE L1 export $1 step $4 sha256 $3 (hourly; descriptive until the final export)"; echo "$(date -u +%FT%TZ) REGISTER L1-$1 sha256=$3 path=$RUN/models/$2 step=$4" >> $ADDENDUM; }
  fi
  sleep 30
done
wait $LP; RC=$?
[ -f $RUN/STOP ] || echo "{\"by\":\"L1.sh\",\"why\":\"learner exited\",\"at\":\"$(date -u +%FT%TZ)\"}" > $RUN/STOP
kill $WP 2>/dev/null; sleep 2; kill -TERM $FP 2>/dev/null; wait $FP 2>/dev/null
V=($(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.version,d.file,d.sha256,d.step)}catch{}' $RUN/models/latest.json))
if [ "${V[1]}" != v000000000 ] && [ -n "${V[1]}" ] && [ "$(sha $RUN/models/${V[2]})" = "${V[3]}" ]; then
  grep -q "REGISTER L1-${V[1]} " $ADDENDUM 2>/dev/null || echo "$(date -u +%FT%TZ) REGISTER L1-${V[1]} sha256=${V[3]} path=$RUN/models/${V[2]} step=${V[4]}" >> $ADDENDUM
  echo "$(date -u +%FT%TZ) REGISTER L1-final sha256=${V[3]} path=$RUN/models/${V[2]} step=${V[4]}" >> $ADDENDUM
  FIN="final export ${V[1]} step ${V[4]} sha256 ${V[3]}; checkpoint $RUN/learner/checkpoint.pt sha256 $(sha $RUN/learner/checkpoint.pt)"
else
  FIN="no export (0 learner steps): L1-mse reports 017 and recalibrated-017 baselines only (C4)"
  echo "$(date -u +%FT%TZ) NOTE L1 zero steps: no export" >> $ADDENDUM
fi
FEED=$(node -e 'const fs=require("fs");let f=0,h=0,r=0;try{for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;const j=JSON.parse(l);if(j.use==="heldout")h++;else if(j.use==="train")f++;else if(j.use==="refused")r++;}}catch{}console.log(`feed.jsonl: ${f} blocks fed, ${h} held out, ${r} refused`)' $L/feed.jsonl)
log "NOTE L1 stopped rc=$RC: $FIN; $FEED; status $(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`buffer ${s.buffer} ingested ${s.ingestedRows} trained ${s.trainedRows} lossEMA ${s.lossEMA}`)}catch{console.log("-")}' $RUN/learner/status.json) (development; no acceptance tonight; not web, champion, default or menu)"
exit $RC
