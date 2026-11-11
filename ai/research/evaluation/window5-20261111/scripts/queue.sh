#!/bin/zsh
# Window 5 queue (launchd com.guandanai.w5-queue), EVENT-DRIVEN (PLAN section 4 timeline, review F3).
# Toronto times (EST = UTC-5); stages.log lines are UTC ISO.
#   queue.sh                run the window (W5-0 at window 4's 23:45 end, then events until 09:00)
#   queue.sh --dry-run      print the event plan, every command and what is present; start nothing
#   queue.sh --smoke-all    T-smoke for the src-e stages (V2a, W5-0b, C2, L1, G1, H1): each smoke under
#                           its own launchd job, one after another (<= 1 core each; beside window 4,
#                           whose jobs are never touched); results in RT/<stage>/smoke.json
#   queue.sh --smoke-e2     T-smoke for the src-e2 stages present (D5, ACC5, L1mse, DEV1)
# Every launch: (1) its event, (2) heavy work not before 23:50 and only once window 4's compute is
# gone (F1), (3) a passing launchd smoke of the same src commit and stage-script SHA (reused if
# already run by --smoke-all, else run now), (4) the memory rule on LIVE numbers (F2: max(smoke peak,
# registered peak) x workers + 4 GiB < free + inactive; memory-only failures re-checked every 60 s
# for 10 min), (5) the real command under run_bounded (killed on RT/STOP, RT/<stage>/STOP, its own
# deadline or 09:00), START/END/SKIP lines. RT/QUEUE-STOP = start nothing new. No new compute after
# 08:40; T-close at 08:40; window-5 compute gone by 08:55. Decision rules are protocol.json's.
#
# Stage scripts (RT/scripts/<stage>.sh): --smoke | --run --deadline=<ISO> --workers=<n> [...].
# src-e2 stages (built after src-e; each SKIPPED cleanly, with the reason logged, when its script is
# absent at its event): D5.sh, ACC5.sh (reads RT/M5/decision.json for N and the arm split), m5.py
# (writes RT/M5/decision.json {acc5: "run"|"skip", N, workersA, workersB, reason, cA, cB}),
# L1mse.sh (--run --mode=hourly|final [--export=<onnx>]), DEV1.sh. They run from RT/src-e2.
# Output paths the 8771 dashboard reads: D5/A, D5/B, D5/compare.json; ACC5/A, ACC5/B,
# ACC5/compare.json; L1/mse.jsonl, L1/mse-final.json; DEV1/parity.json; M5/decision.json.
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
MODE=run
case $1 in --dry-run) MODE=dry ;; --smoke-all) MODE=smokeall ;; --smoke-e2) MODE=smokee2 ;; esac
PF=$R/scripts/preflight.sh
QSTOP=$R/QUEUE-STOP
SA=ai/danMCai/training/continuous/search-actor.mjs
MS=ai/danMCai/belief/midgame-search.mjs
T_W50=$(tor 23:45)
T_C2_LATEST=$(tor 00:00)        # C7: slots 0-1 at "V2a training" or "V2a exited", 00:00 at the latest
T_E2=$(tor 01:45); T_E2_WAIT=$(tor 01:50); T_E2_SMOKE_END=$(tor 02:15)
T_DEV1=$(tor 08:31); T_DEV1_END=$(tor 08:38)
T_MSE_FINAL_END=$NO_NEW_COMPUTE
C2_MAX=6

