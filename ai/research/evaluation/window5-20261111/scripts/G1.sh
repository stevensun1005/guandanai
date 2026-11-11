#!/bin/zsh
# Window-5 G1 (PLAN section 4, review R2): DESCRIPTIVE true-deal regression of belief v2a at 41-60
# (window 4's G1.sh adapted; window 4 never ran it). Run by queue.sh at V2a END (2 workers):
#   G1.sh --smoke                                  one stored position, 64 worlds (v2a lane = the
#                                                  registered v2a if present, else belief v1 as a
#                                                  stand-in), tiny metrics, structure count, report
#   G1.sh --run --deadline=<ISO> --workers=<n>     the stage
# Inputs (RT/inputs/g1, SHA in inputs/g1.sha256 and inputs/g1-structure.sha256): the 160 stored
# 41-60 positions (window-3 S4c positions-4160.json), the window-3 rollout runner
# w3-s4c-calib-run.mjs and window 4's structure counter w4-g1-structure.mjs, copied into the frozen
# src-e's ignored workspace (ai/danMCai/workspace/w5-g1-*.mjs, byte copies, SHA checked before use).
# Steps: (1) metrics.mjs log loss v1 and v2a on seeds 3990000000..3990000299 (third use, R8), band
# 41-108, every 2nd turn, 2 samples, 8 worlds; (2) rollouts, 64 worlds per position, lane v2a then
# lane v1 (control, same world seeds = CRN); (3) sampled four-of-a-kind ranks (vs 1.79 true) and
# longest-sequence class match if >= 30 s are left; (4) scripts/g1_gate.py -> G1/gate-v2a.json:
# regression numbers and the old S4c thresholds REPORTED ONLY (no decision; G1 never gates D5/ACC5).
# v2a = V2a/model/belief.onnx whose SHA equals the addendum REGISTER v2a line (C2); C10 qualifier
# (steps < 40,000) copied into the report line.
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
SRCD=$SRC
G=$R/G1
RUNNER=$SRCD/ai/danMCai/workspace/w5-g1-calib-run.mjs
STRUCT=$SRCD/ai/danMCai/workspace/w5-g1-structure.mjs
STRUCT_SRC=$R/inputs/g1/w4-g1-structure.mjs
STRUCT_SHA=515fb787ecc8eb82166b38f0326a3719a146d929f5dd2350e4a70b32adf1339c
RUNNER_SRC=$R/inputs/g1/w3-s4c-calib-run.mjs
RUNNER_SHA=09df81b5dfd4a23c62a1a5c1b4fc0824eaf65cff18afd06ec83098f645f4855a
POS=$R/inputs/g1/positions-4160.json
POS_SHA=2c3a5ab8c3809a5c965ace85bf3016f18345c230b275f3142385e8a92e946e2f
V1=$BELIEF
V1SHA=$BELIEFSHA
GATE=$R/scripts/g1_gate.py
METRICS=ai/danMCai/belief/metrics.mjs
MOPT=(--seeds=3990000000..3990000299 --band=41-108 --every=2 --samples=2 --worlds=8)
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=3072}
NODE=(nice -n 10 node --no-warnings)
MODE= DL= W=2
for a in "$@"; do
  case $a in --smoke) MODE=smoke ;; --run) MODE=run ;; --deadline=*) DL=${a#*=} ;; --workers=*) W=${a#*=} ;; esac
done
cd $SRCD || { echo "frozen checkout $SRCD missing" >&2; exit 3; }
# runner in place and byte-identical to the archived window-3 copy
mkdir -p ${RUNNER:h}
[ -f $RUNNER ] || cp -p $RUNNER_SRC $RUNNER
[ -f $STRUCT ] || cp -p $STRUCT_SRC $STRUCT
[ "$(sha $RUNNER)" = $RUNNER_SHA ] || { echo "runner sha $(sha $RUNNER) != $RUNNER_SHA" >&2; exit 3; }
[ "$(sha $POS)" = $POS_SHA ] || { echo "positions sha mismatch" >&2; exit 3; }
[ "$(sha $V1)" = $V1SHA ] || { echo "belief v1 sha mismatch" >&2; exit 3; }
[ "$(sha $STRUCT)" = $STRUCT_SHA ] || { echo "structure script sha $(sha $STRUCT) != $STRUCT_SHA" >&2; exit 3; }

if [ "$MODE" = smoke ]; then
  # own folder per smoke process: launchd restarts a submitted job once it exits (preflight removes it
  # within a second), and that restart must not wipe this run's outputs
  rm -rf $G/smoke-work/unit-*(N/mm+30); U=$G/smoke-work/unit-$$; mkdir -p $U/v2a
  LANE=$V2A; [ -f $V2A ] && [ -f ${V2A:h}/train-report.json ] && [ "$(sha $V2A)" = "$(registered_sha v2a)" ] || LANE=$V1
  echo "smoke v2a lane belief: $LANE ($(sha $LANE))"
  ID=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));p.sort((a,b)=>(a.id%40)-(b.id%40)||a.id-b.id);console.log(p[0].id)' $POS)
  W3_BELIEF=$LANE $NODE $RUNNER $POS $U/v2a/part-0.jsonl belief 0 1 64 $ID || exit 1
  [ "$(wc -l < $U/v2a/part-0.jsonl | tr -d ' ')" = 1 ] || { echo "no rollout row" >&2; exit 1; }
  $NODE $METRICS --belief=$LANE --seeds=3990000000..3990000001 --band=41-108 --every=2 --samples=2 --worlds=8 --out=$U/metrics-v2a.json || exit 1
  W3_BELIEF=$LANE $NODE $STRUCT $POS $U/structure-v2a.json 64 "" "" 1 || exit 1
  $PY -u $GATE $U $U/gate-v2a.json 160 || exit 1
  exit 0
