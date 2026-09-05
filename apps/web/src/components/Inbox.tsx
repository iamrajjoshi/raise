import type { RaiseView } from "@raise/protocol";

interface InboxGroups {
  yourTurn: RaiseView[];
  waiting: RaiseView[];
  closed: RaiseView[];
}

function formatInboxDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return `Today, ${time}`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function actionText(raise: RaiseView) {
  if (raise.lifecycle === "resolved") return "Closed";
  if (raise.waitingOn !== raise.viewerRole) {
    return raise.waitingOn === "agent" ? "With the agent" : "Waiting on a reply";
  }
  if (raise.pendingAction === "review_result") return "Review the result";
  if (raise.pendingAction === "provide_context") return "Add the missing details";
  return "Your turn";
}

function InboxRow({ raise, state }: { raise: RaiseView; state: "turn" | "wait" | "closed" }) {
  return (
    <li>
      <a className="inbox-row" href={`/r/${raise.id}`}>
        <span className="inbox-row-mark" data-state={state} aria-hidden="true" />
        <span className="inbox-row-copy">
          <strong>{raise.title}</strong>
          <span>{actionText(raise)}</span>
        </span>
        <time dateTime={raise.updatedAt}>{formatInboxDate(raise.updatedAt)}</time>
        <span className="inbox-row-open" aria-hidden="true">
          OPEN ↗
        </span>
      </a>
    </li>
  );
}

function InboxSection({
  title,
  items,
  state,
}: {
  title: string;
  items: RaiseView[];
  state: "turn" | "wait" | "closed";
}) {
  if (!items.length) return null;
  return (
    <section className="inbox-section">
      <div className="inbox-section-heading">
        <h2>{title}</h2>
        <span>{String(items.length).padStart(2, "0")}</span>
      </div>
      <ol className="inbox-list">
        {items.map((raise) => (
          <InboxRow key={raise.id} raise={raise} state={state} />
        ))}
      </ol>
    </section>
  );
}

function InboxContents({ groups, loading }: { groups: InboxGroups; loading: boolean }) {
  if (loading) {
    return (
      <div className="inbox-loading">
        <span className="spinner" aria-hidden="true" />
        <p>Checking your requests…</p>
      </div>
    );
  }

  const total = groups.yourTurn.length + groups.waiting.length + groups.closed.length;
  if (total > 0) {
    return (
      <div className="inbox-sections">
        <InboxSection title="Your turn" items={groups.yourTurn} state="turn" />
        <InboxSection title="Waiting" items={groups.waiting} state="wait" />
        <InboxSection title="Recently closed" items={groups.closed} state="closed" />
      </div>
    );
  }

  return (
    <section className="inbox-empty">
      <span aria-hidden="true">00</span>
      <div>
        <h2>Nothing waiting.</h2>
        <p>Start a request or open a shared link and it’ll show up here.</p>
        <a className="control control-primary" href="/">
          Start a request
        </a>
      </div>
    </section>
  );
}

export function Inbox({
  groups,
  loading,
  failed,
}: {
  groups: InboxGroups;
  loading: boolean;
  failed: number;
}) {
  return (
    <main className="page inbox-page">
      <header className="inbox-intro">
        <span className="inbox-kicker">ON THIS DEVICE</span>
        <h1>Things in flight</h1>
        <p>Requests you start or open in this browser stay here until their access runs out.</p>
      </header>

      {failed > 0 && (
        <p className="inbox-warning" role="status">
          {failed === 1
            ? "One request couldn’t be loaded. Refresh to try it again."
            : `${failed} requests couldn’t be loaded. Refresh to try them again.`}
        </p>
      )}

      <InboxContents groups={groups} loading={loading} />
    </main>
  );
}
