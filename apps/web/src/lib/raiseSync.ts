import type { RaiseView } from "@raise/protocol";
import { RequestError } from "./api";

const retryDelaysMs = [500, 1_000, 2_000, 5_000] as const;

export function mergeRaiseView(current: RaiseView, incoming: RaiseView): RaiseView {
  if (incoming.id !== current.id) return current;
  if (incoming.version < current.version) return current;
  if (incoming.entriesMode === "snapshot") return incoming;

  const knownEntries = new Set(current.entries.map((entry) => entry.id));
  return {
    ...incoming,
    entriesMode: "snapshot",
    entries: [
      ...current.entries,
      ...incoming.entries.filter((entry) => !knownEntries.has(entry.id)),
    ],
  };
}

export function retryDelayMs(failureCount: number): number {
  const index = Math.max(0, Math.min(failureCount - 1, retryDelaysMs.length - 1));
  return retryDelaysMs[index] ?? 5_000;
}

export function isTerminalReadError(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
