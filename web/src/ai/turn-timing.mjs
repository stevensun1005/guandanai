/**
 * Owner rule 2026-11-09 (verbatim): "机器人和真人一样是最多60s出牌时间 推理时间最多50s 留出来10s为了万一没推理出来回退出牌用
 * 上一手没成功下一手依然会推理 不会一次回退后面一直回退".
 *
 * For every computer seat, measured from the moment its turn starts on the host (the 0.5-1 s
 * thinking pause and any first-load wait included):
 *   - reasoning (danMCai-reason search, Clint's 残局大脑) stops by REASON_MS (50 s);
 *   - a worker still busy at HARD_MS (52 s) is replaced;
 *   - the fallback move (champion 017, or Clint's rules-only move) is played well before TURN_MS;
 *   - nothing is sticky: the next move reasons again normally after any fallback.
 */
export const TURN_MS = 60_000;
export const REASON_MS = 50_000;
export const HARD_MS = 52_000;
/** Upstream Clint BRAIN.ms: one 残局大脑 decision searches at most 30 s (and never past REASON_MS). */
export const CLINT_BRAIN_MS = 30_000;
/** Longest wait for Clint's rules-only move after a brain overrun or a replaced rule worker. */
export const RULES_ONLY_TIMEOUT_MS = 5_000;

/** Milliseconds of reasoning left for a turn that started at `startedAt` (same clock as `now`). */
export const reasonLeft = (startedAt, now) => startedAt + REASON_MS - now;
/** Milliseconds until the hard limit (worker replacement) of that turn. */
export const hardLeft = (startedAt, now) => startedAt + HARD_MS - now;

/** Clint's brain budget for a request posted `elapsed` ms after its turn started (0 = rules only). */
export const clintBrainMs = (elapsed) =>
  Math.max(0, Math.min(CLINT_BRAIN_MS, REASON_MS - Math.max(0, elapsed)));
