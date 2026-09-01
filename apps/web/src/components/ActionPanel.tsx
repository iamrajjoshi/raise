import { ArrowUp, Check, CornerDownLeft, RotateCcw } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { AttachmentInput, PostEntryInput, RaiseView } from "@raise/protocol";
import { ImagePicker } from "./ImagePicker";

interface ActionPanelProps {
  raise: RaiseView;
  busy: boolean;
  error: string | null;
  onSubmit: (entry: PostEntryInput) => Promise<boolean>;
}

export function ActionPanel({ raise, busy, error, onSubmit }: ActionPanelProps) {
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [images, setImages] = useState<AttachmentInput[]>([]);
  const [requestingChanges, setRequestingChanges] = useState(false);

  const reset = () => {
    setBody("");
    setUrl("");
    setImages([]);
  };

  const submitContent = async (event: FormEvent) => {
    event.preventDefault();
    const kind = raise.permissions.canPostResult ? "result" : "response";
    const sent = await onSubmit({
      kind,
      body,
      ...(url ? { url } : {}),
      attachments: images,
      expectedVersion: raise.version,
    });
    if (sent) reset();
  };

  if (raise.lifecycle !== "open") {
    return (
      <section className="resolved-panel">
        <span className="resolved-check">
          <Check size={18} />
        </span>
        <div>
          <strong>Request closed</strong>
          <p>You can read this thread until it is deleted.</p>
        </div>
      </section>
    );
  }

  if (raise.permissions.canReview) {
    return (
      <section className="review-panel" aria-labelledby="review-heading">
        <div className="review-heading">
          <h2 id="review-heading">Review the result</h2>
          <p>Accept it or ask for changes.</p>
        </div>
        {requestingChanges ? (
          <form
            className="changes-form panel-reveal"
            onSubmit={async (event) => {
              event.preventDefault();
              const sent = await onSubmit({
                kind: "review_decision",
                decision: "request_changes",
                body,
                attachments: [],
                expectedVersion: raise.version,
              });
              if (sent) {
                reset();
                setRequestingChanges(false);
              }
            }}
          >
            <label htmlFor="change-note">What still needs work?</label>
            <textarea
              id="change-note"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Describe what is missing or incorrect"
              autoFocus
              required
            />
            <div className="button-row">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setRequestingChanges(false)}
              >
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={busy || !body.trim()}>
                <CornerDownLeft size={16} /> Ask for changes
              </button>
            </div>
          </form>
        ) : (
          <div className="review-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() =>
                onSubmit({
                  kind: "review_decision",
                  decision: "accept",
                  body: "",
                  attachments: [],
                  expectedVersion: raise.version,
                })
              }
            >
              <Check size={17} /> Accept result
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setRequestingChanges(true)}
            >
              <RotateCcw size={16} /> Ask for changes
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (raise.permissions.canReply || raise.permissions.canPostResult) {
    const isResult = raise.permissions.canPostResult;
    return (
      <form className="composer" onSubmit={submitContent}>
        <div className="composer-heading">
          <h2>{isResult ? "Result" : "Reply"}</h2>
          <p>
            {isResult
              ? "Summarize what changed and how you checked it."
              : "Add the detail the agent requested."}
          </p>
        </div>
        <label className="sr-only" htmlFor="entry-body">
          {isResult ? "Result summary" : "Reply"}
        </label>
        <textarea
          id="entry-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={
            isResult
              ? "Fixed the clipping and checked the page at 375 px and 768 px."
              : "The issue only happens below 390 px."
          }
          autoFocus
        />
        <label className="inline-field">
          <span>
            {isResult ? "Preview or pull request" : "Page URL"} <small>(optional)</small>
          </span>
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://localhost:3000/settings"
          />
        </label>
        <ImagePicker images={images} onChange={setImages} compact />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="composer-footer">
          <span>Up to 4 screenshots</span>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || (!body.trim() && !url && !images.length)}
          >
            {busy ? "Sending…" : isResult ? "Send for review" : "Send reply"}
            {!busy && <ArrowUp size={16} />}
          </button>
        </div>
      </form>
    );
  }

  return (
    <section className="waiting-panel" role="status">
      <span className="waiting-pulse" aria-hidden="true" />
      <div>
        <strong>
          {raise.waitingOn === "agent" ? "Waiting for the agent" : "Waiting for the reviewer"}
        </strong>
        <p>Replies appear here automatically.</p>
      </div>
    </section>
  );
}
