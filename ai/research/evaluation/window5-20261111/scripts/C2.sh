#!/bin/zsh
# Window-5 C2 (PLAN section 4): the search-actor corpus, schema 2, one independent single-worker slot
# per invocation. Data for L1 (and later windows if authorized); descriptive, no decision rule.
#   C2.sh --smoke                                        one round, --rows=all --history=1 (seed
#                                                        4291000011, parity seeds, no evidence); checks
#                                                        h.i8 = rows x 1080 and m.u8 = rows x 3 bytes
#   C2.sh --run --slot=<s> --deadline=<ISO> [--workers=1] the slot (queue.sh starts slots on events)
# Slot s plays deals 4290400000 + 10,000 s ... + 9,999 in order (PLAN section 6), blocks of 100
# rounds, --max-gb=1.6 per slot (disk cap), all four seats: belief-v1 worlds at 21-40, exact PIMC at
# <= 20 with 8 belief worlds, raw 017 above 40 with softmax 0.02 (as C1). --rows=all --history=1:
# x/y/e + h.i8 (1,080 count-encoded history, GuanZero's encoding only) + m.u8 (round index, band
# code, cards). Fallback (PLAN section 8): if src-e's search-actor has no --history, the slot runs
# schema 1 with --rows=all (stated in stages.log; L1 then runs as L1-215).
# The actor stops 4 min before the slot deadline (08:35 at the latest) so a kill never lands
# mid-write; a stop (RT/STOP, RT/C2/STOP, RT/C2/slot-<s>/STOP, deadline, disk cap) discards only the
# unfinished block, logged as `PARTIAL slot=<s> rounds_lost=<n>` (n estimated from that block's
# start time and the slot's mean seconds per round, C9). A re-run of a slot resumes (--resume=1).
# Writes C2/slot-<s>/slot-manifest.json: per block the file SHA-256s, rows per band (m.u8), rounds/h.
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
SA=ai/danMCai/training/continuous/search-actor.mjs
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=3072}
MODE= DL= W=1 SLOT=
for a in "$@"; do
  case $a in --smoke) MODE=smoke ;; --run) MODE=run ;; --deadline=*) DL=${a#*=} ;; --workers=*) W=${a#*=} ;; --slot=*) SLOT=${a#*=} ;; esac
done
cd $SRC || { echo "frozen checkout $SRC missing" >&2; exit 3; }
[ "$(sha $M017)" = $M017SHA ] && [ "$(sha $BELIEF)" = $BELIEFSHA ] || { echo "017 or belief v1 sha mismatch" >&2; exit 3; }
NODE=(nice -n 10 node --no-warnings)
HIST=(--history=1); SCHEMA=2
grep -q "HISTORY_FEATURES" $SA && grep -q "'--history=0|1'" $SA || { HIST=(); SCHEMA=1; }
COMMON=(--champion=$M017 --belief=$BELIEF --rows=all --block-rounds=100 --temperature=0.02 $HIST)

if [ "$MODE" = smoke ]; then
  U=$R/C2/smoke-work/unit-$$; rm -rf $R/C2/smoke-work/unit-*(N/mm+30); mkdir -p ${U:h}
  $NODE $SA --out=$U --start=4291000011 --rounds=1 --block-rounds=1 --workers=1 --minutes=10 \
    --champion=$M017 --belief=$BELIEF --rows=all --temperature=0.02 $HIST || exit 1
  node -e '
    const fs = require("fs"), [dir, schema] = [process.argv[1], Number(process.argv[2])];
    const b = `${dir}/blocks/b000000`; const j = JSON.parse(fs.readFileSync(`${b}/b000000-000000000.json`, "utf8"));
    const size = (s) => fs.statSync(`${b}/b000000-000000000.${s}`).size;
    const bad = [];
    if (size("x.i8") !== j.rows * 567) bad.push("x");
    if (size("e.f32") !== j.rows * 215 * 4) bad.push("e");
    if (schema === 2) {
      if (j.schema !== 2 || j.historyFeatures !== 1080 || j.metaFeatures !== 3) bad.push("json schema 2 fields");
      if (size("h.i8") !== j.rows * 1080) bad.push("h.i8 bytes");
      if (size("m.u8") !== j.rows * 3) bad.push("m.u8 bytes");
    }
    console.log(JSON.stringify({ rows: j.rows, schema: j.schema ?? 1, wanted: schema, bad }));
    process.exit(bad.length ? 1 : 0);' $U $SCHEMA || exit 1
  [ $SCHEMA = 2 ] || echo "FALLBACK: src-e search-actor has no --history; schema 1 (--rows=all)"
  exit 0
fi
[ "$MODE" = run ] && [ -n "$DL" ] && [[ $SLOT == <0-9> ]] || { echo "usage: C2.sh --smoke | --run --slot=<0-9> --deadline=<ISO>" >&2; exit 2; }
END=$(zulu $DL); [ $END -gt $T_C2_END ] && END=$T_C2_END
OUT=$R/C2/slot-$SLOT
START=$((4290400000 + 10000 * SLOT))
mkdir -p $OUT
RES=(); [ -f $OUT/run.json ] && RES=(--resume=1)
ADL=$((END - 240))
[ $SCHEMA = 1 ] && log "NOTE C2 slot $SLOT FALLBACK: src-e search-actor has no --history: schema 1 with --rows=all (PLAN section 8; L1 runs as L1-215)"
log "NOTE C2 slot $SLOT: deals $START-$((START + 9999)) in order, blocks of 100, schema $SCHEMA, --max-gb=1.6, actor deadline $(toronto $ADL) Toronto, src-e $(src_commit $SRC | cut -c1-12)${RES:+ (resume)}"
$NODE $SA --out=$OUT --start=$START --rounds=10000 --workers=1 --max-gb=1.6 $COMMON \
  --minutes=1000 --deadline=$(iso $ADL) --stop-file=$R/STOP,$R/C2/STOP,$OUT/STOP $RES >> $R/logs/C2-slot-$SLOT.actor.log 2>&1
RC=$?
STOPPED_AT=$(now)
node --no-warnings $SA --summarize=1 --out=$OUT > /dev/null 2>&1
# PARTIAL (C9) + slot manifest
LINE=$(node -e '
  const fs = require("fs"), crypto = require("crypto"); const [dir, slot, stoppedAt, schema] = process.argv.slice(1);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const names = fs.existsSync(`${dir}/blocks`) ? fs.readdirSync(`${dir}/blocks`).filter((f) => /^b\d{6}\.done\.json$/.test(f)).sort() : [];
  const blocks = names.map((f) => read(`${dir}/blocks/${f}`)).filter(Boolean);
  const secs = blocks.reduce((s, b) => s + (b.seconds || 0), 0), rounds = blocks.reduce((s, b) => s + (b.rounds || 0), 0);
  const perRound = rounds ? secs / rounds : 3600 / 640; // no finished block yet: window-4 C1 rate (640 rounds/h/worker)
  const bands = [0, 0, 0];
  const out = blocks.map((b) => {
    const rec = { block: b.block, name: b.name, seeds: b.seeds, rounds: b.rounds, rows: b.rowsWritten, seconds: b.seconds, files: b.files, doneSHA256: crypto.createHash("sha256").update(fs.readFileSync(`${dir}/blocks/${b.name}.done.json`)).digest("hex") };
    const m = `${dir}/blocks/${b.name}/${b.shard}.m.u8`;
    if (fs.existsSync(m)) { const u = fs.readFileSync(m); const c = [0, 0, 0]; for (let i = 1; i < u.length; i += 3) c[u[i]]++; rec.rowsByBand = { above40: c[0], band21to40: c[1], endgameLe20: c[2] }; c.forEach((v, k) => (bands[k] += v)); }
    return rec;
  });
  const w = read(`${dir}/worker-0.done.json`); let lost = 0;
  if (w && /inside a block/.test(w.reason) && perRound) {
    const t0 = fs.statSync(`${dir}/worker-0.json`).mtimeMs / 1000; lost = Math.max(0, Math.round((Number(stoppedAt) - t0) / perRound));
  }
  const man = { schema: 1, slot: Number(slot), shardSchema: Number(schema), dir, writtenAt: new Date().toISOString(), finishedBlocks: blocks.length, rounds,
    rows: blocks.reduce((s, b) => s + (b.rowsWritten || 0), 0), rowsByBand: schema === "2" ? { above40: bands[0], band21to40: bands[1], endgameLe20: bands[2] } : "schema 1 (no m.u8)",
    roundsPerHour: secs ? rounds / (secs / 3600) : null, workerReason: w && w.reason, partial: { roundsLostEstimate: lost, rule: "rounds of the discarded unfinished block, estimated from its start (worker-0.json mtime) and the slot mean seconds per round (C1 rate 640 rounds/h when no block has finished)" },
    heldOutRule: "block index mod 10 = 9 is held out for L1-mse (by deal, never by row)", blocks: out };
  fs.writeFileSync(`${dir}/slot-manifest.json`, JSON.stringify(man, null, 1) + "\n");
  console.log(`${lost}|${blocks.length} blocks, ${rounds} rounds, ${man.rows} rows${schema === "2" ? ` (bands >40/21-40/<=20: ${bands.join("/")})` : ""}, ${Math.round(man.roundsPerHour || 0)} rounds/h, reason: ${w && w.reason}`);' $OUT $SLOT $STOPPED_AT $SCHEMA 2>/dev/null)
log "PARTIAL slot=$SLOT rounds_lost=${LINE%%|*}"
log "NOTE C2 slot $SLOT stopped rc=$RC: ${LINE#*|}; slot-manifest.json sha256 $(sha $OUT/slot-manifest.json)"
exit $RC
