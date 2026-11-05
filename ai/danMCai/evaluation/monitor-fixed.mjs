/** Live evaluation counts and desktop observations; never edits training config or weights. */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { freemem, platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, writeJSON } from '../training/continuous/lib.mjs';

export const evaluationPhase = (workers) =>
  !workers.length
    ? 'failed'
    : workers.every((w) => w.phase === 'complete')
      ? 'complete'
      : workers.some((w) => w.phase === 'failed' || (w.phase !== 'complete' && !w.alive))
        ? 'failed'
        : 'running';
export const evaluationElapsed = (startedAt, workers, phase, now = Date.now()) =>
  ((phase === 'complete' ? Math.max(...workers.map((w) => Date.parse(w.updatedAtUTC))) : now) -
    Date.parse(startedAt)) /
  1000;

export function monitorFixed(folder, workspace, until = 0) {
  const launch = JSON.parse(readFileSync(resolve(folder, 'launcher.json'), 'utf8'));
  const frozen = JSON.parse(readFileSync(resolve(folder, 'frozen.json'), 'utf8'));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let desktop = { tcpBound: null, cpuLoad: null, checkedAtUTC: null },
    probing = false;
  function health() {
    if (probing || platform() !== 'win32') return;
    probing = true;
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '$n=@(Get-NetTCPConnection -State Bound -ErrorAction SilentlyContinue).Count; $c=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; @{tcpBound=$n;cpuLoad=$c;checkedAtUTC=[datetimeoffset]::UtcNow.ToString("o")} | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 20000 },
      (error, stdout) => {
        probing = false;
        if (!error)
          try {
            desktop = JSON.parse(stdout);
            desktop.checkedAtUTC = new Date(desktop.checkedAtUTC).toISOString();
          } catch {}
      },
    );
  }
  function snapshot() {
    const workers = launch.jobs.map((job) => {
      let status = {};
      try {
        status = JSON.parse(readFileSync(resolve(job.run, `worker-${job.shard}.json`), 'utf8'));
      } catch {}
      return { ...job, ...status, alive: alive(job.pid) };
    });
    const phase = evaluationPhase(workers);
    const groups = ['clint-rule', 'latest-model'].map((name) => {
      const jobs = workers.filter((w) => w.group === name);
      return {
        name,
        opponent: name === 'clint-rule' ? 'Clint rules-v2' : frozen.latest.version,
        completedMatches: jobs.reduce((n, w) => n + (w.completedMatches || 0), 0),
        plannedMatches: jobs.reduce((n, w) => n + w.plannedMatches, 0),
        phases: jobs.map((w) => w.phase || 'starting'),
      };
    });
    const networkAlert = desktop.tcpBound !== null && desktop.tcpBound > 12000;
    for (const group of groups) {
      const file = resolve(folder, group.name, 'PAUSE');
      if (networkAlert && group.completedMatches < group.plannedMatches && !existsSync(file))
        writeJSON(file, { owner: 'network-port-guard' });
      else if (!networkAlert && existsSync(file)) {
        try {
          if (JSON.parse(readFileSync(file, 'utf8')).owner === 'network-port-guard')
            unlinkSync(file);
        } catch {}
      }
    }
    const completedMatches = groups.reduce((n, g) => n + g.completedMatches, 0),
      plannedMatches = groups.reduce((n, g) => n + g.plannedMatches, 0);
    const elapsedSeconds = evaluationElapsed(launch.startedAtUTC, workers, phase);
    const result = {
      name: '冠军固定整场双组评测',
      model: frozen.champion.version,
      opponent: `Clint／${frozen.latest.version}（分别评测）`,
      phase,
      completedMatches,
      plannedMatches,
      groups,
      desktop: { ...desktop, freeGiB: freemem() / 1024 ** 3, networkAlert },
      startedAtUTC: launch.startedAtUTC,
      updatedAtUTC: new Date().toISOString(),
      elapsedSeconds,
      estimatedRemainingSeconds: completedMatches
        ? ((plannedMatches - completedMatches) * elapsedSeconds) / completedMatches
        : null,
      workers,
    };
    writeJSON(resolve(workspace, 'ai/danMCai/workspace/evaluations/progress.json'), result);
    writeJSON(resolve(folder, 'progress.json'), result);
    return phase;
  }
  health();
  snapshot();
  const healthTimer = setInterval(health, 30000);
  const timer = setInterval(() => {
    const phase = snapshot();
    if ((until && Date.now() >= until) || (!until && phase !== 'running')) {
      clearInterval(timer);
      clearInterval(healthTimer);
    }
  }, 5000);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  monitorFixed(
    resolve(option('run', '')),
    resolve(option('workspace', '.')),
    Date.parse(option('until', '')) || 0,
  );
