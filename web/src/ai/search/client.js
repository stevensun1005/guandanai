/**
 * Main-thread client of the search worker. It never throws to the table: every failure, timeout
 * or budget overrun resolves to {fallback: true, reason} and the caller plays champion 017's move.
 * Stats (kept in memory only) are exposed for ?test=1 runs as TableBot.searchStats; move-coach
 * requests are counted separately under `stats.coach`.
 *
 * One worker serves both the table bots and the human player's move coach (one copy of the
 * networks, roughly 200 MB of WASM heap). The client posts one job at a time, table jobs first:
 *   - a coach job waits while a table job runs or is queued;
 *   - a table request while a coach job runs asks the coach job to stop ('cancel', honoured
 *     within about 50 ms between inferences or between endgame worlds); if it has not stopped
 *     after PREEMPT_MS the worker is replaced and the networks reload before the table job.
 * A table job's budget and hard timeout are measured from the start of the seat's turn (owner rule
 * 2026-11-09, ../turn-timing.mjs): the search stops at the 50 s mark (`remainingMs` is the time
 * left when the job is posted; the first-load wait and any wait behind a coach job count), and a
 * job not answered by 52 s is dropped (replacing the worker if it is running), so the champion
 * move is played well before 60 s. Table searches never yield or cancel; a coach job past its hard
 * timeout (52 s from its post) replaces the worker without failing queued table jobs.
 * Nothing is sticky: after any fallback, timeout, worker error or replacement, or failed load, the
 * next decision loads (if needed) and searches again. A worker replacement does drop the table
 * solver's transposition table (exact values unchanged; only worlds right at the node limit can
 * be solved differently), and the table job waits for the reload.
 *   - a new coach request (the player's next turn) drops queued coach jobs and asks a running
 *     one to stop: with 50 s budgets an old turn's coach search must not delay the newest turn.
 */
import { FIRST_LOAD_WAIT_MS, SEARCH_BUDGETS, hardTimeoutMs } from './constants.mjs';
import { REASON_MS, TURN_MS } from '../turn-timing.mjs';

const PREEMPT_MS = 500;

/** 'mobile' for phones, tablets and small devices; 'desktop' otherwise. */
export function deviceClass(nav = globalThis.navigator) {
  if (!nav) return 'desktop';
  if (nav.userAgentData?.mobile) return 'mobile';
  if (/Mobi|iPhone|iPad|iPod|Android/i.test(nav.userAgent || '')) return 'mobile';
  if (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1) return 'mobile'; // iPadOS
  if (Number.isFinite(nav.hardwareConcurrency) && nav.hardwareConcurrency <= 4) return 'mobile';
  if (Number.isFinite(nav.deviceMemory) && nav.deviceMemory <= 4) return 'mobile';
  return 'desktop';
}