qstop() { [ -f $QSTOP ] || gstop; }
ended() { grep -qE " (END|SKIP) $1( |\$)" $R/stages.log 2>/dev/null; }
started() { grep -qE " START $1( |\$)" $R/stages.log 2>/dev/null; }
running() { started $1 && ! ended $1; }
wait_until() { while [ $(now) -lt $1 ]; do gstop && return 1; [ -n "$2" ] && [ -f $R/$2/STOP ] && return 1; sleep 15; done; return 0; }
jget() { node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=($2);process.stdout.write(v===undefined||v===null?'':String(v))}catch{}" "$1"; }
v2a_ok() { local s=$(registered_sha v2a); [ -n "$s" ] && [ "$(sha $V2A)" = "$s" ]; }
src_of() { case $1 in D5|ACC5|L1mse|DEV1) echo $SRC2 ;; *) echo $SRC ;; esac; }
script_of() { case $1 in W5-0b) echo $R/scripts/w5b.sh ;; *) echo $R/scripts/$1.sh ;; esac; }
# run_bounded <stage> <deadline> <pkill pattern> <cmd...>: on a STOP file the command first gets
# 150 s to stop by itself (every stage tool polls RT/STOP and RT/<stage>/STOP and saves: C2 keeps
# finished blocks, L1 exports, evaluations keep their prefix); at its deadline or 09:00 it is killed.
run_bounded() {
  local name=$1 dl=$2 pat=$3 since=0; shift 3
  "$@" &
  local pid=$!
  while kill -0 $pid 2>/dev/null; do
    if stopped $name && [ $since = 0 ]; then since=$(now); log "$name: STOP file seen: 150 s for the stage to stop and save by itself"; fi
    if { [ $since != 0 ] && [ $(( $(now) - since )) -ge 150 ]; } || [ $(now) -ge $dl ] || [ $(now) -ge $HARD_END ]; then
      log "$name: STOP or deadline $(toronto $dl) Toronto reached: terminating"
      kill -TERM $pid 2>/dev/null; pkill -TERM -f "$pat"; sleep 20; pkill -KILL -f "$pat"; kill -KILL $pid 2>/dev/null
      wait $pid; return 143
    fi
    sleep 10
  done
  wait $pid; return $?
}
# preflight options per stage (PLAN section 5)
pf_opts() {
  local v2=beliefV1; v2a_ok && v2=beliefV1,v2a
  case $1 in
    V2a) echo "--python=1 --onnx=beliefV1 --tools=ai/danMCai/belief/sampler.mjs --resolve=1 --timeout=1200" ;;
    W5-0b) echo "--python=1 --onnx=champion017 --files=$R4/C1/corpus/blocks --timeout=600" ;;
    C2) echo "--onnx=champion017,beliefV1 --tools=$SA --resolve=1 --heap=3072 --timeout=900" ;;
    L1) echo "--python=1 --onnx=champion017,beliefV1 --tools=$SA --resolve=1 --heap=3072 --timeout=1500" ;;
    G1) echo "--python=1 --onnx=$v2 --inputs=g1 --tools=ai/danMCai/belief/metrics.mjs --resolve=1 --timeout=1200" ;;
    H1) echo "--onnx=champion017,$v2 --inputs=human-research --tools=ai/danMCai/belief/panel-scorer.mjs --resolve=1 --timeout=1800" ;;
    D5|ACC5|DEV1) echo "--cwd=$SRC2 --src=e2 --onnx=champion017,$v2 --tools=$MS --resolve=1 --timeout=1500" ;;
    L1mse) echo "--cwd=$SRC2 --src=e2 --python=1 --onnx=champion017 --timeout=900" ;;
  esac
}
# smoke_valid <stage> [maxAgeSec]: smoke.json rc 0 for the current src commit and stage-script SHA,
# < 4 h old; L1mse and DEV1 accept their 01:45-02:15 src-e2 smoke for 10 h (same commit and script
# SHA), since a fresh smoke after 07:40 cannot pass the > 60 min deadline rule (C1) and DEV-1 (08:31)
# and the L1-mse final (08:30) would otherwise never run (src-e review).
smoke_valid() {
  local st=$1 meta=$R/$1/smoke-meta.json maxage=${2:-14400}
  [ -z "$2" ] && case $1 in L1mse|DEV1) maxage=36000 ;; esac
  [ -f $R/$st/smoke.json ] && [ -f $meta ] || return 1
  [ "$(jget $R/$st/smoke.json 'd.rc')" = 0 ] || return 1
  [ "$(jget $meta 'd.scriptSHA256')" = "$(sha $(script_of $st))" ] || return 1
  [ "$(jget $meta 'd.srcCommit')" = "$(src_commit $(src_of $st))" ] || return 1
  [ $(( $(now) - $(jget $meta 'd.at') )) -lt $maxage ] || return 1
  return 0
}
# do_smoke <stage> <workers>: preflight under launchd (unless a valid one exists); 1 on failure
do_smoke() {
  local st=$1 w=$2
  smoke_valid $st && { log "$st: launchd smoke of this src commit and script already passed ($(jget $R/$st/smoke.json 'd.endedAt')): reused"; return 0; }
  local sc=$(script_of $st)
  [ -f $sc ] || { log "SKIP $st (scripts/${sc:t} missing)"; return 1; }
  log "$st: preflight smoke under launchd (com.guandanai.w5-$st-smoke)"
  local opts=(${(z)$(pf_opts $st)})
  /bin/zsh $PF launch $st --workers=$w --deadline=$NO_NEW_COMPUTE $opts -- /bin/zsh $sc --smoke > $R/logs/$st-preflight.out 2>&1
  local rc=$?
  mkdir -p $R/$st
  echo "{\"stage\":\"$st\",\"rc\":$rc,\"scriptSHA256\":\"$(sha $sc)\",\"srcCommit\":\"$(src_commit $(src_of $st))\",\"at\":$(now)}" > $R/$st/smoke-meta.json
  [ $rc = 0 ] || { log "$st: smoke failed rc=$rc ($(jget $R/$st/smoke.json 'd.reason'))"; return 1; }
  return 0
}
# gate <stage> <workers> [peakMB]: memory rule on live numbers, memory-only failures re-checked 10 min
gate() {
  local st=$1 w=$2 pk=$3 g grc tries=0
  g=$(/bin/zsh $PF gate $st $w $pk); grc=$?
  while [ $grc != 0 ] && [[ $g == "memory rule fails"* ]] && [ $tries -lt 10 ]; do
    [ $tries = 0 ] && log "$st: memory rule not met yet ($g); re-checking every 60 s for up to 10 min"
    stopped $st && break; sleep 60; tries=$((tries + 1)); g=$(/bin/zsh $PF gate $st $w $pk); grc=$?
  done
  [ $grc = 0 ] || { echo "$g"; return 1; }
  log "$st: memory rule ok: $g"; return 0
}
# launch <stage> <workers> <deadline> [extra args...]: smoke + gate + START/END
launch() {
  local st=$1 w=$2 dl=$3; shift 3
  qstop && { log "SKIP $st (STOP/QUEUE-STOP)"; return 1; }
  [ $(now) -ge $NO_NEW_COMPUTE ] && { log "SKIP $st (no new compute after 08:40)"; return 1; }
  do_smoke $st $w || { ended $st || log "SKIP $st (smoke: $(jget $R/$st/smoke.json 'd.reason' | cut -c1-200))"; return 1; }
  local g; g=$(gate $st $w) || { log "SKIP $st (smoke: $g)"; return 1; }
  [ $dl -gt $HARD_END ] && dl=$HARD_END
  [ $(now) -ge $dl ] && { log "SKIP $st (no time left before $(toronto $dl))"; return 1; }
  log "START $st scripts/$(basename $(script_of $st)) (sha256 $(sha $(script_of $st))) $w worker(s) until $(toronto $dl) Toronto; src $(src_commit $(src_of $st) | cut -c1-12) $*"
  local pat="window5-20261111/$st/"
  [ $st = L1 ] && pat="(learner|corpus-feed)\.py --run=$R/L1/run|scripts/L1\.sh --run"
  run_bounded $st $dl "$pat" /bin/zsh $(script_of $st) --run --deadline=$(iso $dl) --workers=$w "$@" >> $R/logs/$st.log 2>&1
  local rc=$?
  log "END $st rc=$rc"
  return $rc
}

