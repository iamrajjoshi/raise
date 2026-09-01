import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AttachmentInput, PostEntryInput, RaiseView } from "@raise/protocol";
import { ActionPanel } from "./components/ActionPanel";
import { Brand } from "./components/Brand";
import { Scratchpad } from "./components/Scratchpad";
import { ShareCard } from "./components/ShareCard";
import { Timeline } from "./components/Timeline";
import {
  claimRaise,
  claimTokenFromHash,
  createRaise,
  getRaise,
  postEntry,
  RequestError,
} from "./lib/api";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function SiteHeader({
  showNewRequest = false,
  currentLabel,
}: {
  showNewRequest?: boolean;
  currentLabel?: string;
}) {
  return (
    <header className="site-header">
      <div className="header-brand-cell">
        <Brand />
      </div>
      <div className="header-title-cell">
        {currentLabel ? (
          <h1 className="header-context">{currentLabel}</h1>
        ) : showNewRequest ? (
          <a className="control control-quiet header-link" href="/">
            New request
          </a>
        ) : null}
      </div>
    </header>
  );
}

function AppFrame({
  children,
  currentLabel,
  showNewRequest = false,
  className = "",
}: {
  children: ReactNode;
  currentLabel?: string;
  showNewRequest?: boolean;
  className?: string;
}) {
  return (
    <div className={`app-shell ${className}`}>
      <div className="work-sheet">
        <SiteHeader showNewRequest={showNewRequest} {...(currentLabel ? { currentLabel } : {})} />
        {children}
      </div>
    </div>
  );
}

function NewRaisePage() {
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AttachmentInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createRaise({
        origin: "human",
        prompt,
        attachments: images,
        expiresInHours: 24,
      });
      const ownerToken = new URL(result.ownerClaimUrl).hash.slice("#token=".length);
      await claimRaise(ownerToken);
      sessionStorage.setItem(`raise.share.${result.raiseId}`, result.targetClaimUrl);
      window.location.assign(`/r/${result.raiseId}`);
    } catch (caught) {
      setError(
        caught instanceof RequestError
          ? caught.message
          : "We couldn't create the request. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <AppFrame className="app-shell-new" currentLabel="New request">
      <main className="new-page">
        <Scratchpad
          value={prompt}
          onChange={setPrompt}
          images={images}
          onImagesChange={setImages}
          onSubmit={submit}
          label="Request"
          placeholder="Paste notes, links, screenshots, or the whole messy thread."
          submitLabel="Send"
          busyLabel="Sending…"
          busy={busy}
          canSubmit={Boolean(prompt.trim() || images.length)}
          error={error}
          autoFocus
          note={<>Anyone with the link can open it. Deleted in 24 hours.</>}
        />
      </main>
    </AppFrame>
  );
}

function RaisePage({ raiseId }: { raiseId: string }) {
  const [raise, setRaise] = useState<RaiseView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const load = useCallback(async () => {
    const view = await getRaise(raiseId);
    setRaise(view);
    return view;
  }, [raiseId]);

  useEffect(() => {
    let active = true;
    const start = async () => {
      try {
        const token = claimTokenFromHash();
        if (token) {
          await claimRaise(token);
          window.history.replaceState(null, "", `/r/${raiseId}`);
        }
        const view = await load();
        if (active) setRaise(view);
      } catch (caught) {
        if (active) {
          setFatal(
            caught instanceof RequestError ? caught.message : "This request could not be opened.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void start();
    return () => {
      active = false;
    };
  }, [load, raiseId]);

  useEffect(() => {
    if (!raise || raise.lifecycle !== "open") return;
    const interval = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [load, raise]);

  const submit = async (entry: PostEntryInput) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await postEntry(raiseId, entry);
      setRaise(updated);
      return true;
    } catch (caught) {
      setError(
        caught instanceof RequestError ? caught.message : "We couldn't send that. Try again.",
      );
      if (caught instanceof RequestError && caught.code === "state_conflict") await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <AppFrame className="app-shell-record" showNewRequest>
        <main className="loading-state">
          <div>
            <span className="spinner" aria-hidden="true" />
            <p>Opening request…</p>
          </div>
        </main>
      </AppFrame>
    );
  }

  if (fatal || !raise) {
    return (
      <AppFrame className="app-shell-record" showNewRequest>
        <main className="error-state">
          <h1>Link unavailable</h1>
          <p>{fatal ?? "This link is invalid, expired, or already used."}</p>
          <a className="control control-primary" href="/">
            Create request
          </a>
        </main>
      </AppFrame>
    );
  }

  const shareUrl = sessionStorage.getItem(`raise.share.${raise.id}`);
  const statusText =
    raise.lifecycle === "resolved"
      ? "Closed"
      : raise.lifecycle === "expired"
        ? "Expired"
        : raise.lifecycle === "cancelled"
          ? "Cancelled"
          : raise.waitingOn === raise.viewerRole
            ? "Your turn"
            : raise.waitingOn === "agent"
              ? "Waiting for the agent"
              : "Waiting for the reviewer";
  const actionLabel = raise.pendingAction
    ? {
        provide_context: "Add requested details",
        perform_work: "Post a result",
        review_result: "Review the result",
        make_changes: "Post an updated result",
      }[raise.pendingAction]
    : null;

  return (
    <AppFrame className="app-shell-record" showNewRequest>
      <main className="page record-page">
        <section className="record-heading">
          <div className="record-heading-topline">
            <span className="status-label" data-status={raise.lifecycle}>
              {statusText}
            </span>
            <code>{raise.id}</code>
          </div>
          <h1>{raise.title}</h1>
          <dl className="record-meta">
            <div>
              <dt>Next</dt>
              <dd>{actionLabel ?? "Nothing"}</dd>
            </div>
            <div>
              <dt>Open as</dt>
              <dd>{raise.viewerRole === "human" ? "Reviewer" : "Agent"}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(raise.createdAt)}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatDateTime(raise.expiresAt)}</dd>
            </div>
          </dl>
        </section>

        <div className="raise-layout">
          <div className="raise-content">
            {shareUrl && raise.lifecycle === "open" && raise.waitingOn !== raise.viewerRole && (
              <ShareCard url={shareUrl} target={raise.viewerRole === "human" ? "agent" : "human"} />
            )}

            <Timeline entries={raise.entries} viewerRole={raise.viewerRole} />
            <ActionPanel raise={raise} busy={busy} error={error} onSubmit={submit} />
          </div>
        </div>
      </main>
    </AppFrame>
  );
}

function NotFoundPage() {
  return (
    <AppFrame className="app-shell-record" showNewRequest>
      <main className="error-state">
        <h1>Page not found</h1>
        <a className="control control-primary" href="/">
          Create request
        </a>
      </main>
    </AppFrame>
  );
}

export function App() {
  const match = /^\/r\/([^/]+)$/.exec(window.location.pathname);
  if (match) return <RaisePage raiseId={match[1] as string} />;
  if (window.location.pathname === "/" || window.location.pathname === "/new")
    return <NewRaisePage />;
  return <NotFoundPage />;
}
