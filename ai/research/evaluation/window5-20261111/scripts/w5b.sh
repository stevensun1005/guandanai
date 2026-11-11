#!/bin/zsh
# Window-5 W5-0b (PLAN section 4): 017 above-40 MSE and round-cluster SD on 20 window-4 C1 blocks
# (seed 20261114) and the scorer's rows/s -> L1/baseline-c1.json + addendum NOTE. Descriptive
# registration of L1-mse's detectable delta and cost before L1 has data (F8c, C8). 1 core (CPU,
# one thread), alongside V2a.
#   w5b.sh --smoke                                 2 blocks
#   w5b.sh --run --deadline=<ISO> [--workers=1]    20 blocks
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
MODE= DL=
for a in "$@"; do case $a in --smoke) MODE=smoke ;; --run) MODE=run ;; --deadline=*) DL=${a#*=} ;; esac; done
cd $SRC || { echo "frozen checkout $SRC missing" >&2; exit 3; }
[ "$(sha $M017)" = $M017SHA ] || { echo "017 sha mismatch" >&2; exit 3; }
C1=$R4/C1/corpus
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
if [ "$MODE" = smoke ]; then
  U=$R/W5-0b/smoke-work/unit-$$; mkdir -p $U
  exec nice -n 10 $PY -u $R/scripts/w5b.py --src=$SRC --c1=$C1 --champion=$M017 --out=$U/baseline.json --blocks=2
fi
[ "$MODE" = run ] || { echo "usage: w5b.sh --smoke | --run --deadline=<ISO>" >&2; exit 2; }
mkdir -p $R/L1
nice -n 10 $PY -u $R/scripts/w5b.py --src=$SRC --c1=$C1 --champion=$M017 --out=$R/L1/baseline-c1.json --blocks=20 > $R/W5-0b/w5b.out 2>&1
rc=$?
SUM=$(tail -1 $R/W5-0b/w5b.out | cut -c1-400)
[ $rc = 0 ] && echo "$(date -u +%FT%TZ) NOTE W5-0b baseline-c1.json sha256=$(sha $R/L1/baseline-c1.json) $SUM" >> $ADDENDUM
log "NOTE W5-0b rc=$rc $SUM; L1/baseline-c1.json sha256 $(sha $R/L1/baseline-c1.json) (descriptive registration)"
exit $rc