# ======================================================================= dry run
if [ $MODE = dry ]; then
  cat <<EOF
Window-5 queue, EVENT-DRIVEN (Toronto; DRY RUN: nothing started, nothing submitted)
  RT $R · src-e $SRC · src-e2 $SRC2 · STOP $R/STOP · QUEUE-STOP $QSTOP · addendum $ADDENDUM
  every launch: event -> heavy rule (>= 23:50, window-4 compute gone) -> launchd smoke (reused if same src commit + script SHA)
    -> memory rule (max(smoke, registered) x workers + 4 GiB < free+inactive, live) -> run_bounded -> START/END/SKIP
  W5-0    at $(toronto $T_W50): wait for window-4 compute to be gone (F1; dashboard 8770 and its queue.sh excluded);
          seed_audit.py (must be clean); make_protocol.py --stage=W5-0 --src=src-e (champion verification R4,
          window-4 finals); strip_human.mjs --check=1 (R7). Any failure -> QUEUE-STOP, nothing starts.
  V2a     at $(toronto $T_HEAVY) after W5-0: scripts/V2a.sh (MPS + 1), --minutes=55; exit 5 = < 2 M rows -> no v2a
  W5-0b   beside V2a: scripts/w5b.sh (1 core, CPU), until +30 min
  C2      slots 0-1 at V2a/train.log "phase": "ready" or V2a END, at $(toronto $T_C2_LATEST) at the latest;
          after V2a END the slot target is min($C2_MAX, 8 - heavy cores busy: G1 2, H1 1, D5 3, ACC5 4 (also reserved
          between D5 END and M5), L1-mse 1, W5-0b 1, DEV-1 1), every new slot subject to the memory rule;
          slot s: scripts/C2.sh --run --slot=s (deals 4290400000+10000s), all stop $(toronto $T_C2_END)
  L1      at V2a END (MPS free): scripts/L1.sh until $(toronto $T_L1_END) (--max-seconds)
  H1      at V2a END if v2a is registered (else SKIP): scripts/H1.sh, 1 core, +40 min
  G1      at V2a END if v2a is registered (else SKIP): scripts/G1.sh, 2 workers, +75 min
  D5      at H1 END if v2a registered; needs scripts/D5.sh (src-e2) -> waits until $(toronto $T_E2_WAIT); absent -> D5 and ACC5 SKIPPED;
          3 workers, until start + 2 h
  M5      at D5 END: scripts/m5.py -> M5/decision.json (absent -> ACC5 SKIPPED)
  ACC5    if M5 says run: scripts/ACC5.sh 4 workers until $(toronto $T_ACC5_END)
  L1-mse  scripts/L1mse.sh (src-e2): hourly on each new L1 export (descriptive), final after L1 END until $(toronto $T_MSE_FINAL_END)
  DEV-1   $(toronto $T_DEV1)-$(toronto $T_DEV1_END): scripts/DEV1.sh (src-e2) if present
  T-close $(toronto $NO_NEW_COMPUTE): scripts/close.sh (STOP, manifests, window-5 compute gone by $(toronto $PGREP_CLEAN)); hard end $(toronto $HARD_END)