fi
[ "$MODE" = run ] && [ -n "$DL" ] || { echo "usage: G1.sh --smoke | --run --deadline=<ISO> --workers=<n>" >&2; exit 2; }
END=$(zulu $DL)
halt() { stopped G1 || [ $(now) -ge $1 ]; }
mkdir -p $G
# ---- v2a export present and verified (V2a/train-report.json next to it: metrics.mjs needs it) ----
V2SHA=$(sha $V2A)
REPSHA=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).onnxSHA256)}catch{}' ${V2A:h}/train-report.json)
PSHA=$(registered_sha v2a)
if [ -z "$V2SHA" ] || [ "$V2SHA" != "$REPSHA" ] || [ "$V2SHA" != "$PSHA" ]; then
  log "NOTE G1: no registered v2a export (file ${V2SHA:-missing}, report ${REPSHA:-missing}, addendum ${PSHA:-missing}): G1 not run"
  exit 1
fi
QUAL=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.steps<40000?`v1 recipe, truncated at ${r.steps} steps (C10)`:"40,000 steps")}catch{console.log("steps unknown")}' $R/V2a/train.json)
log "NOTE G1 inputs: v2a $V2A sha256 $V2SHA ($QUAL); v1 sha256 $V1SHA; positions $POS sha256 $POS_SHA (160 at 41-60); runner w5-g1-calib-run.mjs sha256 $RUNNER_SHA (= window-3 w3-s4c-calib-run.mjs); structure $STRUCT_SHA; report scripts/g1_gate.py sha256 $(sha $GATE); src-e $(src_commit $SRCD | cut -c1-12); deadline $(toronto $END) Toronto (descriptive)"
# ---- (1) metrics, 2 processes ----
log "NOTE G1-metrics log loss v1 and v2a, seeds 3990000000..3990000299 (third use, R8), band 41-108, every 2 (S4c settings)"
for m in v1 v2a; do
  f=$V1; [ $m = v2a ] && f=$V2A
  $NODE $METRICS --belief=$f $MOPT --out=$G/metrics-$m.json > $G/metrics-$m.log 2>&1 &
done
sleep 2
while pgrep -f "belief/metrics.mjs.*window5-20261111/G1/" >/dev/null; do
  if halt $((END - 900)); then
    log "NOTE G1: STOP or deadline-15 min during metrics: stopping them"; pkill -TERM -f "belief/metrics.mjs.*window5-20261111/G1/"; sleep 3
    pkill -KILL -f "belief/metrics.mjs.*window5-20261111/G1/"; break
  fi
  sleep 5
