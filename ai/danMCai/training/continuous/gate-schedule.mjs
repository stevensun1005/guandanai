/** Candidate scheduling only; match rules, SPRT and the training opponent pool are unchanged. */
export function validateGateSchedule(policy) {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    throw Error('Invalid gateSchedule');
  const { mode, minNewStep, activatedAt, historicalChampions, historyIntervalHours, ...rest } =
    policy;
  if (
    Object.keys(rest).length ||
    mode !== 'new-first-v1' ||
    !Number.isSafeInteger(minNewStep) ||
    minNewStep < 1 ||
    typeof activatedAt !== 'string' ||
    !Number.isFinite(Date.parse(activatedAt)) ||
    !Number.isInteger(historicalChampions) ||
    historicalChampions < 0 ||
    historicalChampions > 2 ||
    !Number.isFinite(historyIntervalHours) ||
    historyIntervalHours < 1
  )
    throw Error('Invalid gateSchedule');
}

export function selectGateCandidate({
  members,
  champion,
  gates,
  policy,
  lastHistoricalGateAt,
  now,
}) {
  validateGateSchedule(policy);
  const gated = new Set(gates.map((gate) => gate.challenger));
  if (policy === undefined) {
    const member = [...members]
      .reverse()
      .find((m) => !m.pinned && !gated.has(m.id) && m.id !== champion.version);
    return member ? { member, category: 'legacy' } : null;
  }
  // Only the newest eligible snapshot gets a turn. Superseded snapshots do not form a backlog.
  const newest = members
    .filter((m) => m.step >= policy.minNewStep)
    .sort((a, b) => b.step - a.step)[0];
  if (newest && !newest.pinned && newest.id !== champion.version && !gated.has(newest.id))
    return { member: newest, category: 'new' };

  const lastHistory = lastHistoricalGateAt ?? Date.parse(policy.activatedAt);
  if (now - lastHistory < policy.historyIntervalHours * 3_600_000) return null;
  const history = [
    ...new Set(
      [...(champion.history || [])]
        .reverse()
        .filter((entry) => entry.gate !== undefined && entry.version !== champion.version)
        .map((entry) => entry.version),
    ),
  ].slice(0, policy.historicalChampions);
  for (const id of history) {
    const completed = gates.some(
      (gate) =>
        gate.challenger === id &&
        gate.champion === champion.version &&
        gate.code === 0 &&
        ['accept', 'reject', 'inconclusive'].includes(gate.decision),
    );
    const member = members.find((m) => m.id === id);
    if (member && !completed) return { member, category: 'historical-champion' };
  }
  return null;
}
