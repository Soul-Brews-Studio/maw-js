// WASM Bridge — write data into WASM, read state out

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function writeStr(exports, s) {
  const encoded = encoder.encode(s);
  const ptr = exports.wasm_alloc(encoded.length);
  new Uint8Array(exports.memory.buffer, ptr, encoded.length).set(encoded);
  return [ptr, encoded.length];
}

export function pushAgents(exports, agents) {
  const lines = agents.map(a =>
    `${a.target}|${a.name}|${a.session}|${a.windowIndex}|${a.active ? 1 : 0}|${a.status}|${a.preview}`
  ).join('\n');
  const [ptr, len] = writeStr(exports, lines);
  exports.wasm_push_agents(ptr, len);
  exports.wasm_free(ptr, len);
}

export function pushSaiyan(exports, targets) {
  const [ptr, len] = writeStr(exports, targets.join('\n'));
  exports.wasm_push_saiyan(ptr, len);
  exports.wasm_free(ptr, len);
}

export function readPopup(exports) {
  const ptr = exports.wasm_get_popup_ptr();
  const len = exports.wasm_get_popup_len();
  if (len === 0) return null;
  return decoder.decode(new Uint8Array(exports.memory.buffer, ptr, len));
}
