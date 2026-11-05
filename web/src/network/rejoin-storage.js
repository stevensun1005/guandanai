const KEY = 'guandan-rejoin-seat';
let memory = null;

export function savedSeat(code = null) {
  let value = memory;
  try {
    value = JSON.parse(sessionStorage.getItem(KEY) || 'null') || memory;
  } catch (_) {}
  if (
    !value ||
    !/^\d{4}$/.test(value.code) ||
    typeof value.token !== 'string' ||
    value.token.length > 100 ||
    !['S', 'E', 'N', 'W'].includes(value.dir)
  )
    return null;
  return code && value.code !== code ? null : value;
}

export function rememberSeat(value) {
  memory = {
    code: value.code,
    token: value.token,
    dir: value.dir,
    name: String(value.name || '').slice(0, 8),
  };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch (_) {}
}

export function forgetSeat() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch (_) {}
}
