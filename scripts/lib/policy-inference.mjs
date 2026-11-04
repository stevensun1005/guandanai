import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function createPolicyInference({
  python = 'python',
  script = fileURLToPath(new URL('../eval_inference.py', import.meta.url)),
} = {}) {
  const child = spawn(python, ['-u', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const pending = [];
  let ended = false;
  const rejectAll = (error) => {
    ended = true;
    for (const waiter of pending.splice(0)) waiter.reject(error);
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    const waiter = pending.shift();
    if (!waiter) return;
    try {
      const result = JSON.parse(line);
      if (result.error) waiter.reject(Error(result.error));
      else waiter.resolve(result);
    } catch (error) {
      waiter.reject(error);
    }
  });
  child.on('error', rejectAll);
  child.on('exit', (code) => rejectAll(Error(`Inference process exited ${code}`)));
  const request = (state) =>
    new Promise((resolve, reject) => {
      if (ended) {
        reject(Error('Inference process is closed'));
        return;
      }
      pending.push({ resolve, reject });
      child.stdin.write(JSON.stringify(state) + '\n');
    });
  return {
    request,
    infer: async (state) => (await request(state)).values,
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