EOF
  for st in V2a w5b C2 L1 G1 H1 D5 ACC5 L1mse DEV1 close; do
    f=$R/scripts/$st.sh; printf '  scripts/%s.sh: %s\n' $st "$([ -f $f ] && echo "present $(sha $f | cut -c1-12)" || echo 'absent (would SKIP)')"
  done
  printf '  scripts/m5.py: %s · src-e %s · src-e2 %s · protocol.json %s · seed audit %s · champion ok %s\n' \
    "$([ -f $R/scripts/m5.py ] && echo present || echo absent)" "$([ -d $SRC ] && src_commit $SRC | cut -c1-12 || echo 'not frozen yet')" \
    "$([ -d $SRC2 ] && src_commit $SRC2 | cut -c1-12 || echo 'not frozen yet')" "$(sha $R/protocol.json | cut -c1-12)" \
    "$(jget $R/seed-audit.json 'd.verdict')" "$(jget $R/protocol.json 'd.championVerification.ok')"
  printf '  window-4 compute now: %s\n' "$(window4_compute | wc -l | tr -d ' ') process(es)"
  for st in V2a W5-0b C2 L1 G1 H1 D5 ACC5 L1mse DEV1; do smoke_valid $st && echo "  smoke $st: valid"; done
  exit 0
fi

# ======================================================================= smoke phases (T-smoke)
if [ $MODE = smokeall ] || [ $MODE = smokee2 ]; then
  [ $MODE = smokeall ] && LIST=(V2a W5-0b C2 L1 G1 H1) || LIST=(D5 ACC5 L1mse DEV1)
  [ $MODE = smokeall ] && [ ! -d $SRC ] && { echo "src-e not frozen" >&2; exit 2; }
  [ $MODE = smokee2 ] && [ ! -d $SRC2 ] && { echo "src-e2 not frozen" >&2; exit 2; }
  TID=T-smoke; [ $MODE = smokee2 ] && TID=T-smoke-e2
  log "START $TID ${LIST[*]} (each under its own launchd job, one at a time)"
  ok=0 bad=0
  for st in $LIST; do
    sc=$(script_of $st)
    if [ ! -f $sc ]; then log "NOTE T-smoke: scripts/${sc:t} absent: $st not smoked (SKIPPED at its event)"; continue; fi
    w=1; case $st in G1) w=2 ;; D5) w=3 ;; ACC5) w=4 ;; esac
    mv -f $R/$st/smoke-meta.json $R/$st/smoke-meta.previous.json 2>/dev/null
    do_smoke $st $w && ok=$((ok + 1)) || bad=$((bad + 1))
  done
  log "END $TID rc=$bad passed=$ok failed=$bad"
  exit $bad