export function createSearchClient({
  version,
  device = deviceClass(),
  spawn,
  now = () => performance.now(),
} = {}) {
  const budget = SEARCH_BUDGETS[device];
  const reasonMs = Math.min(REASON_MS, Math.max(budget.midgameMs, budget.endgameMs));
  let worker = null,
    requestId = 0,
    initialized = null,
    loadedBot = null,
    active = null,
    preemptTimer = null;
  const queue = [];
  const stats = {
    device,
    budget,
    firstLoadWaitMs: FIRST_LOAD_WAIT_MS,
    hardTimeoutMs: hardTimeoutMs(budget),
    requests: 0,
    searched: 0,
    differs: 0,
    fallbacks: {},
    ms: [],
    coach: { requests: 0, searched: 0, fallbacks: {}, ms: [], preempted: 0 },
  };
  const create =
    spawn ||
    (() => {
      const url = new URL('./assets/search-worker.mjs', document.baseURI);
      url.searchParams.set('v', version);
      return new Worker(url, { type: 'module' });
    });

  function kill() {
    clearTimeout(preemptTimer);
    preemptTimer = null;
    worker?.terminate();
    worker = null;
    initialized = null;
  }
  /** Timeout or worker error: every job fails (the table plays the champion). */
  function stop(reason) {
    kill();
    const jobs = [active, ...queue.splice(0)].filter(Boolean);
    active = null;
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.reject(new Error(reason));
    }
  }
  /** Replace the worker under a coach job that will not stop; the queue continues after a reload. */
  function abandon(job, reason) {
    if (active !== job) return;
    kill();
    active = null;
    clearTimeout(job.timer);
    job.reject(new Error(reason));
    if (queue.length && loadedBot) void init(loadedBot).catch(() => {});
    pump();
  }
  function ensureWorker() {
    if (worker) return;
    worker = create();
    worker.onmessage = ({ data }) => {
      const job = active;
      if (!job || data.id !== job.id) return;
      clearTimeout(job.timer);
      clearTimeout(preemptTimer);
      preemptTimer = null;
      active = null;
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
      pump();
    };
    worker.onerror = () => stop('search-worker-error');
  }
  function pump() {
    if (active || !queue.length) return;
    let index = queue.findIndex((job) => job.owner !== 'coach');
    if (index < 0) index = 0;
    const [job] = queue.splice(index, 1);
    if (job.deadline !== undefined) {
      // a table search: only the time left to the turn's 50 s mark
      const remainingMs = job.deadline - now();
      if (remainingMs <= 0) {
        clearTimeout(job.timer);
        job.reject(new Error('search-budget'));
        pump();
        return;
      }
      job.message = { ...job.message, remainingMs };
    }
    ensureWorker();
    active = job;
    job.id = ++requestId;
    // a coach job past its hard timeout is replaced alone: queued table jobs must not fail with it
    if (job.timeout !== undefined)
      job.timer = setTimeout(
        () => (job.owner === 'coach' ? abandon(job, 'search-timeout') : stop('search-timeout')),
        job.timeout,
      );
    worker.postMessage({ id: job.id, ...job.message });
  }
  function call(message, timeout, owner = 'table', front = false) {
    return new Promise((resolve, reject) => {
      const job = { message, timeout, owner, resolve, reject };
      if (front) queue.unshift(job);
      else queue.push(job);
      pump();
    });
  }
  /**
   * A table search measured from its turn start: it searches until `deadline` (the 50 s mark)
   * and is dropped at `expires` (52 s) wherever it is, waiting in the queue or running.
   */
  function tableCall(message, deadline, expires) {
    return new Promise((resolve, reject) => {
      const job = { message, owner: 'table', deadline, resolve, reject };
      job.timer = setTimeout(
        () => {
          if (active === job) return stop('search-timeout');
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          reject(new Error('search-timeout'));
        },
        Math.max(0, expires - now()),
      );
      queue.push(job);
      pump();
    });
  }
  /** Load the networks; a failed load is retried by the next request (never sticky). */
  function init(bot) {
    if (!initialized) {
      loadedBot = bot;
      initialized = call({ type: 'init', bot, budget }, 60000, 'init', true).catch((error) => {
        initialized = null;
        throw error;
      });
    }
    return initialized;
  }
  /** The table needs the worker: drop queued coach jobs and stop a running one. */
  function yieldToTable() {
    for (let i = queue.length - 1; i >= 0; i--)
      if (queue[i].owner === 'coach') queue.splice(i, 1)[0].reject(new Error('search-preempted'));
    if (active?.owner !== 'coach' || preemptTimer) return;
    const job = active;
    if (!job.cancelled) worker.postMessage({ type: 'cancel', id: job.id });
    job.cancelled = true;
    stats.coach.preempted++;
    // still running after PREEMPT_MS (one long exact-solver call): replace the worker
    preemptTimer = setTimeout(() => abandon(job, 'search-preempted'), PREEMPT_MS);
  }
  /** Ask a running coach job to stop at its next check; it then replies 'cancelled'. */
  function cancelActiveCoach() {
    if (active?.owner !== 'coach' || active.cancelled) return;
    active.cancelled = true;
    worker.postMessage({ type: 'cancel', id: active.id });
  }
  /**
   * Wait at most FIRST_LOAD_WAIT_MS (and never past `limit` ms) for the networks; they keep
   * loading in the background.
   */
  async function ready(bot, limit = Infinity) {
    const loading = init(bot);
    loading.catch(() => {});
    let timer;
    await Promise.race([
      loading,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('search-loading')),
          Math.max(0, Math.min(FIRST_LOAD_WAIT_MS, limit)),
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
  const reasonOf = (error) =>
    /timeout/.test(error.message)
      ? 'timeout'
      : error.message === 'search-loading'
        ? 'loading'
        : error.message === 'search-budget'
          ? 'budget'
          : error.message === 'search-preempted'
            ? 'preempted'
            : 'error';
  function fallback(reason, extra = {}, bucket = stats) {
    bucket.fallbacks[reason] = (bucket.fallbacks[reason] || 0) + 1;
    return { fallback: true, reason, ...extra };
  }

  return {
    stats,
    /** Load the networks ahead of the first decision; failures are retried later. */
    warm(bot) {
      void init(bot).catch(() => {});
    },
    /**
     * One table decision. `startedAt` (same clock as `now`) is when the seat's turn started on
     * the host; the search ends by startedAt + 50 s and the reply is given up at startedAt + 52 s.
     */
    async decide(bot, payload, { startedAt = now(), turnMs = TURN_MS } = {}) {
      stats.requests++;
      yieldToTable();
      const deadline = startedAt + Math.min(reasonMs, Math.max(0, turnMs - 10000)),
        expires = startedAt + Math.min(hardTimeoutMs(budget), Math.max(0, turnMs - 8000));
      let result;
      try {
        // A table never waits for a slow first load longer than FIRST_LOAD_WAIT_MS (10 s, not
        // the 50 s search budget): the networks keep loading and this decision plays 017.
        await ready(bot, deadline - now());
        result = await tableCall({ type: 'search', payload }, deadline, expires);
      } catch (error) {
        return fallback(reasonOf(error), { message: error.message });
      }
      if (!result?.ok) return fallback(result?.reason || 'error', result || {});
      stats.searched++;
      if (result.index !== result.championIndex) stats.differs++;
      stats.ms.push(Math.round(result.ms));
      if (stats.ms.length > 500) stats.ms.shift();
      return result;
    },
    /**
     * Move-coach values for the human player's own turn (same worlds, settings and budgets as
     * the table bot). Resolves to {ok, kind, plays, base, values, ...} or {fallback, reason}.
     */
    async evaluate(bot, payload, { turnMs = TURN_MS } = {}) {
      const bucket = stats.coach;
      bucket.requests++;
      // only the newest turn: drop queued coach jobs and stop a running one
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].owner === 'coach') queue.splice(i, 1)[0].reject(new Error('search-preempted'));
      cancelActiveCoach();
      let result;
      try {
        const cap = Math.min(reasonMs, Math.max(0, turnMs - 10000));
        await ready(bot);
        result = await call(
          { type: 'coach', payload, remainingMs: cap },
          Math.min(hardTimeoutMs(budget), Math.max(0, turnMs - 8000)),
          'coach',
        );
      } catch (error) {
        return fallback(reasonOf(error), { message: error.message }, bucket);
      }
      if (!result?.ok) return fallback(result?.reason || 'error', {}, bucket);
      bucket.searched++;
      bucket.ms.push(Math.round(result.ms));
      if (bucket.ms.length > 200) bucket.ms.shift();
      return result;
    },
    /** The coach was switched off: stop its work without disturbing table jobs. */
    cancelCoach() {
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].owner === 'coach') queue.splice(i, 1)[0].reject(new Error('search-cancelled'));
      cancelActiveCoach();
    },
  };
}

let shared = null;
/** The page's one search client, shared by the table bots and the move coach. */
export function sharedSearchClient(version) {
  shared ||= createSearchClient({ version });
  return shared;
}
