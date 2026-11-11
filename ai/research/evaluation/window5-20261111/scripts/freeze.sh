#!/bin/zsh
# Window-5 source freeze helper (PLAN section 8: src-e at 23:35, src-e2 at 01:45 Toronto). Interactive
# (git cannot reach the ~/Desktop repository under launchd).
#   freeze.sh e|e2 <commit> [--dry-run]
# 1. RT/src-<e|e2> = detached worktree of the repository at <commit> (must contain the window-5 plan
#    commit 409df69); an existing one must already be at <commit>;
# 2. src-<x>/node_modules -> the Desktop checkout's node_modules (as window 4's src-d; packages only);
# 3. RT/src-<x>.commit = the full commit (read by common.sh src_commit under launchd);
# 4. stages.log NOTE + addendum NOTE (src-e2: its commit is registered here, review C2-style).
source /Users/stevensun/guandan-runtime.noindex/window5-20261111/scripts/common.sh
X=${1:?usage: freeze.sh e|e2 <commit> [--dry-run]}; C=${2:?commit}; DRY=0; [ "$3" = --dry-run ] && DRY=1
[[ $X == e || $X == e2 ]] || { echo "e or e2" >&2; exit 2; }
REPO=/Users/stevensun/Desktop/guandanai
D=$R/src-$X
FULL=$(git -C $REPO rev-parse --verify "$C^{commit}") || { echo "unknown commit $C" >&2; exit 2; }
git -C $REPO merge-base --is-ancestor 409df69 $FULL || { echo "$C does not contain the window-5 plan commit 409df69" >&2; exit 2; }
if [ $DRY = 1 ]; then echo "would freeze $D at $FULL, link node_modules, write $D.commit"; exit 0; fi
if [ -d $D ]; then
  [ "$(git -C $D rev-parse HEAD)" = "$FULL" ] || { echo "$D exists at another commit" >&2; exit 2; }
else
  git -C $REPO worktree add --detach $D $FULL || exit 1
fi
[ -e $D/node_modules ] || ln -s $REPO/node_modules $D/node_modules
echo $FULL > $D.commit
log "NOTE src-$X frozen at $FULL ($(git -C $D log -1 --format=%s | cut -c1-100)); node_modules -> Desktop checkout (packages only); RT/src-$X.commit written"
echo "$(date -u +%FT%TZ) NOTE src-$X frozen commit=$FULL" >> $ADDENDUM
echo "src-$X = $FULL"
