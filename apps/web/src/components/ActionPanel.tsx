import { useState, type FormEvent } from "react";
import type { AttachmentInput, PostEntryInput, RaiseView } from "@raise/protocol";
import { Scratchpad } from "./Scratchpad";

interface ActionPanelProps {
  raise: RaiseView;
  busy: boolean;
  error: string | null;
  onSubmit: (entry: PostEntryInput) => Promise<boolean>;
}

export function ActionPanel({ raise, busy, error, onSubmit }: ActionPanelProps) {
  const [body, setBody] = useState("");
  const [images, setImages] = useState<AttachmentInput[]>([]);
  const [requestingChanges, setRequestingChanges] = useState(false);

  const reset = () => {
    setBody("");
    setImages([]);
  };

  const submitContent = async (event: FormEvent) => {
    event.preventDefault();
    const kind = raise.permissions.canPostResult ? "result" : "response";
    const sent = await onSubmit({
      kind,
      body,
      attachments: images,
      expectedVersion: raise.version,
    });
    if (sent) reset();
  };

  if (raise.lifecycle !== "open") {
    return (
      <section className="resolved-panel">
        <span className="resolved-check">
          <span aria-hidden="true">✓</span>
        </span>
        <div>
          <strong>Request closed</strong>
          <p>This thread stays readable until its link expires.</p>
        </div>
      </section>
    );
  }

  if (raise.permissions.canReview) {
    return (
      <section className="review-panel" aria-labelledby="review-heading">
        <div className="review-heading">
          <h2 id="review-heading">Review result</h2>
          <p>Use it as-is, or send it back with a note.</p>
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
              placeholder="Say what’s still off."
              autoFocus
              required
            />
            <div className="button-row">
              <button
                type="button"
                className="control control-quiet"
                onClick={() => setRequestingChanges(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="control control-primary"
                disabled={busy || !body.trim()}
              >
                Ask for changes
                <span className="control-glyph" aria-hidden="true">
                  ↵
                </span>
              </button>
            </div>
          </form>
        ) : (
          <div className="review-actions">
            <button
              type="button"
              className="control control-primary"
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
              <span className="control-glyph" aria-hidden="true">
                ✓
              </span>
              Accept result
            </button>
            <button
              type="button"
              className="control control-secondary"
              onClick={() => setRequestingChanges(true)}
            >
              <span className="control-glyph" aria-hidden="true">
                ↺
              </span>
              Ask for changes
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
      <section className="composer">
        <div className="composer-heading">
          <h2>{isResult ? "Result" : "Reply"}</h2>
          <p>
            {isResult
              ? "Add what changed, what you checked, and any screenshots."
              : "Answer the question or paste in the missing context."}
          </p>
        </div>
        <Scratchpad
          value={body}
          onChange={setBody}
          images={images}
          onImagesChange={setImages}
          onSubmit={submitContent}
          label={isResult ? "Result summary" : "Reply"}
          placeholder={
            isResult ? "What changed? Paste notes, links, or screenshots." : "Paste whatever helps."
          }
          submitLabel={isResult ? "Send for review" : "Send"}
          busy={busy}
          canSubmit={Boolean(body.trim() || images.length)}
          error={error}
          compact
          autoFocus
        />
      </section>
    );
  }

  return (
    <section className="waiting-panel" role="status">
      <span className="waiting-pulse" aria-hidden="true" />
      <div>
        <strong>
          {raise.waitingOn === "agent" ? "Waiting for the agent" : "Waiting for the reviewer"}
        </strong>
        <p>Replies show up here when they arrive.</p>
      </div>
    </section>
  );
}
