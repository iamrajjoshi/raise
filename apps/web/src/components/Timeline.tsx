import type { EntryView, Role } from "@raise/protocol";
import { Screenshot } from "./Screenshot";

const entryLabel: Record<EntryView["kind"], string> = {
  prompt: "Request",
  response: "Reply",
  result: "Result",
  comment: "Comment",
  review_decision: "Review",
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function copyUrl(url: string) {
  return navigator.clipboard.writeText(url);
}

function authorLabel(entry: EntryView, viewerRole: Role): string {
  if (entry.authorRole === viewerRole) return "You";
  return entry.authorRole === "human" ? "Human" : "Agent";
}

export function Timeline({ entries, viewerRole }: { entries: EntryView[]; viewerRole: Role }) {
  return (
    <ol className="timeline" aria-label="Request activity">
      {entries.map((entry) => (
        <li className={`entry entry-${entry.kind}`} key={entry.id}>
          <article className="entry-card">
            <header className="entry-header">
              <div>
                <span className="entry-kind">{entryLabel[entry.kind]}</span>
                <span className="entry-author">{authorLabel(entry, viewerRole)}</span>
              </div>
              <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
            </header>
            {entry.body && <p className="entry-body">{entry.body}</p>}
            {entry.url && (
              <div className="url-item">
                <div>
                  <span>Page</span>
                  <code>{entry.url}</code>
                </div>
                <button
                  type="button"
                  className="control control-quiet url-copy"
                  aria-label="Copy page URL"
                  onClick={() => {
                    if (entry.url) void copyUrl(entry.url);
                  }}
                >
                  <span className="control-glyph" aria-hidden="true">
                    ⧉
                  </span>
                  Copy
                </button>
                <a
                  className="control control-secondary url-open"
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open page
                  <span className="control-glyph" aria-hidden="true">
                    ↗
                  </span>
                </a>
              </div>
            )}
            {entry.attachments.length > 0 && (
              <div className="evidence-section">
                <div className="evidence-heading">
                  {entry.attachments.length}{" "}
                  {entry.attachments.length === 1 ? "screenshot" : "screenshots"}
                </div>
                <div className="evidence-grid">
                  {entry.attachments.map((attachment) => (
                    <Screenshot
                      src={attachment.url}
                      name={attachment.name}
                      width={attachment.width}
                      height={attachment.height}
                      key={attachment.id}
                    />
                  ))}
                </div>
              </div>
            )}
            {entry.decision && (
              <div className={`decision decision-${entry.decision}`}>
                {entry.decision === "accept" ? (
                  <>
                    <span aria-hidden="true">✓</span> Result accepted
                  </>
                ) : (
                  <>
                    <span aria-hidden="true">↺</span> Changes requested
                  </>
                )}
              </div>
            )}
          </article>
        </li>
      ))}
    </ol>
  );
}
