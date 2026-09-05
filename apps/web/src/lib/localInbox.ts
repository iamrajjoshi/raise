import { raiseIdSchema, type RaiseView } from "@raise/protocol";
import { RequestError } from "./api";

const inboxStorageKey = "raise.inbox.v1";
const maxRememberedRaises = 100;

function browserStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function rememberedRaiseIds(storage?: Storage): string[] {
  const target = browserStorage(storage);
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(inboxStorageKey) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed.filter(
          (value): value is string =>
            typeof value === "string" && raiseIdSchema.safeParse(value).success,
        ),
      ),
    ).slice(0, maxRememberedRaises);
  } catch {
    return [];
  }
}

function writeRaiseIds(ids: string[], storage?: Storage) {
  const target = browserStorage(storage);
  if (!target) return;
  try {
    target.setItem(inboxStorageKey, JSON.stringify(ids.slice(0, maxRememberedRaises)));
  } catch {
    // A private browser can block storage. The request itself still works.
  }
}

export function rememberRaise(raiseId: string, storage?: Storage) {
  if (!raiseIdSchema.safeParse(raiseId).success) return;
  writeRaiseIds(
    [raiseId, ...rememberedRaiseIds(storage).filter((stored) => stored !== raiseId)],
    storage,
  );
}

function forgetRaise(raiseId: string, storage?: Storage) {
  writeRaiseIds(
    rememberedRaiseIds(storage).filter((stored) => stored !== raiseId),
    storage,
  );
}

function isInaccessible(error: unknown) {
  return (
    error instanceof RequestError &&
    (error.status === 401 || error.status === 404 || error.code === "unauthorized")
  );
}

export async function loadRememberedRaises(
  load: (raiseId: string) => Promise<RaiseView>,
  storage?: Storage,
) {
  const ids = rememberedRaiseIds(storage);
  const results = await Promise.all(
    ids.map(async (raiseId) => {
      try {
        return { raiseId, view: await load(raiseId), error: null };
      } catch (error) {
        return { raiseId, view: null, error };
      }
    }),
  );

  let failed = 0;
  for (const result of results) {
    if (isInaccessible(result.error)) forgetRaise(result.raiseId, storage);
    else if (result.error) failed += 1;
  }

  return {
    raises: results.flatMap((result) => (result.view ? [result.view] : [])),
    failed,
  };
}

function newestFirst(left: RaiseView, right: RaiseView) {
  return right.updatedAt.localeCompare(left.updatedAt);
}

export function groupInboxRaises(raises: RaiseView[]) {
  return {
    yourTurn: raises
      .filter((raise) => raise.lifecycle === "open" && raise.waitingOn === raise.viewerRole)
      .sort(newestFirst),
    waiting: raises
      .filter((raise) => raise.lifecycle === "open" && raise.waitingOn !== raise.viewerRole)
      .sort(newestFirst),
    closed: raises.filter((raise) => raise.lifecycle !== "open").sort(newestFirst),
  };
}