fi

# ======================================================================= steps (run)
step_W50() {
  wait_until $T_W50 || { log "SKIP W5-0 (STOP)"; return 1; }
  log "START W5-0 compute check, seed audit, protocol v1 (champion verification), human-research check"
  local noted=0
  while window4_alive; do
    [ $noted = 0 ] && { log "W5-0: waiting for window 4's compute processes to exit (F1; its 8770 dashboard and queue.sh excluded): $(window4_compute | cut -c1-120 | head -3 | tr '\n' ';')"; noted=1; }
    gstop && { log "END W5-0 rc=1 STOP"; return 1; }
    [ $(now) -ge $(tor 01:00) ] && { log "END W5-0 rc=1 window-4 compute still present at 01:00: nothing starts"; return 1; }
    sleep 30
  done
  pgrep -f "window4-20261110/scripts/queue.sh" > /dev/null && log "W5-0: window-4 queue.sh still alive (it can start nothing after 23:30; logged, not touched)"
  local bad=
  # trainer python (stdlib only here), never /usr/bin/python3 (review of src-e, 22:10 Toronto)
  (cd /tmp && $PY -I $R/scripts/seed_audit.py --repo=$SRC > $R/logs/W5-0-seed-audit.out 2>&1)
  [ "$(jget $R/seed-audit.json 'd.verdict')" = clean ] || bad="seed audit $(jget $R/seed-audit.json 'd.verdict')"
  (cd $SRC && node --no-warnings $R/scripts/strip_human.mjs --src=$SRC --check=1 > $R/logs/W5-0-strip.out 2>&1) || bad="${bad:+$bad; }human-research check failed"
  (cd /tmp && $PY -I $R/scripts/make_protocol.py --stage=W5-0 --src=$SRC > $R/logs/W5-0-protocol.out 2>&1) || bad="${bad:+$bad; }protocol/champion: $(tail -1 $R/logs/W5-0-protocol.out | cut -c1-300)"
  [ "$(jget $R/protocol.json 'd.championVerification.ok')" = true ] || bad="${bad:+$bad; }champion verification not ok"
  if [ -n "$bad" ]; then
    echo "W5-0 failed: $bad" > $QSTOP
    log "END W5-0 rc=4 FAILED: $bad -> QUEUE-STOP: nothing starts (review R4/section 6)"
    return 1
  fi
  log "END W5-0 rc=0 seed audit clean; champion 017 verified (catalog, manifest, accept gate 330, weight 462afc99); protocol.json sha256 $(sha $R/protocol.json); human-research manifest $(sha $INPUTS/human-research/manifest.json); src-e $(src_commit $SRC | cut -c1-12)"
  return 0
}

step_V2a() { wait_until $T_HEAVY V2a || { log "SKIP V2a (STOP)"; return; }; launch V2a 1 $(( $(now) + 3900 )); }
step_W5b() {
  wait_until $T_HEAVY W5-0b || { log "SKIP W5-0b (STOP)"; return; }
  qstop && { log "SKIP W5-0b (STOP/QUEUE-STOP)"; return; }
  do_smoke W5-0b 1 || { log "SKIP W5-0b (smoke: $(jget $R/W5-0b/smoke.json 'd.reason' | cut -c1-200))"; return; }
  local g; g=$(gate W5-0b 1) || { log "SKIP W5-0b (smoke: $g)"; return; }
  local dl=$(( $(now) + 1800 ))
  log "START W5-0b scripts/w5b.sh (sha256 $(sha $R/scripts/w5b.sh)) 1 core until $(toronto $dl) Toronto"
  mkdir -p $R/W5-0b
  run_bounded W5-0b $dl "window5-20261111/scripts/w5b" /bin/zsh $R/scripts/w5b.sh --run --deadline=$(iso $dl) >> $R/logs/W5-0b.log 2>&1
  log "END W5-0b rc=$?"
}

