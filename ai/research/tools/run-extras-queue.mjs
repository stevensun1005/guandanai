/** Sequential preregistered arms; the next arm starts without waiting for a heartbeat. */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem } from 'node:os';
import { option, readJSON, sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';
import { trainControlled } from './run-controlled-training.mjs';

export async function runQueue(file) {
  const plan = readJSON(file),
    campaign = plan.campaign;
  const lock = join(campaign, 'extras-queue.lock');
  closeSync(openSync(lock, 'wx'));
  const stateFile = join(campaign, 'extras-queue-status.json');
  const previous = readJSON(stateFile, { completed: [] });
  const state = {
    ...previous,
    pid: process.pid,
    phase: 'running',
    updatedAtUTC: new Date().toISOString(),
  };
  const save = () => writeJSON(stateFile, { ...state, updatedAtUTC: new Date().toISOString() });
  const stopped = () =>
    existsSync(join(campaign, 'STOP')) || Date.now() >= Date.parse(plan.computeDeadlineUTC);
  try {
    for (const arm of plan.arms) {
      if (state.completed.includes(arm.id)) continue;
      if (stopped()) break;
      while (freemem() < 5 * 1024 ** 3 && !stopped()) {
        state.phase = 'memory-paused';
        save();
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (stopped()) break;
      const protocol = join(arm.run, 'protocol.json');
      if (sha256(protocol) !== arm.protocolSHA256) throw Error('Queue protocol changed');
      const old = readJSON(join(arm.run, 'status.json'));
      if (old?.stoppedAt) throw Error('Stopped arm requires an explicit audit; will not retrain');
      const registration = spawnSync(
        process.execPath,
        [
          join(plan.sourceRoot, 'ai/research/tools/research-deadline.mjs'),
          `--campaign=${campaign}`,
          `--register=${arm.run}`,
          `--protocol=${protocol}`,
          '--hours=4',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      if (registration.status !== 0) throw Error(registration.stderr || 'Registration failed');
      state.phase = 'training';
      state.currentTask = arm.id;
      save();
      writeJSON(join(campaign, 'progress.json'), {
        phase: 'training',
        displayName: `danMCai · ${arm.id}`,
        currentTask: arm.id,
        analysis:
          '新授权：同一起点017零投影学生，公开extras与置零输入对照；单局最终升级分损失，新Adam/空回放。',
        nextTask: '本臂结束审计后立即启动队列下一臂；末臂结束前准备独立留出和后续自主训练。',
        deadlineUTC: plan.deadlineUTC,
        computeDeadlineUTC: plan.computeDeadlineUTC,
        updatedAtUTC: new Date().toISOString(),
      });
      await trainControlled(arm.run);
      const audit = spawnSync(
        plan.python,
        [
          '-B',
          join(plan.sourceRoot, 'ai/research/tools/audit-research-stop.py'),
          '--run',
          arm.run,
          '--frozen-source',
          plan.sourceRoot,
          '--output',
          join(campaign, `${arm.id}-stop-audit.json`),
        ],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } },
      );
      if (audit.status !== 0)
        throw Error(audit.stderr || audit.stdout || 'Final network/Adam audit failed');
      state.completed.push(arm.id);
      save();
    }
    state.phase = stopped() ? 'stopped' : 'training-arms-complete';
    save();
  } catch (error) {
    state.phase = 'failed';
    state.error = String(error.stack || error);
    save();
    throw error;
  } finally {
    unlinkSync(lock);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await runQueue(resolve(option('plan', '')));
