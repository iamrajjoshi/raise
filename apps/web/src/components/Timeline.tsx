import { Check, Copy, ExternalLink, Image as ImageIcon, RotateCcw } from "lucide-react";
import type { EntryView, Role } from "@raise/protocol";

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

export function Timeline({ entries, viewerRole }: { entries: EntryView[]; viewerRole: Role }) {
  return (
    <ol className="timeline" aria-label="Request activity">
      {entries.map((entry) => (
        <li className={`entry entry-${entry.kind}`} key={entry.id}>
          <div className="entry-rail" aria-hidden="true">
            <span className="entry-dot">
              {entry.decision === "accept" ? (
                <Check size={12} />
              ) : entry.decision === "request_changes" ? (
                <RotateCcw size={12} />
              ) : null}
            </span>
          </div>
          <article className="entry-card">
            <header className="entry-header">
              <div>
                <span className="entry-kind">{entryLabel[entry.kind]}</span>
                <span className="entry-author">
                  {entry.authorRole === viewerRole
                    ? "You"
                    : entry.authorRole === "human"
                      ? "Reviewer"
                      : "Agent"}
                </span>
              </div>
              <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
            </header>
            {entry.body && <p className="entry-body">{entry.body}</p>}
            {entry.url && (
              <div className="url-item">
                <ExternalLink size={16} aria-hidden="true" />
                <div>
                  <span>Linked page</span>
                  <code>{entry.url}</code>
                </div>
                <button
                  type="button"
                  aria-label="Copy page URL"
                  onClick={() => navigator.clipboard.writeText(entry.url as string)}
                >
                  <Copy size={15} />
                </button>
                <a href={entry.url} target="_blank" rel="noopener noreferrer">
                  Open page
                </a>
              </div>
            )}
            {entry.attachments.length > 0 && (
              <div className="evidence-section">
                <div className="evidence-heading">
                  <ImageIcon size={15} />
                  {entry.attachments.length}{" "}
                  {entry.attachments.length === 1 ? "screenshot" : "screenshots"}
                </div>
                <div className="evidence-grid">
                  {entry.attachments.map((attachment) => (
                    <a
                      className="evidence-image"
                      href={attachment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      key={attachment.id}
                    >
                      <img src={attachment.url} alt={attachment.name} />
                      <span>{attachment.name}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
            {entry.decision && (
              <div className={`decision decision-${entry.decision}`}>
                {entry.decision === "accept" ? "Result accepted" : "Changes requested"}
              </div>
            )}
          </article>
        </li>
      ))}
    </ol>
  );
}
