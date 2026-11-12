/**
 * Small cross-platform helpers so the endgame tools run on the Mac and on Windows.
 *
 * - `isMain(import.meta.url)`: true when the module is the entry script. Comparing with
 *   `file://${process.argv[1]}` never matches on Windows (`C:\...` vs `file:///C:/...`).
 * - `spawnNice(nice, command, args, options)`: lower a child's CPU priority. Unix uses `nice -n`
 *   exactly as before; Windows has no `nice`, so the child is started directly and its priority
 *   class is set with os.setPriority (nice <= 0 normal, 1-9 below normal, >= 10 low).
 */
import { spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { pathToFileURL } from 'node:url';

export const isMain = (url) =>
  Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;

export function windowsPriority(nice) {
  const { priority } = constants;
  if (nice <= 0) return priority.PRIORITY_NORMAL;
  return nice < 10 ? priority.PRIORITY_BELOW_NORMAL : priority.PRIORITY_LOW;
}

export function spawnNice(nice, command, args, options = {}, platform = process.platform) {
  if (platform !== 'win32') return spawn('nice', ['-n', String(nice), command, ...args], options);
  const child = spawn(command, args, { windowsHide: true, ...options });
  if (child.pid && nice > 0) {
    try {
      setPriority(child.pid, windowsPriority(nice));
    } catch (error) {
      console.error(`priority warning for ${command}: ${error.message}`);
    }
  }
  return child;
}
