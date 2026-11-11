#!/bin/zsh
# Window 5 launchd preflight (PLAN section 5; window 4's preflight.sh with the review fixes F2, C1,
# C2, C13). Generic: one stage name + its smoke unit. Every stage's real command runs only after this
# smoke ran UNDER LAUNCHD (never interactively) with rc = 0 and the memory rule holds.
#
#   preflight.sh launch <stage> [options] -- <unit command ...>
#       Writes RT/<stage>/smoke-spec.zsh, submits launchd job com.guandanai.w5-<stage>-smoke running
#       `preflight.sh run <stage>`, waits for RT/<stage>/smoke.json (or --timeout), removes the job,
#       prints smoke.json and exits with its rc (1 on timeout).
#     options:
#       --workers=N          worker count the real run will use (memory rule; default 1)
#       --inputs=a,b         paths under RT/inputs that must be listable by node (private inputs)
#       --files=a,b          other absolute paths the stage reads (models, data); checked by node
#       --tools=a.mjs,b.mjs  tools the stage calls (relative to --cwd or absolute): `node --check`
#                            plus import of every static import of the tool (importing a CLI tool
#                            itself would start it: supervisor.mjs has no main guard)
#       --python=1           trainer python must `import numpy, torch` (never /usr/bin/python3)
#       --onnx=k1,path@sha   ONNX files: a protocol.json models key or a protocol-addendum.jsonl
#                            REGISTER key (C2: v2a), or path@expected-sha256; mismatch -> rc 3 (SKIP)
#       --deadline=EPOCH     the stage's own deadline; must be > 60 min ahead (C1) else rc 3
#       --resolve=1          C13: every static import of every tool (recursively) must resolve under
#                            --cwd (the frozen src), and history.mjs / encoding.mjs, when reached,
#                            must lie under it; nothing may resolve into ~/Desktop
#       --src=e|e2           the freeze the stage runs from (recorded as srcFreeze)
#       --heap=MB            NODE_OPTIONS=--max-old-space-size=MB for the unit (default 3072)
#       --cwd=DIR            working directory of the unit (default RT/src-e)
#       --timeout=SEC        launch waits at most SEC for smoke.json (default 1200)
#   preflight.sh run <stage>      (inside launchd only) the checks + one unit under /usr/bin/time -l
#   preflight.sh gate <stage> [workers] [peakMB]
#       Memory rule (F2): smoke rc = 0 and max(smoke peakRSS, registered peak) x workers + 4 GiB <
#       free + inactive now (registered peak = common.sh registered_peak_mb <stage>, or the explicit
#       peakMB argument). Exit 0 and print "ok ..." or exit 1 and print the reason (the caller logs
#       SKIP <stage> (smoke: reason)).
#
# smoke.json: {stage, rc, peakRSS (bytes, largest single process of the unit; /usr/bin/time -l),
#   peakRSSMB, seconds, node, nodeVersion, python, pythonImports, onnxSHA {path: sha}, inputs,
#   tools, heapMB, workers, cwd, unit, launchdLabel, startedAt, endedAt, reason, srcFreeze,
#   srcCommit, deadlineAheadMin, resolve}
# stages.log: "SMOKE <stage> rc=<rc> rss=<MB> s=<seconds>" (+ reason when rc != 0).
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
MODE=$1; STAGE=$2
[ -n "$MODE" ] && [ -n "$STAGE" ] || { echo "usage: preflight.sh launch|run|gate <stage> ..." >&2; exit 2; }
SD=$R/$STAGE; SPEC=$SD/smoke-spec.zsh; SMOKE=$SD/smoke.json
LABEL=com.guandanai.w5-$STAGE-smoke

