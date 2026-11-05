/**
 * Rewrite a P0-layout policy ONNX so `state`, `actions` and `values` share a first dimension
 * named "rows" (one state row per candidate), without Python or an ONNX library.
 *
 * Only the path ModelProto.graph(7) → input(11)/output(12) → type(2) → tensor_type(1) →
 * shape(2) → first dim(1) is decoded; every other field, including the weights, is copied as
 * raw protobuf bytes. Operators are unchanged, and the first-layer Add broadcasts the same way.
 */

function readVarint(bytes, at) {
  let value = 0n,
    shift = 0n;
  for (;;) {
    const byte = bytes[at++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, at];
    shift += 7n;
  }
}

function varint(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Uint8Array.from(out);
}

/** Split a message into fields; `data` is the payload for length-delimited fields. */
function fields(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length;) {
    const start = at;
    let key;
    [key, at] = readVarint(bytes, at);
    const number = Number(key >> 3n),
      wire = Number(key & 7n);
    let data = null;
    if (wire === 0) [, at] = readVarint(bytes, at);
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      let length;
      [length, at] = readVarint(bytes, at);
      data = bytes.subarray(at, at + Number(length));
      at += Number(length);
    } else throw Error(`Unsupported protobuf wire type ${wire}`);
    out.push({ number, wire, raw: bytes.subarray(start, at), data });
  }
  return out;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) out.set(part, (at += part.length) - part.length);
  return out;
};
const lengthField = (number, payload) =>
  concat([varint((number << 3) | 2), varint(payload.length), payload]);
const text = (value) => new TextEncoder().encode(value);

/** Replace length-delimited field `number` occurrences selected by `pick` with `edit(payload)`. */
function rewrite(bytes, number, edit, pick = () => true) {
  let index = 0;
  return concat(
    fields(bytes).map((field) =>
      field.number === number && field.wire === 2 && pick(field, index++)
        ? lengthField(number, edit(field.data))
        : field.raw,
    ),
  );
}

const firstDimToRows = (shape) =>
  rewrite(
    shape,
    1,
    () => lengthField(2, text('rows')),
    (_, index) => index === 0,
  );

function valueInfoToRows(valueInfo) {
  return rewrite(valueInfo, 2, (type) =>
    rewrite(type, 1, (tensor) => rewrite(tensor, 2, firstDimToRows)),
  );
}

function valueInfoName(valueInfo) {
  const name = fields(valueInfo).find((f) => f.number === 1 && f.wire === 2);
  return name ? new TextDecoder().decode(name.data) : null;
}

export function rowsModel(modelBytes) {
  const bytes = modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);
  const seen = new Set();
  const out = rewrite(bytes, 7, (graph) => {
    let edited = graph;
    for (const number of [11, 12])
      edited = rewrite(edited, number, (valueInfo) => {
        seen.add(valueInfoName(valueInfo));
        return valueInfoToRows(valueInfo);
      });
    return edited;
  });
  if (['state', 'actions', 'values'].some((name) => !seen.has(name)) || seen.size !== 3)
    throw Error('Not a P0-layout policy graph (expected inputs state, actions and output values)');
  return out;
}
