# Shared helpers for window-5 stage scripts (sourced by zsh). stages.log times are UTC ISO; the
# dashboard (port 8771) shows them in Toronto time (美东). Window 5 = 23:50 Toronto -> 09:00 Toronto
# next morning (EST = UTC-5); no new compute after 08:40 (PLAN sections 4 and 7, review fix C1).
R=/Users/stevensun/guandan-runtime.noindex/window5-20261111
R4=/Users/stevensun/guandan-runtime.noindex/window4-20261110
export PATH=/Users/stevensun/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin:/usr/sbin:/sbin
NODE_BIN=/Users/stevensun/.nvm/versions/node/v24.15.0/bin/node
# The trainer's python (windows 3-4). Never /usr/bin/python3 for numpy/torch steps. It stays on
# ~/Desktop as in window 4, where it worked under launchd (PLAN C13, stated).
PY=/Users/stevensun/Desktop/guandanai/ai/danMCai/environment/mac/bin/python
# Frozen checkouts (detached worktrees made by the launcher): src-e at 23:35, src-e2 at 01:45.
SRC=$R/src-e
SRC2=$R/src-e2
INPUTS=$R/inputs
# Registered models (protocol.json models.*; SHA re-checked by preflight and by the stage scripts)
M017=/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx
M017SHA=462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7
BELIEF=/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx
BELIEFSHA=16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9
V2A=$R/V2a/model/belief.onnx
ADDENDUM=$R/protocol-addendum.jsonl
# The frozen commit of a checkout: git does not work under launchd here (the worktree's gitdir is on
# ~/Desktop), so the freeze writes RT/src-e.commit / RT/src-e2.commit (scripts/freeze.sh); git is
# only the interactive fallback.
src_commit() { local d=${1:-$SRC}; [ -f $d.commit ] && { head -1 $d.commit; return; }; git -C $d rev-parse HEAD 2>/dev/null || echo unknown; }
zulu() { date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s; }
# Toronto wall clock of this window (the only place where calendar dates are written):
#   tor HH:MM -> epoch; 12:00-23:59 is the evening the window starts, 00:00-11:59 the morning it ends.
tor() {
  local h=${1%%:*} d=2026-11-11
  [ $((10#$h)) -ge 12 ] && d=2026-11-10
  TZ=America/Toronto date -j -f "%Y-%m-%d %H:%M:%S" "$d $1:00" +%s
}
toronto() { TZ=America/Toronto date -r $1 "+%H:%M"; }
iso() { date -u -r $1 +%FT%TZ; }
now() { date +%s; }
T_HEAVY=$(tor 23:50)           # heavy compute not before (and only once window 4's compute is gone)
T_ACC5_END=$(tor 08:25)
T_L1_END=$(tor 08:30)
T_C2_END=$(tor 08:35)
NO_NEW_COMPUTE=$(tor 08:40)    # L1-mse final and DEV-1 end here too
PGREP_CLEAN=$(tor 08:55)
HARD_END=$(tor 09:00)          # global deadline
log() { echo "$(date -u +%FT%TZ) $*" >> $R/stages.log; }
gstop() { [ -f $R/STOP ]; }
# stopped <stage>: global STOP or the stage's own RT/<stage>/STOP
stopped() { [ -f $R/STOP ] || [ -f $R/$1/STOP ]; }
sha() { shasum -a 256 "$1" 2>/dev/null | cut -c1-64; }
# free + inactive (MiB): the right-hand side of the memory rule (PLAN F2)
free_inactive_mib() {
  vm_stat | awk '/page size of/ {ps=$8} /Pages free/ {f=$3} /Pages inactive/ {i=$3} END {gsub(/\./,"",f); gsub(/\./,"",i); printf "%d", (f+i)*ps/1048576}'
}
# Registered measured peaks per process (MB), PLAN F2: the memory rule uses max(smoke, registered).
#   C2 slot / midgame-search worker 2,300 (C1 done.json 2,293); V2a 1.416 KB x rows + 2.5 GiB (V2a.sh
#   computes it); L1 1.6 M x 2.53 KB + 1.5 GiB = 5,397 MB; L1-mse / W5-0b / G1 / H1 / DEV-1 use their smoke.
registered_peak_mb() {
  case $1 in
    C2|C2-*|D5|ACC5) echo 2300 ;;
    L1) echo 5397 ;;
    G1) echo 2300 ;;
    *) echo 0 ;;
  esac
}
# Window 4's compute processes (PLAN F1): its 8770 dashboard (window-dashboard.mjs) and its
# queue.sh are not compute and are excluded; a live queue.sh is logged by the caller.
WINDOW4_COMPUTE='window4-20261110.*(search-actor|midgame-search|python|learner|v2a_train|g1_gate|h1\.mjs|metrics\.mjs|calib-run|panel-scorer|supervisor|S8|GZ\.sh|C1\.sh|A1\.sh|V2a\.sh|G1\.sh|H1\.sh)'
window4_compute() { pgrep -fl "$WINDOW4_COMPUTE" | grep -v "window-dashboard" ; }
window4_alive() {
  launchctl list | awk '{print $3}' | grep -E '^com\.guandanai\.w4-' | grep -qv '^com\.guandanai\.w4-queue$' && return 0
  [ -n "$(window4_compute)" ] && return 0
  return 1
}
# The ONNX SHA a key resolves to: protocol.json models.<key>.sha256, else the latest addendum
# REGISTER line for that key (V2a.sh writes `REGISTER v2a sha256=...`; review fix C2).
registered_sha() {
  node -e '
    const fs = require("fs"); const [p, a, k] = process.argv.slice(1); let s = "";
    try { const m = JSON.parse(fs.readFileSync(p, "utf8")).models?.[k]; if (m && m.sha256) s = m.sha256; } catch {}
    try { for (const l of fs.readFileSync(a, "utf8").split("\n")) { const m = /^\S+ REGISTER (\S+) sha256=([0-9a-f]{64})/.exec(l); if (m && m[1] === k) s = m[2]; } } catch {}
    process.stdout.write(s);' $R/protocol.json $ADDENDUM "$1"
}