case $MODE in
# ------------------------------------------------------------------ launch (interactive or queue)
launch)
  shift 2
  WORKERS=1 INLIST= FILES= TOOLS= NEEDPY=0 ONNX= HEAP=3072 CWD=$SRC TIMEOUT=1200 DLE=0 RESOLVE=0 FREEZE=e
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    case $1 in
      --workers=*) WORKERS=${1#*=} ;; --inputs=*) INLIST=${1#*=} ;; --files=*) FILES=${1#*=} ;;
      --tools=*) TOOLS=${1#*=} ;; --python=*) NEEDPY=${1#*=} ;; --onnx=*) ONNX=${1#*=} ;;
      --heap=*) HEAP=${1#*=} ;; --cwd=*) CWD=${1#*=} ;; --timeout=*) TIMEOUT=${1#*=} ;;
      --deadline=*) DLE=${1#*=} ;; --resolve=*) RESOLVE=${1#*=} ;; --src=*) FREEZE=${1#*=} ;;
      *) echo "unknown option $1" >&2; exit 2 ;;
    esac; shift
  done
  [ "$1" = "--" ] && shift
  [ $# -gt 0 ] || { echo "no unit command after --" >&2; exit 2; }
  UNIT=("$@")
  mkdir -p $SD $R/logs
  { typeset -p WORKERS INLIST FILES TOOLS NEEDPY ONNX HEAP CWD UNIT DLE RESOLVE FREEZE; } > $SPEC
  rm -f $SMOKE
  launchctl remove $LABEL 2>/dev/null; sleep 1
  launchctl submit -l $LABEL -o $R/logs/$STAGE-smoke.log -e $R/logs/$STAGE-smoke.log -- \
    /bin/zsh $R/scripts/preflight.sh run $STAGE || { echo "launchctl submit failed" >&2; exit 1; }
  t0=$(now)
  while [ ! -f $SMOKE ]; do
    if [ $(( $(now) - t0 )) -ge $TIMEOUT ]; then
      launchctl remove $LABEL 2>/dev/null
      log "SMOKE $STAGE rc=124 rss=0 s=$TIMEOUT (timeout: no smoke.json after $TIMEOUT s under launchd)"
      echo "{\"stage\":\"$STAGE\",\"rc\":124,\"reason\":\"timeout after $TIMEOUT s under launchd\"}" > $SMOKE
      cat $SMOKE; exit 1
    fi
    if gstop || [ -f $SD/STOP ]; then launchctl remove $LABEL 2>/dev/null; echo "STOP during smoke" >&2; exit 1; fi
    sleep 3
  done
  sleep 1; launchctl remove $LABEL 2>/dev/null
  cat $SMOKE; echo
  rc=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$SMOKE','utf8')).rc))")
  exit $rc ;;
# ------------------------------------------------------------------ run (inside launchd)
run)
  source $SPEC || { log "SMOKE $STAGE rc=2 rss=0 s=0 (spec missing)"; exit 2; }
  export NODE_OPTIONS=--max-old-space-size=$HEAP
  STARTED=$(date -u +%FT%TZ); WORK=$SD/smoke-work; mkdir -p $WORK
  REASON=; RC=0
  fail() { [ $RC = 0 ] && { RC=$1; REASON=$2; }; }
  # 1. inputs and files listed by node (zsh under launchd cannot list ~/Desktop)
  node -e '
    const fs = require("fs"), path = require("path");
    const [base, ins, files] = process.argv.slice(1);
    const out = {}; let bad = [];
    const walk = (p) => { const s = fs.statSync(p); if (!s.isDirectory()) return [1, s.size];
      let n = 0, b = 0; for (const f of fs.readdirSync(p)) { const [x, y] = walk(path.join(p, f)); n += x; b += y; } return [n, b]; };
    for (const rel of ins ? ins.split(",") : []) {
      const p = path.resolve(base, rel);
      if (!p.startsWith(base + "/")) { bad.push(rel + " (outside RT/inputs)"); continue; }
      try { const [n, b] = walk(p); out[p] = { files: n, bytes: b }; } catch (e) { bad.push(rel + ": " + e.code); }
    }
    for (const p of files ? files.split(",") : []) {
      if (p.startsWith("/Users/stevensun/Desktop/")) { bad.push(p + " (private/stage input on ~/Desktop is not allowed)"); continue; }
      try { const [n, b] = walk(p); out[p] = { files: n, bytes: b }; } catch (e) { bad.push(p + ": " + e.code); }
    }
    fs.writeFileSync(process.argv[4], JSON.stringify({ listed: out, problems: bad }));
    process.exit(bad.length ? 1 : 0);' $R/inputs "$INLIST" "$FILES" $WORK/inputs.json 2>>$WORK/checks.log \
    || fail 3 "inputs not readable: $(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$WORK/inputs.json','utf8')).problems.join('; '))" 2>/dev/null)"
  # 2a. tools: node --check + import of every static import (from the tool's own directory)
  cd $CWD 2>/dev/null || fail 3 "cwd $CWD missing"
  TOOLRES=()
  for t in ${(s:,:)TOOLS}; do
    [ -z "$t" ] && continue
    tp=$t; [[ $tp != /* ]] && tp=$CWD/$t
    if node --check $tp 2>>$WORK/checks.log && node --input-type=module -e '
        import { readFileSync } from "node:fs"; import { dirname, resolve } from "node:path"; import { pathToFileURL } from "node:url";
        const tool = process.argv[1]; const src = readFileSync(tool, "utf8");
        const specs = [...src.matchAll(/^\s*import\s+(?:[^"'"'"';]*?\s+from\s+)?["'"'"']([^"'"'"']+)["'"'"']/gm)].map((m) => m[1]);
        for (const s of specs) await import(s.startsWith(".") ? pathToFileURL(resolve(dirname(tool), s)).href : s);
        console.log(specs.length);' $tp >>$WORK/checks.log 2>&1; then TOOLRES+=("$t:ok"); else TOOLRES+=("$t:FAIL"); fail 3 "tool $t does not load"; fi
  done
  # 2c. C13: recursive static-import resolution stays inside the frozen src (never ~/Desktop)
  RESOLVEINFO=null
  if [ "$RESOLVE" = 1 ]; then
    RESOLVEINFO=$(node --input-type=module -e '
      import { readFileSync, existsSync } from "node:fs"; import { dirname, resolve } from "node:path";
      import { createRequire } from "node:module";
      // packages (onnxruntime-node) come from src/node_modules, a symlink to the Desktop checkout as in
      // window 4 (stated); only repository source files must resolve inside the frozen src
      const [cwd, list] = process.argv.slice(1); const seen = new Set(); const bad = []; const hits = {}; const pkgs = new Set();
      const re = /^\s*(?:import|export)\s+(?:[^"'"'"';]*?\s+from\s+)?["'"'"']([^"'"'"']+)["'"'"']/gm;
      const dyn = /import\(\s*["'"'"']([^"'"'"']+)["'"'"']\s*\)/g;
      const walk = (file) => {
        if (seen.has(file)) return; seen.add(file);
        if (!file.startsWith(cwd + "/")) bad.push(file);
        if (file.startsWith("/Users/stevensun/Desktop/")) bad.push("Desktop: " + file);
        for (const [n, tail] of [["history.mjs", "/ai/guanzero/training/history.mjs"], ["encoding.mjs", "/web/src/ai/encoding.mjs"]]) if (file.endsWith(tail)) hits[n] = file;
        if (!/\.(mjs|js)$/.test(file) || file.includes("/node_modules/")) return;
        const src = readFileSync(file, "utf8");
        for (const m of [...src.matchAll(re), ...src.matchAll(dyn)]) {
          const s = m[1];
          if (s.startsWith("node:")) continue;
          let r;
          if (s.startsWith(".") || s.startsWith("/")) r = resolve(dirname(file), s);
          else { pkgs.add(s.split("/").slice(0, s.startsWith("@") ? 2 : 1).join("/")); continue; }
          if (existsSync(r)) walk(r);
        }
      };
      for (const t of list.split(",").filter(Boolean)) walk(t.startsWith("/") ? t : resolve(cwd, t));
      for (const [n, rel] of [["history.mjs", "ai/guanzero/training/history.mjs"], ["encoding.mjs", "web/src/ai/encoding.mjs"]])
        if (!existsSync(resolve(cwd, rel))) bad.push("missing " + rel + " under " + cwd);
      console.log(JSON.stringify({ files: seen.size, history: hits["history.mjs"] || null, encoding: hits["encoding.mjs"] || null, packages: [...pkgs], bad }));
      process.exit(bad.length ? 1 : 0);' $CWD "$TOOLS" 2>>$WORK/checks.log) \
      || fail 3 "import resolution leaves the frozen src $CWD: $(echo $RESOLVEINFO | cut -c1-300)"
    [ -n "$RESOLVEINFO" ] || RESOLVEINFO=null
  fi
  # 2d. C1: the stage deadline must be more than 60 min ahead
  AHEAD=null
  if [ "$DLE" -gt 0 ] 2>/dev/null; then
    AHEAD=$(( (DLE - $(now)) / 60 ))
    [ $AHEAD -gt 60 ] || fail 3 "deadline $(toronto $DLE) Toronto only $AHEAD min ahead (C1: must be > 60)"
  fi
  SRCCOMMIT=$(src_commit $CWD)
  # 2b. python
  PYINFO=null
  if [ "$NEEDPY" = 1 ]; then
    PYINFO=$($PY -c 'import json, numpy, torch; print(json.dumps({"numpy": numpy.__version__, "torch": torch.__version__, "mps": bool(torch.backends.mps.is_available())}))' 2>>$WORK/checks.log) \
      || { PYINFO=null; fail 3 "trainer python $PY cannot import numpy, torch"; }
  fi
  # 3. ONNX SHA-256 against protocol.json (key) or the given expected value (path@sha)
  ONNXRES=$(node -e '
    const fs = require("fs"), crypto = require("crypto");
    const proto = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const out = {}; const bad = [];
    const reg = {}; try { for (const l of fs.readFileSync(process.argv[3], "utf8").split("\n")) { const m = /^\S+ REGISTER (\S+) sha256=([0-9a-f]{64})(?:.*? path=(\S+))?/.exec(l); if (m) reg[m[1]] = { sha256: m[2], path: m[3] }; } } catch {}
    for (const e of (process.argv[2] || "").split(",").filter(Boolean)) {
      let p, want;
      if (e.includes("@")) [p, want] = e.split("@");
      else { const m = proto.models?.[e]?.path ? proto.models[e] : reg[e]; if (!m?.path) { bad.push(e + ": not in protocol.json models nor in the addendum"); continue; } p = m.path; want = m.sha256; }
      try { const got = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); out[p] = got; if (got !== want) bad.push(p + " sha " + got.slice(0, 8) + " != " + String(want).slice(0, 8)); }
      catch (err) { bad.push(p + ": " + err.code); }
    }
    console.log(JSON.stringify({ sha: out, bad }));' $R/protocol.json "$ONNX" $ADDENDUM 2>>$WORK/checks.log)
  echo "$ONNXRES" | grep -q '"bad":\[\]' || fail 3 "onnx: $(echo $ONNXRES | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).bad.join("; "))}catch{process.stdout.write("check failed")}})')"
  # 4. one full-budget unit under /usr/bin/time -l (skipped if a check already failed)
  SECS=0; RSS=0; URC=null
  if [ $RC = 0 ]; then
    t0=$(now)
    /usr/bin/time -l -o $WORK/time.txt nice -n 10 "${UNIT[@]}" > $WORK/unit.log 2>&1
    URC=$?; SECS=$(( $(now) - t0 ))
    RSS=$(awk '/maximum resident set size/ {print $1}' $WORK/time.txt 2>/dev/null); RSS=${RSS:-0}
    [ $URC = 0 ] || fail $URC "unit exited $URC (tail: $(tail -c 300 $WORK/unit.log | tr '\n"' '  '))"
  fi
  RSSMB=$(( RSS / 1048576 ))
  ENDED=$(date -u +%FT%TZ)
  RC=$RC REASON=$REASON STAGE=$STAGE RSS=$RSS SECS=$SECS URC=$URC PYINFO=$PYINFO ONNXRES=$ONNXRES \
  TOOLRES="${TOOLRES[*]}" WORKERS=$WORKERS HEAP=$HEAP CWD=$CWD STARTED=$STARTED ENDED=$ENDED LABEL=$LABEL \
  FREEZE=$FREEZE SRCCOMMIT=$SRCCOMMIT AHEAD=$AHEAD RESOLVEINFO=$RESOLVEINFO \
  NODEPATH=$(command -v node) PYPATH=$PY UNITJSON="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${UNIT[@]}")" \
  node -e '
    const fs = require("fs"); const e = process.env; const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
    const o = { stage: e.STAGE, rc: Number(e.RC), peakRSS: Number(e.RSS), peakRSSMB: Math.round(Number(e.RSS) / 1048576),
      peakRSSNote: "largest single process of the unit (/usr/bin/time -l maximum resident set size)",
      seconds: Number(e.SECS), unitRc: e.URC === "null" ? null : Number(e.URC), node: e.NODEPATH, nodeVersion: process.version,
      python: e.PYPATH, pythonImports: j(e.PYINFO, null), onnxSHA: j(e.ONNXRES, {}).sha || {},
      inputs: j(fs.readFileSync(process.argv[1] + "/inputs.json", "utf8"), {}).listed || {},
      tools: e.TOOLRES ? e.TOOLRES.split(" ") : [], heapMB: Number(e.HEAP), workers: Number(e.WORKERS), cwd: e.CWD,
      unit: j(e.UNITJSON, []), launchdLabel: e.LABEL, startedAt: e.STARTED, endedAt: e.ENDED, reason: e.REASON || null,
      srcFreeze: "src-" + e.FREEZE, srcCommit: e.SRCCOMMIT, deadlineAheadMin: e.AHEAD === "null" ? null : Number(e.AHEAD),
      resolve: j(e.RESOLVEINFO, null), onnxSHA: j(e.ONNXRES, {}).sha || {} };
    fs.writeFileSync(process.argv[2] + ".tmp", JSON.stringify(o, null, 1) + "\n"); fs.renameSync(process.argv[2] + ".tmp", process.argv[2]);' \
    $WORK $SMOKE 2>>$WORK/checks.log
  [ -f $SMOKE ] || echo "{\"stage\":\"$STAGE\",\"rc\":${RC:-1},\"reason\":\"smoke.json writer failed\"}" > $SMOKE
  log "SMOKE $STAGE rc=$RC rss=$RSSMB s=$SECS${REASON:+ ($REASON)}"
  exit 0 ;;
# ------------------------------------------------------------------ gate (memory rule)
gate)
  W=${3:-}; PEAK=${4:-$(registered_peak_mb $STAGE)}
  [ -f $SMOKE ] || { echo "no smoke.json (smoke not run under launchd)"; exit 1; }
  out=$(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const w = Number(process.argv[2] || s.workers || 1), avail = Number(process.argv[3]) * 1048576;
    const reg = Number(process.argv[4] || 0) * 1048576;
    if (s.rc !== 0) { console.log("smoke rc=" + s.rc + (s.reason ? " " + s.reason : "")); process.exit(1); }
    const peak = Math.max(s.peakRSS || 0, reg);
    const need = peak * w + 4 * 1073741824;
    const txt = `max(smoke ${Math.round((s.peakRSS || 0) / 1048576)}, registered ${Math.round(reg / 1048576)}) MB x ${w} + 4096 MB = ${Math.round(need / 1048576)} MB vs free+inactive ${Math.round(avail / 1048576)} MB`;
    if (!(need < avail)) { console.log("memory rule fails: " + txt); process.exit(1); }
    console.log("ok " + txt);' $SMOKE "$W" $(free_inactive_mib) "$PEAK")
  rc=$?; echo "$out"; exit $rc ;;
*) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
