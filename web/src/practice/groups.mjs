/** Manual exercise partitions physical cards; it never scores neural actions or trains a model. */
const key = (ids) =>
  ids
    .slice()
    .sort((a, b) => a - b)
    .join('.');
function checkPartition(groups, hand) {
  if (!Array.isArray(groups) || groups.some((g) => !Array.isArray(g) || !g.length))
    throw Error('Invalid groups');
  const cards = groups.flat();
  if (
    cards.length !== hand.length ||
    new Set(cards).size !== cards.length ||
    key(cards) !== key(hand)
  )
    throw Error('Arrangement must retain every physical card exactly once');
}

export function editGroups(groups, selected, { mode, to, auto, tidy, order }) {
  const hand = groups.flat(),
    ids = [...new Set(selected)],
    held = new Set(hand);
  checkPartition(groups, hand);
  if (!['group', 'split', 'join'].includes(mode) || ids.some((id) => !held.has(id)))
    throw Error('Invalid edit');
  if (mode === 'join' && (!Number.isInteger(to) || to < 0 || to >= groups.length))
    throw Error('Invalid destination');
  if (!ids.length || (mode === 'group' && ids.length < 2)) return groups.map((g) => g.slice());
  const gone = new Set(ids),
    keep = [],
    left = [];
  let base = [];
  groups.forEach((group, index) => {
    if (mode === 'join' && index === to) base = group.filter((id) => !gone.has(id));
    else if (group.some((id) => gone.has(id))) left.push(...group.filter((id) => !gone.has(id)));
    else keep.push(group.slice());
  });
  const made =
    mode === 'split' ? ids.map((id) => [id]) : [tidy(mode === 'join' ? base.concat(ids) : ids)];
  const result = order(keep.concat(auto(left), made));
  checkPartition(result, hand);
  return result;
}

export function readArrangementRecord(record) {
  if (
    !record ||
    ![undefined, 1].includes(record.schema) ||
    ![undefined, 'arrangement-practice'].includes(record.kind) ||
    !Number.isInteger(record.L) ||
    record.L < 2 ||
    record.L > 14 ||
    !Number.isInteger(record.seat) ||
    record.seat < 1 ||
    record.seat > 4 ||
    !Number.isInteger(record.deal) ||
    record.deal < 1 ||
    typeof record.uid !== 'string' ||
    record.uid.length > 80 ||
    !Array.isArray(record.hand) ||
    record.hand.length !== 27 ||
    record.hand.some((id) => !Number.isInteger(id) || id < 0 || id >= 108) ||
    ![record.compPower, record.minePower].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)
  )
    throw Error('Invalid arrangement record');
  checkPartition(record.comp, record.hand);
  checkPartition(record.mine, record.hand);
  const comp = record.comp.map((g) => g.slice()),
    mine = record.mine.map((g) => g.slice());
  const ck = new Set(comp.map(key)),
    mk = new Set(mine.map(key));
  const only = {
    comp: comp.filter((g) => !mk.has(key(g))),
    mine: mine.filter((g) => !ck.has(key(g))),
  };
  return {
    schema: 1,
    kind: 'arrangement-practice',
    source: 'unverified_browser',
    assisted: true,
    scoreKind: 'grouping-reference-not-network-probability',
    appVersion: typeof record.appVersion === 'string' ? record.appVersion.slice(0, 80) : undefined,
    uid: record.uid,
    at: typeof record.at === 'string' ? record.at.slice(0, 80) : '',
    deal: record.deal,
    L: record.L,
    seat: record.seat,
    hand: record.hand.slice(),
    comp,
    mine,
    compPower: record.compPower,
    minePower: record.minePower,
    same: !only.comp.length && !only.mine.length,
    only,
  };
}