done
wait 2>/dev/null
log "NOTE G1-metrics done: $(node -e '
  const fs=require("fs"); const r=(m)=>{try{return JSON.parse(fs.readFileSync(process.argv[1]+"/metrics-"+m+".json","utf8"))}catch{return null}};
  const out=[]; for (const m of ["v1","v2a"]) { const d=r(m); if(!d){out.push(m+" missing");continue}; const b=d.byTableCards||{};
    out.push(m+" "+["41-60","61-80"].map(k=>b[k]?k+" "+b[k].beliefLogLossPerCopy.toFixed(4):k+" -").join(" ")) }
  console.log(out.join(" | "))' $G)"
# ---- (2) rollouts: worker w runs lane v2a part w, then lane v1 part w ----
TROLL=$((END - 360))
for lane in v2a v1; do
  mkdir -p $G/$lane
  bs=$V1SHA; [ $lane = v2a ] && bs=$V2SHA
  old=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).beliefSHA256||"")}catch{}' $G/$lane/run.json)
  # a re-run resumes finished positions (the runner skips ids already written) only for the same network
  if [ -n "$old" ] && [ "$old" != "$bs" ]; then log "NOTE G1: lane $lane rows were made with belief $old, not $bs: removed"; rm -f $G/$lane/part-*.jsonl; fi
  echo "{\"pairs\":160,\"unit\":\"positions (dashboard reads part-*.jsonl lines)\",\"lane\":\"$lane\",\"beliefSHA256\":\"$bs\",\"worlds\":64,\"deadline\":$((TROLL * 1000))}" > $G/$lane/run.json
done
log "NOTE G1-rollouts 160 positions at 41-60, 64 worlds, $W workers: lane v2a first, then v1 control (same world seeds); stop at $(toronto $TROLL) Toronto"
worker() {
  local w=$1
  W3_BELIEF=$V2A $NODE $RUNNER $POS $G/v2a/part-$w.jsonl belief $w $W 64 "" $G/v2a > $G/v2a/part-$w.log 2>&1 || return 1
  halt $TROLL && return 0
  W3_BELIEF=$V1 $NODE $RUNNER $POS $G/v1/part-$w.jsonl belief $w $W 64 "" $G/v1 > $G/v1/part-$w.log 2>&1
}
PIDS=()
for w in $(seq 0 $((W - 1))); do worker $w & PIDS+=($!); done
alive() { for p in $PIDS; do kill -0 $p 2>/dev/null && return 0; done; return 1; }
while alive; do
  if halt $TROLL; then
    log "NOTE G1: STOP or $(toronto $TROLL) Toronto reached: stopping rollouts; report on what completed (n stated)"
    pkill -TERM -f "w5-g1-calib-run.mjs.*window5-20261111/G1/"; sleep 3; pkill -KILL -f "w5-g1-calib-run.mjs.*window5-20261111/G1/"
    for p in $PIDS; do kill -TERM $p 2>/dev/null; done
    break
  fi
  sleep 10
done
wait 2>/dev/null
n2=$(cat $G/v2a/part-*.jsonl 2>/dev/null | grep -c .); n1=$(cat $G/v1/part-*.jsonl 2>/dev/null | grep -c .)
log "NOTE G1-rollouts done: lane v2a $n2/160, lane v1 control $n1/160 positions"
# ---- (3) descriptive structure counts, if time is left ----
TST=$((END - 150))
if ! stopped G1 && [ $(( TST - $(now) )) -ge 30 ]; then
  for lane in v2a v1; do
    f=$V1; [ $lane = v2a ] && f=$V2A
    W3_BELIEF=$f $NODE $STRUCT $POS $G/structure-$lane.json 64 $(iso $TST) $R/STOP,$G/STOP 0 $G/$lane > $G/structure-$lane.log 2>&1 &
  done
  wait
fi
# ---- (4) report (descriptive) ----
$PY -u $GATE $G $G/gate-v2a.json 160 > $G/gate.out 2>&1
grc=$?
log "NOTE G1 gate-v2a.json sha256 $(sha $G/gate-v2a.json): $(tail -1 $G/gate.out | cut -c1-500) ($QUAL; descriptive only, decides nothing: not acceptance, not play)"
exit $grc
