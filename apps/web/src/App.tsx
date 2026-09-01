import { Link2, LockKeyhole } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AttachmentInput, PostEntryInput, RaiseView } from "@raise/protocol";
import { ActionPanel } from "./components/ActionPanel";
import { Brand } from "./components/Brand";
import { ImagePicker } from "./components/ImagePicker";
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

function SiteHeader({ showNewRequest = false }: { showNewRequest?: boolean }) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        {showNewRequest && (
          <a className="header-link" href="/">
            New request
          </a>
        )}
      </div>
    </header>
  );
}

function NewRaisePage() {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
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
        title,
        prompt,
        ...(url ? { url } : {}),
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
    <div className="app-shell">
      <SiteHeader />
      <main className="page new-page">
        <section className="page-heading">
          <h1>New request</h1>
          <p>Describe the problem and attach anything the agent should see.</p>
        </section>

        <form className="request-form" onSubmit={submit}>
          <div className="field-group">
            <label htmlFor="title">Title</label>
            <input
              className="text-input"
              id="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Billing empty state is clipped on mobile"
              maxLength={180}
              autoFocus
              required
            />
          </div>
          <div className="field-group field-primary">
            <label htmlFor="prompt">Details</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="The empty state overflows at 375 px. Fix the layout and check the mobile breakpoints."
              required
            />
          </div>

          <div className="field-group">
            <label htmlFor="page-url">
              Affected page <small>(optional)</small>
            </label>
            <div className="input-with-icon">
              <Link2 size={17} aria-hidden="true" />
              <input
                id="page-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://localhost:3000/billing/settings"
              />
            </div>
            <p className="field-help">We store the URL but do not open it.</p>
          </div>

          <ImagePicker images={images} onChange={setImages} />

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <footer className="new-footer">
            <p className="form-note">
              <LockKeyhole size={14} /> Access by link. Deleted after 24 hours.
            </p>
            <button
              className="primary-button create-button"
              type="submit"
              disabled={busy || !title.trim() || !prompt.trim()}
            >
              {busy ? "Creating…" : "Create request"}
            </button>
          </footer>
        </form>
      </main>
    </div>
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
      <div className="app-shell">
        <SiteHeader />
        <main className="loading-state">
          <div>
            <span className="spinner" aria-hidden="true" />
            <p>Opening request…</p>
          </div>
        </main>
      </div>
    );
  }

  if (fatal || !raise) {
    return (
      <div className="app-shell">
        <SiteHeader />
        <main className="error-state">
          <h1>Link unavailable</h1>
          <p>{fatal ?? "This link is invalid, expired, or already used."}</p>
          <a className="secondary-button" href="/">
            Create request
          </a>
        </main>
      </div>
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
    <div className="app-shell">
      <SiteHeader showNewRequest />
      <main className="page record-page">
        <section className="record-heading">
          <div className="record-heading-topline">
            <span className="status-label" data-status={raise.lifecycle}>
              {statusText}
            </span>
            <code>{raise.id}</code>
          </div>
          <h1>{raise.title}</h1>
        </section>

        <div className="raise-layout">
          <div className="raise-content">
            {shareUrl && raise.lifecycle === "open" && raise.waitingOn !== raise.viewerRole && (
              <ShareCard url={shareUrl} target={raise.viewerRole === "human" ? "agent" : "human"} />
            )}

            <Timeline entries={raise.entries} viewerRole={raise.viewerRole} />
            <ActionPanel raise={raise} busy={busy} error={error} onSubmit={submit} />
          </div>

          <aside className="details-panel" aria-label="Request details">
            <h2>Details</h2>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{statusText}</dd>
              </div>
              <div>
                <dt>Next step</dt>
                <dd>{actionLabel ?? "None"}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>Viewing as {raise.viewerRole === "human" ? "reviewer" : "agent"}</dd>
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
            <p className="access-note">
              <LockKeyhole size={13} /> Each access link grants one role on this request.
            </p>
          </aside>
        </div>
      </main>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="app-shell">
      <SiteHeader />
      <main className="error-state">
        <h1>Page not found</h1>
        <a href="/">Create request</a>
      </main>
    </div>
  );
}

export function App() {
  const match = /^\/r\/([^/]+)$/.exec(window.location.pathname);
  if (match) return <RaisePage raiseId={match[1] as string} />;
  if (window.location.pathname === "/" || window.location.pathname === "/new")
    return <NewRaisePage />;
  return <NotFoundPage />;
}