# ---- C2 slot manager (elastic; F2/F3) ----
heavy_busy() {
  local b=0
  running G1 && b=$((b + 2)); running H1 && b=$((b + 1)); running D5 && b=$((b + 3)); running ACC5 && b=$((b + 4))
  running L1-mse && b=$((b + 1)); running W5-0b && b=$((b + 1)); running DEV-1 && b=$((b + 1))
  ended D5 && ! ended M5 && b=$((b + 4))
  echo $b
}
# L1's replay fills to 1.6 M rows over hours (np.zeros pages are touched as rows arrive), so a C2 slot
# launched beside a young L1 would see memory that L1 will still take. From V2a END until L1 ends,
# each new slot's memory rule also reserves L1's not-yet-resident part: registered L1 peak (5,397 MB)
# minus the learner's current RSS (review of src-e: the per-launch rule alone over-commits).
l1_reserve_mb() {
  ended V2a || { echo 0; return; }
  ended L1 && { echo 0; return; }
  local pid=$(pgrep -f "learner\.py --run=$R/L1/run" | head -1) rss=0
  [ -n "$pid" ] && rss=$(( $(ps -o rss= -p $pid 2>/dev/null | tr -d ' ' || echo 0) / 1024 ))
  local r=$(( $(registered_peak_mb L1) - ${rss:-0} )); [ $r -lt 0 ] && r=0
  echo $r
}
slot_running() { pgrep -f "C2.sh --run --slot=$1 " > /dev/null || pgrep -f "window5-20261111/C2/slot-$1( |,|$)" > /dev/null; }
start_slot() { # <s>
  local s=$1 st=C2-$1
  local dl=$T_C2_END
  log "START C2-$s scripts/C2.sh (sha256 $(sha $R/scripts/C2.sh)) slot $s deals $((4290400000 + 10000 * s))-$((4290400000 + 10000 * s + 9999)) until $(toronto $dl) Toronto; src-e $(src_commit $SRC | cut -c1-12)"
  ( run_bounded $st $dl "window5-20261111/C2/slot-$s" /bin/zsh $R/scripts/C2.sh --run --slot=$s --deadline=$(iso $dl) --workers=1 >> $R/logs/C2-slot-$s.log 2>&1
    rc=$?; log "END C2-$s rc=$rc" ) &
}
step_C2() {
  wait_until $T_HEAVY C2 || { log "SKIP C2 (STOP)"; return; }
  local noted=0
  while ! grep -q '"phase": *"ready"' $R/V2a/train.log 2>/dev/null && ! ended V2a && [ $(now) -lt $T_C2_LATEST ]; do
    [ $noted = 0 ] && { log "C2: waiting for V2a training (train.log ready) or V2a exit, $(toronto $T_C2_LATEST) at the latest (C7)"; noted=1; }
    gstop && { log "SKIP C2 (STOP)"; return; }; sleep 15
  done
  qstop && { log "SKIP C2 (STOP/QUEUE-STOP)"; return; }
  do_smoke C2 1 || { log "SKIP C2 (smoke failed: no corpus tonight; L1 has no data)"; return; }
  log "START C2 slot manager (target 2 during V2a; after V2a END min($C2_MAX, 8 - heavy cores busy), memory rule per slot)"
  local next=0 target
  while [ $(now) -lt $((T_C2_END - 1800)) ] && ! qstop; do
    if ended V2a; then target=$(( 8 - $(heavy_busy) )); [ $target -gt $C2_MAX ] && target=$C2_MAX; else target=2; fi
    local alive=0; for s in {0..9}; do slot_running $s && alive=$((alive + 1)); done
    if [ $alive -lt $target ] && [ $next -le 9 ]; then
      local g rsv=$(l1_reserve_mb); if g=$(/bin/zsh $PF gate C2 1 $(( $(registered_peak_mb C2) + rsv ))); then
        [ $rsv -gt 0 ] && g="$g (registered C2 2,300 MB + L1 not yet resident $rsv MB)"
        log "C2: slot $next: memory rule ok ($g); $alive running, target $target"
        start_slot $next; next=$((next + 1)); sleep 60; continue
      else
        log "C2: slot $next waits: $g ($alive running, target $target)"; sleep 300; continue
      fi
    fi
    sleep 60
  done
  wait
  log "END C2 rc=0 slots started: $next (last start 30 min before $(toronto $T_C2_END)); per-slot END/PARTIAL lines above"
}

