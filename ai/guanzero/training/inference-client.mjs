import { createConnection } from 'node:net';
import { encode, cardsArray } from '../../../web/src/ai/encoding.mjs';
import { history } from './history.mjs';
export function requestFrame(version, state) {
  const count = state.actions.length;
  if (
    !Number.isInteger(version) ||
    version < 0 ||
    version > 0xffffffff ||
    count < 1 ||
    count > 16384
  )
    throw Error('Invalid inference request');
  const frame = Buffer.alloc(4 + 8 + 1593 + 54 * count);
  frame.writeUInt32LE(frame.length - 4);
  frame.writeUInt32LE(version, 4);
  frame.writeUInt32LE(count, 8);
  let at = 12;
  for (const part of [encode(state), history(state), ...state.actions.map(cardsArray)])
    for (const v of part) frame.writeInt8(v, at++);
  return frame;
}
export function createInferenceClient(port, { timeoutMs = 20000 } = {}) {
  let socket = null,
    buffer = Buffer.alloc(0),
    pending = null,
    tail = Promise.resolve();
  function fail(error) {
    if (pending) {
      const active = pending;
      pending = null;
      clearTimeout(active.timer);
      active.reject(error);
    }
    if (socket) {
      const old = socket;
      socket = null;
      old.destroy();
    }
    buffer = Buffer.alloc(0);
  }
  async function connect() {
    if (socket && !socket.destroyed) return;
    await new Promise((resolve, reject) => {
      const current = createConnection({ host: '127.0.0.1', port });
      socket = current;
      current.setNoDelay(true);
      current.once('connect', resolve);
      current.once('error', reject);
      current.on('error', fail);
      current.on('close', () => {
        if (socket === current) fail(Error('GPU inference connection closed'));
      });
      current.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE(0);
        if (length < 4 || length > 1048576) {
          fail(Error('Invalid GPU response frame'));
          return;
        }
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const active = pending;
        if (!active) return;
        pending = null;
        clearTimeout(active.timer);
        if (body.readUInt32LE(0) !== 0) {
          active.reject(Error(body.subarray(4).toString('utf8')));
          return;
        }
        if ((body.length - 4) / 4 !== active.count) {
          active.reject(Error('GPU response length mismatch'));
          return;
        }
        const values = new Float32Array(active.count);
        for (let i = 0; i < values.length; i++) values[i] = body.readFloatLE(4 + i * 4);
        if (!values.every(Number.isFinite)) {
          active.reject(Error('Non-finite GPU response'));
          return;
        }
        active.resolve(values);
      });
    });
  }
  return {
    values(version, state) {
      const result = tail.then(async () => {
        const frame = requestFrame(version, state);
        await connect();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => fail(Error('GPU inference timeout')), timeoutMs);
          pending = { resolve, reject, timer, count: state.actions.length };
          if (!socket || socket.destroyed) {
            fail(Error('GPU inference socket unavailable'));
            return;
          }
          socket.write(frame);
        });
      });
      tail = result.catch(() => {});
      return result;
    },
    close() {
      fail(Error('GPU inference client closed'));
    },
  };
}
