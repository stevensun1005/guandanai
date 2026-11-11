#!/bin/zsh
# Window-5 T-close (PLAN sections 4 and 7): run by queue.sh at 08:40 Toronto (or on RT/STOP).
#   close.sh            STOP everything (RT/STOP), wait for stage scripts to save (C2 PARTIAL lines,
#                       L1 final export + checkpoint, evaluations keep their prefix), then write the
#                       closing record: every C2 slot manifest SHA and the corpus totals, the L1
#                       final export, the addendum SHA; window-5 compute processes gone by 08:55
#                       (leftovers TERM/KILL, the 8771 dashboard and queue.sh itself excepted).
#   close.sh --dry-run  print what it would do.
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
[ "$1" = --dry-run ] && { echo "would: touch $R/STOP; wait until $(toronto $PGREP_CLEAN) for window-5 compute to exit; write $R/close.json; kill leftovers (dashboard excepted)"; exit 0; }
log "START T-close STOP at $(toronto $(now)) Toronto (no new compute after 08:40; hard end 09:00)"
[ -f $R/STOP ] || echo "{\"by\":\"close.sh\",\"at\":\"$(date -u +%FT%TZ)\"}" > $R/STOP
compute() { pgrep -fl "window5-20261111" | grep -v "window-dashboard\|scripts/queue.sh\|scripts/close.sh\|pgrep" ; }
while [ -n "$(compute)" ] && [ $(now) -lt $PGREP_CLEAN ]; do sleep 10; done
left=$(compute)
if [ -n "$left" ]; then
  pids=(${(f)"$(echo $left | cut -d' ' -f1)"})
  log "NOTE T-close: $(echo $left | wc -l | tr -d ' ') window-5 process(es) still running at $(toronto $(now)): TERM, then KILL"
  kill -TERM $pids 2>/dev/null; sleep 10; kill -KILL $pids 2>/dev/null
fi
node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path"); const R = process.argv[1];
  const sha = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const slots = (fs.existsSync(`${R}/C2`) ? fs.readdirSync(`${R}/C2`) : []).filter((d) => /^slot-\d$/.test(d)).sort().map((d) => {
    const m = read(`${R}/C2/${d}/slot-manifest.json`);
    return { slot: d, manifest: `${R}/C2/${d}/slot-manifest.json`, sha256: sha(`${R}/C2/${d}/slot-manifest.json`),
      blocks: m?.finishedBlocks ?? 0, rounds: m?.rounds ?? 0, rows: m?.rows ?? 0, rowsByBand: m?.rowsByBand ?? null, roundsPerHour: m?.roundsPerHour ?? null, partial: m?.partial ?? null };
  });
  const tot = (k) => slots.reduce((s, x) => s + (x[k] || 0), 0);
  const latest = read(`${R}/L1/run/models/latest.json`);
  const out = { stage: "T-close", writtenAt: new Date().toISOString(),
    C2: { slots, blocks: tot("blocks"), rounds: tot("rounds"), rows: tot("rows") },
    L1: latest ? { version: latest.version, step: latest.step, sha256: latest.sha256, file: latest.file ? `${R}/L1/run/models/${latest.file}` : null,
      checkpoint: { path: `${R}/L1/run/learner/checkpoint.pt`, sha256: sha(`${R}/L1/run/learner/checkpoint.pt`) },
      heldout: { path: `${R}/L1/heldout.json`, sha256: sha(`${R}/L1/heldout.json`) }, feed: { path: `${R}/L1/feed.jsonl`, sha256: sha(`${R}/L1/feed.jsonl`) } } : "no L1 run",
    addendum: { path: `${R}/protocol-addendum.jsonl`, sha256: sha(`${R}/protocol-addendum.jsonl`) },
    protocol: { path: `${R}/protocol.json`, sha256: sha(`${R}/protocol.json`) },
    note: "continuing L1 past this window needs new owner authorization (R1); nothing here changes web, champion, default or menu" };
  fs.writeFileSync(`${R}/close.json`, JSON.stringify(out, null, 1) + "\n");
  console.log(`C2 ${out.C2.blocks} blocks ${out.C2.rounds} rounds ${out.C2.rows} rows over ${slots.length} slots; L1 ${latest ? latest.version + " step " + latest.step : "none"}`);' $R > $R/logs/close.out 2>&1
echo "$(date -u +%FT%TZ) NOTE T-close close.json sha256=$(sha $R/close.json) $(tail -1 $R/logs/close.out)" >> $ADDENDUM
log "END T-close rc=0 $(tail -1 $R/logs/close.out); close.json sha256 $(sha $R/close.json); addendum sha256 $(sha $ADDENDUM); window-5 compute left: $(compute | wc -l | tr -d ' ')"
