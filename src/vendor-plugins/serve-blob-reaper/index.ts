import { reapOldUploads as defaultReapOldUploads } from "../../api/upload";

type ServeLog = {
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type TimerHandle = { unref?: () => void };
type SetIntervalFn = (handler: () => void, timeout: number) => TimerHandle;

type ServeBlobReaperContext = {
  log?: ServeLog;
};

type ServeBlobReaperDeps = {
  reapOldUploads: typeof defaultReapOldUploads;
  setInterval: SetIntervalFn;
};

const defaultDeps: ServeBlobReaperDeps = {
  reapOldUploads: defaultReapOldUploads,
  setInterval: (handler, timeout) => setInterval(handler, timeout) as TimerHandle,
};

// Upload blobs are low-churn; a 6h sweep keeps the store bounded without
// scanning the filesystem on a hot interval.
const BLOB_REAP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 7;

export function resolveBlobTtlDays(): number {
  const n = Number(process.env.MAW_UPLOAD_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL_DAYS;
}

export function startServeBlobReap(
  deps: Partial<ServeBlobReaperDeps> = {},
  log?: ServeLog,
): TimerHandle {
  const d = { ...defaultDeps, ...deps };
  const ttlDays = resolveBlobTtlDays();
  const run = () => {
    try {
      const { web, inbox } = d.reapOldUploads(ttlDays);
      if (web + inbox > 0) {
        log?.info?.(`[blob-reap] removed ${web} web + ${inbox} inbox blob(s) older than ${ttlDays}d`);
      }
    } catch (err) {
      log?.error?.("[blob-reap] failed:", err);
    }
  };
  run(); // immediate sweep at serve startup
  const timer = d.setInterval(run, BLOB_REAP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export function serve(
  ctx: ServeBlobReaperContext = {},
  deps?: Partial<ServeBlobReaperDeps>,
): { ok: true; timer: TimerHandle } {
  return { ok: true, timer: startServeBlobReap(deps, ctx.log) };
}

export default serve;
