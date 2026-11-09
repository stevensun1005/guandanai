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
 * A table job's budget and hard timeout start when it is posted, so a coach job never eats
 * into them, and table searches never yield or cancel; a coach job past its hard timeout replaces
 * the worker without failing queued table jobs. A worker replacement does drop the table
 * solver's transposition table (exact values unchanged; only worlds right at the node limit can
 * be solved differently), and the table job waits for the reload.
 *   - a new coach request (the player's next turn) drops queued coach jobs and asks a running
 *     one to stop: with 50 s budgets an old turn's coach search must not delay the newest turn.
 */
import { FIRST_LOAD_WAIT_MS, SEARCH_BUDGETS, hardTimeoutMs } from './constants.mjs';

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

export function createSearchClient({ version, device = deviceClass(), spawn } = {}) {
  const budget = SEARCH_BUDGETS[device];
  let worker = null,
    requestId = 0,
    initialized = null,
    initFailedAt = -Infinity,
    loadedBot = null,
    active = null,
    preemptTimer = null;
  const queue = [];
  const stats = {
    device,
    budget,
    firstLoadWaitMs: FIRST_LOAD_WAIT_MS,
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
    ensureWorker();
    active = job;
    job.id = ++requestId;
    // a coach job past its hard timeout is replaced alone: queued table jobs must not fail with it
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
  function init(bot) {
    if (performance.now() - initFailedAt < 30000) return Promise.reject(Error('search-init-wait'));
    if (!initialized) {
      loadedBot = bot;
      initialized = call({ type: 'init', bot, budget }, 60000, 'init', true).catch((error) => {
        initialized = null;
        // a coach job being replaced is not a load failure
        if (error.message !== 'search-preempted') initFailedAt = performance.now();
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
  /** Wait at most FIRST_LOAD_WAIT_MS for the networks; they keep loading in the background. */
  async function ready(bot) {
    const loading = init(bot);
    loading.catch(() => {});
    let timer;
    await Promise.race([
      loading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('search-loading')), FIRST_LOAD_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  const reasonOf = (error) =>
    /timeout/.test(error.message)
      ? 'timeout'
      : error.message === 'search-loading'
        ? 'loading'
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
    async decide(bot, payload) {
      stats.requests++;
      yieldToTable();
      let result;
      try {
        // A table never waits for a slow first load longer than FIRST_LOAD_WAIT_MS (10 s, not
        // the 50 s search budget): the networks keep loading and this decision plays 017.
        await ready(bot);
        result = await call({ type: 'search', payload }, hardTimeoutMs(budget));
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
    async evaluate(bot, payload) {
      const bucket = stats.coach;
      bucket.requests++;
      // only the newest turn: drop queued coach jobs and stop a running one
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].owner === 'coach') queue.splice(i, 1)[0].reject(new Error('search-preempted'));
      cancelActiveCoach();
      let result;
      try {
        await ready(bot);
        result = await call({ type: 'coach', payload }, hardTimeoutMs(budget), 'coach');
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