step_L1() {
  while ! ended V2a; do gstop && { log "SKIP L1 (STOP)"; return; }; sleep 20; done
  pgrep -f "window5-20261111/V2a/" > /dev/null && sleep 30
  # L1.sh stops the learner itself at 08:30 (watcher -> run/STOP -> final export); the queue's hard
  # kill comes 4 min later so the export and checkpoint are written
  launch L1 1 $((T_L1_END + 240))
}
step_H1() {
  while ! ended V2a; do gstop && { log "SKIP H1 (STOP)"; return; }; sleep 20; done
  v2a_ok || { log "SKIP H1 (no registered v2a: V2a not trained or not registered; v1-only human calibration exists from window 3)"; return; }
  launch H1 1 $(( $(now) + 2400 ))
}
step_G1() {
  while ! ended V2a; do gstop && { log "SKIP G1 (STOP)"; return; }; sleep 20; done
  v2a_ok || { log "SKIP G1 (no registered v2a)"; return; }
  launch G1 2 $(( $(now) + 4500 ))
}
step_D5() {
  while ! ended H1; do gstop && { log "SKIP D5 (STOP)"; log "SKIP ACC5 (STOP)"; return; }; sleep 20; done
  v2a_ok || { log "SKIP D5 (no registered v2a)"; log "SKIP M5 (no D5)"; log "SKIP ACC5 (no registered v2a)"; return; }
  while [ ! -f $R/scripts/D5.sh ] || [ ! -d $SRC2 ]; do
    [ $(now) -ge $T_E2_WAIT ] && { log "SKIP D5 (scripts/D5.sh or src-e2 absent at $(toronto $T_E2_WAIT): D5/ACC5 code not frozen; no acceptance tonight; v2a and D5 readiness recorded)"; log "SKIP M5 (no D5)"; log "SKIP ACC5 (D5 SKIPPED)"; return; }
    gstop && { log "SKIP D5 (STOP)"; return; }; sleep 30
  done
  launch D5 3 $(( $(now) + 7200 ))
  local rc=$?
  [ $rc = 0 ] || [ -f $R/D5/compare.json ] || { log "SKIP M5 (D5 rc=$rc, no compare)"; log "SKIP ACC5 (D5 did not complete)"; return; }
  if [ ! -f $R/scripts/m5.py ]; then log "SKIP M5 (scripts/m5.py absent)"; log "SKIP ACC5 (no M5 decision)"; return; fi
  log "START M5 decision (D5 fault rule, N formula F5, worker split)"
  mkdir -p $R/M5
  $PY -u $R/scripts/m5.py --rt=$R --acc5-end=$(iso $T_ACC5_END) --out=$R/M5/decision.json > $R/logs/M5.log 2>&1
  local mrc=$? dec=$(jget $R/M5/decision.json 'd.acc5') why=$(jget $R/M5/decision.json 'd.reason')
  echo "$(date -u +%FT%TZ) NOTE M5 $(jget $R/M5/decision.json 'JSON.stringify(d)')" >> $ADDENDUM
  log "END M5 rc=$mrc acc5=$dec N=$(jget $R/M5/decision.json 'd.N') split A/B=$(jget $R/M5/decision.json 'd.workersA')/$(jget $R/M5/decision.json 'd.workersB') reason: $why"
  if [ "$dec" != run ]; then log "SKIP ACC5 (M5: ${why:-no decision})"; return; fi
  [ -f $R/scripts/ACC5.sh ] || { log "SKIP ACC5 (scripts/ACC5.sh absent)"; return; }
  launch ACC5 4 $T_ACC5_END
}
step_L1mse() {
  wait_until $T_E2 L1-mse || return
  local seen= exp
  while ! ended L1; do
    gstop && return
    if [ -f $R/scripts/L1mse.sh ] && [ -d $SRC2 ]; then
      exp=$(grep " REGISTER L1-v" $ADDENDUM 2>/dev/null | tail -1 | sed -E 's/.* path=([^ ]+).*/\1/')
      if [ -n "$exp" ] && [ "$exp" != "$seen" ] && [ $(now) -lt $((T_L1_END - 900)) ]; then
        seen=$exp
        if do_smoke L1mse 1 && g=$(gate L1mse 1); then
          log "START L1-mse hourly reading of $(basename $exp) (descriptive, held-out set as it stands)"
          run_bounded L1-mse $(( $(now) + 900 )) "window5-20261111/scripts/L1mse" /bin/zsh $R/scripts/L1mse.sh --run --mode=hourly --export=$exp --deadline=$(iso $(( $(now) + 900 ))) >> $R/logs/L1mse.log 2>&1
          log "END L1-mse rc=$?"
        fi
      fi
    fi
    sleep 60
  done
  [ -f $R/scripts/L1mse.sh ] && [ -d $SRC2 ] || { log "SKIP L1-mse-final (scripts/L1mse.sh or src-e2 absent: no L1-mse reading tonight, stated)"; return; }
  smoke_valid L1mse || { log "SKIP L1-mse-final (no valid launchd smoke of this src-e2 commit and L1mse.sh: no L1-mse reading tonight, stated)"; return; }
  log "START L1-mse-final (frozen held-out set at 08:30; 017, recalibrated 017, every export, history and belief shuffles; READ: band > 40 vs recalibrated 017)"
  run_bounded L1-mse-final $T_MSE_FINAL_END "window5-20261111/scripts/L1mse" /bin/zsh $R/scripts/L1mse.sh --run --mode=final --deadline=$(iso $T_MSE_FINAL_END) >> $R/logs/L1mse.log 2>&1
  log "END L1-mse-final rc=$?"
}
step_DEV1() {
  wait_until $T_E2_SMOKE_END DEV-1 || return
  wait_until $T_DEV1 DEV-1 || return
  [ -f $R/scripts/DEV1.sh ] && [ -d $SRC2 ] || { log "SKIP DEV-1 (scripts/DEV1.sh or src-e2 absent: item 7 not frozen)"; return; }
  smoke_valid DEV1 || { log "SKIP DEV-1 (no valid launchd smoke from the 01:45-02:15 src-e2 smoke phase)"; return; }
  log "START DEV-1 inference-path parity (fault check only) until $(toronto $T_DEV1_END)"
  run_bounded DEV-1 $T_DEV1_END "window5-20261111/DEV1/" /bin/zsh $R/scripts/DEV1.sh --run --deadline=$(iso $T_DEV1_END) --workers=1 >> $R/logs/DEV1.log 2>&1
  log "END DEV-1 rc=$?"
}
step_smoke_e2() {
  wait_until $T_E2 || return
  while [ ! -d $SRC2 ] && [ $(now) -lt $T_E2_SMOKE_END ]; do gstop && return; sleep 30; done
  [ -d $SRC2 ] || { log "NOTE T-smoke-e2: src-e2 not frozen by $(toronto $T_E2_SMOKE_END): src-e2 stages SKIPPED at their events"; return; }
  /bin/zsh $R/scripts/queue.sh --smoke-e2
}

finish() { log "queue end"; launchctl remove com.guandanai.w5-queue 2>/dev/null; exit 0; }

# ======================================================================= main
log "queue start pid $$ (queue.sh sha256 $(sha $R/scripts/queue.sh), preflight.sh $(sha $PF), common.sh $(sha $R/scripts/common.sh), protocol.json $(sha $R/protocol.json))"
[ -d $SRC ] || { log "queue: frozen checkout $SRC missing: nothing started"; finish; }
cd $SRC
step_W50 || finish
step_V2a & P1=$!
step_W5b & P2=$!
step_C2 & P3=$!
step_L1 & P4=$!
step_H1 & P5=$!
step_G1 & P6=$!
step_D5 & P7=$!
step_L1mse & P8=$!
step_smoke_e2 & P9=$!
step_DEV1 & P10=$!
wait_until $NO_NEW_COMPUTE
/bin/zsh $R/scripts/close.sh
wait_until $PGREP_CLEAN
for p in $P1 $P2 $P3 $P4 $P5 $P6 $P7 $P8 $P9 $P10; do kill $p 2>/dev/null; done
finish
