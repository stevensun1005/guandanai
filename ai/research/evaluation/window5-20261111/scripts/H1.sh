#!/bin/zsh
# Window-5 H1 (PLAN section 4, review R7): belief v1 and v2a log loss per unseen copy on the 1,458
# unassisted human positions vs uniform (S7 scorer's belief section via scripts/h1.mjs), descriptive,
# aggregates only. Window 4's H1.sh adapted: it reads ONLY RT/inputs/human-research, the privacy copy
# written by scripts/strip_human.mjs (room, nicknames and seat labels removed, kind=test dropped;
# re-checked with --check=1 before every run). Nothing leaves the machine. Run by queue.sh at V2a END:
#   H1.sh --smoke                                  one scorer run, lane v1 (017 = replay reference);
#                                                  must find exactly 1,458 positions
#   H1.sh --run --deadline=<ISO> --workers=<n>     v1 and v2a (v1 only if no registered v2a export)
# Scorer = src-e ai/danMCai/belief/panel-scorer.mjs (SHA recorded). RT/STOP and RT/H1/STOP honoured
# by the scorer (--stop-file, checked at every position); deadline - 1 min passed as --deadline.
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
SRCD=$SRC
SCORER=$SRCD/ai/danMCai/belief/panel-scorer.mjs
HR=$INPUTS/human-research
RAW=$HR/d1-snapshot-20261108/raw,$HR/d1-snapshot-20261109/raw
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=3072}
NODE=(nice -n 10 node --no-warnings)
MODE= DL= W=1
for a in "$@"; do
  case $a in --smoke) MODE=smoke ;; --run) MODE=run ;; --deadline=*) DL=${a#*=} ;; --workers=*) W=${a#*=} ;; esac
done
cd $SRCD || { echo "frozen checkout $SRCD missing" >&2; exit 3; }
[ -f $SCORER ] || { echo "scorer missing" >&2; exit 3; }
[ "$(sha $M017)" = $M017SHA ] || { echo "017 sha mismatch" >&2; exit 3; }
[ "$(sha $BELIEF)" = $BELIEFSHA ] || { echo "belief v1 sha mismatch" >&2; exit 3; }
$NODE $R/scripts/strip_human.mjs --src=$SRCD --check=1 > /dev/null 2>&1 \
  || { echo "inputs/human-research check failed (strip_human.mjs --check=1)" >&2; exit 3; }

if [ "$MODE" = smoke ]; then
  rm -rf $R/H1/smoke-work/unit-*(N/mm+30); U=$R/H1/smoke-work/unit-$$; mkdir -p $U
  $NODE $R/scripts/h1.mjs --scorer=$SCORER --champion=$M017 --raw=$RAW --manifest=$HR/manifest.json \
    --belief=v1=$BELIEF --out=$U/human-calibration.json --stop-file=$R/STOP,$R/H1/STOP --expect=1458 > $U/h1.out 2>&1 \
    || { echo "h1.mjs failed or did not find 1,458 positions: see H1/smoke-work/unit-<pid>/h1.out"; exit 1; }
  tail -1 $U/h1.out; exit 0
fi
[ "$MODE" = run ] && [ -n "$DL" ] || { echo "usage: H1.sh --smoke | --run --deadline=<ISO> --workers=<n>" >&2; exit 2; }
END=$(zulu $DL)
mkdir -p $R/H1
rm -f $R/H1/human-calibration.json $R/H1/reference-v1.json
B=v1=$BELIEF
V2SHA=$(sha $V2A); PSHA=$(registered_sha v2a)
if [ -n "$V2SHA" ] && [ "$V2SHA" = "$PSHA" ]; then B=$B,v2a=$V2A; NOTE="v1 $BELIEFSHA and v2a $V2SHA"
else NOTE="v1 $BELIEFSHA only: no registered v2a export (file ${V2SHA:-missing}, addendum ${PSHA:-missing})"; fi
log "NOTE H1-score belief log loss on the 1,458 unassisted human positions (inputs/human-research only, manifest $(sha $HR/manifest.json)): $NOTE; scorer $(sha $SCORER); scripts/h1.mjs $(sha $R/scripts/h1.mjs); deadline $(toronto $((END - 60))) Toronto (descriptive)"
$NODE $R/scripts/h1.mjs --scorer=$SCORER --champion=$M017 --raw=$RAW --manifest=$HR/manifest.json --belief=$B \
  --out=$R/H1/human-calibration.json --reference-out=$R/H1/reference-v1.json \
  --deadline=$(iso $((END - 60))) --stop-file=$R/STOP,$R/H1/STOP > $R/H1/h1.out 2>&1
rc=$?
SUM="see H1/h1.out (not copied here: error text may name private files)"; [ $rc = 0 ] && SUM=$(tail -1 $R/H1/h1.out | cut -c1-600)
log "NOTE H1-score rc=$rc $SUM; human-calibration.json sha256 $(sha $R/H1/human-calibration.json) (descriptive; aggregates only; not validated vs humans as opponents or teammates)"
exit $rc
