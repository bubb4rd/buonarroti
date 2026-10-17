import { EventEmitter } from "events";

// In-process event bus: `settleJob` (lib/jobStore) emits `job:<taskId>` with the
// terminal result; `/api/job-stream` listens. Durable state lives in the SQLite
// `generations` table — this only wakes open streams early.
//
// Kept on globalThis because Next can load this module once per route bundle;
// the emitter and the listener must share one instance per process.
const g = globalThis as typeof globalThis & { __buonarrotiJobEvents?: EventEmitter };

const jobEvents = (g.__buonarrotiJobEvents ??= new EventEmitter());
jobEvents.setMaxListeners(500);

export { jobEvents };
