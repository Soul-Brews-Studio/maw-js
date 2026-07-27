// kobo-430 — a REAL separate OS process, spawned by store.test.ts's concurrency test.
// Appends N messages to one room, each with a globally-unique id (prefix + index), then
// exits. Two of these run at the same time against the SAME room to reproduce the
// measured last-writer-wins loss (40 of 80 messages vanished pre-fix).
import { appendRoomMessage } from "../store";

const [, , company, roomId, prefix, countArg] = process.argv;
const count = parseInt(countArg, 10);

for (let i = 0; i < count; i++) {
  appendRoomMessage(company, roomId, { id: `${prefix}-${i}`, from: prefix, text: `msg ${i} from ${prefix}`, ts: Date.now() });
}
