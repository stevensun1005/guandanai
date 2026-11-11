#!/bin/zsh
# Window-5 dashboard on port 8771 (read-only; ai/research/tools/window-dashboard.mjs, 2026-11-09 format).
#   dashboard.sh <checkout>   (re)submit launchd job com.guandanai.dashboard8771 serving RT/dashboard.json
#                             from <checkout>/ai/research/tools/window-dashboard.mjs, --host=0.0.0.0
# Restarts only this dashboard process; never touches a stage or window 4's 8770. Started from the
# temporary detached checkout RT/dash-src (origin/main); the launcher re-runs it with RT/src-e once
# the checkout is frozen. Its launchd smoke (PLAN section 5): one HTTP fetch of /api/status in which
# every configured card is present and parsed without error; else exit 1.
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
CO=${1:?usage: dashboard.sh <checkout>}
TOOL=$CO/ai/research/tools/window-dashboard.mjs
LABEL=com.guandanai.dashboard8771
[ -f $TOOL ] || { echo "no $TOOL" >&2; exit 2; }
node --check $TOOL || exit 2
mkdir -p $R/logs
launchctl remove $LABEL 2>/dev/null; sleep 2
launchctl submit -l $LABEL -o $R/logs/dashboard-8771.log -e $R/logs/dashboard-8771.log -- \
  $NODE_BIN $TOOL --run=$R --config=$R/dashboard.json --port=8771 --host=0.0.0.0 || exit 1
for i in {1..20}; do curl -fsS -o /dev/null http://127.0.0.1:8771/ 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:8771/ || { echo "dashboard not answering on 8771" >&2; exit 1; }
CHECK=$(curl -fsS http://127.0.0.1:8771/api/status | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const j = JSON.parse(s); const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const keys = new Set(j.stages.map((x) => x.key)); const missing = cfg.stages.filter((x) => !keys.has(x.key)).map((x) => x.key);
    const errors = j.stages.filter((x) => x.error).map((x) => x.key + ": " + x.error);
    console.log(JSON.stringify({ cards: j.stages.length, configured: cfg.stages.length, missing, errors }));
    process.exit(missing.length || errors.length ? 1 : 0); });' $R/dashboard.json) || { echo "dashboard smoke failed: $CHECK" >&2; exit 1; }
PID=$(launchctl list | awk -v l=$LABEL '$3==l {print $1}')
echo "$LABEL pid $PID serving $TOOL ($(git -C $CO rev-parse --short HEAD 2>/dev/null)); smoke $CHECK"
log "SMOKE dashboard8771 rc=0 rss=0 s=0 (HTTP /api/status: $CHECK; launchd $LABEL pid $PID; tool $(git -C $CO rev-parse --short HEAD 2>/dev/null))"
