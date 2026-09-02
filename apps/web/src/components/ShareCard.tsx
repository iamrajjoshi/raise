import { useState } from "react";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("copy_failed");
  }
}

export function ShareCard({ url, target }: { url: string; target: "agent" | "human" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className="share-card">
      <div className="share-copy">
        <strong>{target === "agent" ? "Agent link" : "Human link"}</strong>
        <p>
          {target === "agent"
            ? "Connected agents will see this in their inbox. Otherwise, send this one-time link."
            : "Send this one-time link before you close the tab. Raise won’t show it again."}
        </p>
        <code>{url}</code>
      </div>
      <button type="button" className="control control-secondary copy-button" onClick={copy}>
        <span className="control-glyph" aria-hidden="true">
          {copied ? "✓" : "⧉"}
        </span>
        {copied ? "Copied" : "Copy link"}
      </button>
    </aside>
  );
}
