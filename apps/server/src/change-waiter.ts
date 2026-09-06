export type ChangeWaitResult =
  | { reason: "change"; version: number }
  | { reason: "timeout" }
  | { reason: "aborted" }
  | { reason: "closed" };

export interface ChangeWaiterOptions {
  maxWaitMs?: number;
}

interface PendingWait {
  afterVersion: number;
  finish(result: ChangeWaitResult): void;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

/**
 * A disposable signal for one-process long polling.
 *
 * Persisted state remains authoritative: callers read before waiting and read
 * again after every result. Closing or replacing this object therefore loses no
 * changes; it only asks connected callers to retry from their last version.
 */
export class ChangeWaiter {
  private readonly maxWaitMs: number;
  private readonly waitsByRaise = new Map<string, Set<PendingWait>>();
  private closed = false;
  private waitCount = 0;

  constructor(options: ChangeWaiterOptions = {}) {
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    requireNonNegativeInteger(this.maxWaitMs, "Maximum wait duration");
  }

  get activeWaitCount(): number {
    return this.waitCount;
  }

  wait(
    raiseId: string,
    afterVersion: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ChangeWaitResult> {
    if (!raiseId) throw new Error("Raise ID must not be empty.");
    requireNonNegativeInteger(afterVersion, "Version");
    requireNonNegativeInteger(timeoutMs, "Wait duration");
    if (signal?.aborted) return Promise.resolve({ reason: "aborted" });
    if (this.closed) return Promise.resolve({ reason: "closed" });

    const boundedTimeoutMs = Math.min(timeoutMs, this.maxWaitMs);
    if (boundedTimeoutMs === 0) return Promise.resolve({ reason: "timeout" });

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => pending.finish({ reason: "aborted" });
      const pending: PendingWait = {
        afterVersion,
        finish: (result) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.remove(raiseId, pending);
          resolve(result);
        },
      };

      let waits = this.waitsByRaise.get(raiseId);
      if (!waits) {
        waits = new Set();
        this.waitsByRaise.set(raiseId, waits);
      }
      waits.add(pending);
      this.waitCount += 1;

      timer = setTimeout(() => pending.finish({ reason: "timeout" }), boundedTimeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  notify(raiseId: string, version: number): void {
    requireNonNegativeInteger(version, "Version");
    if (this.closed) return;

    const waits = this.waitsByRaise.get(raiseId);
    if (!waits) return;
    for (const pending of [...waits]) {
      if (version > pending.afterVersion) pending.finish({ reason: "change", version });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.waitsByRaise.values()].flatMap((waits) => [...waits]);
    for (const wait of pending) wait.finish({ reason: "closed" });
  }

  private remove(raiseId: string, pending: PendingWait): void {
    const waits = this.waitsByRaise.get(raiseId);
    if (!waits?.delete(pending)) return;
    this.waitCount -= 1;
    if (waits.size === 0) this.waitsByRaise.delete(raiseId);
  }
}
