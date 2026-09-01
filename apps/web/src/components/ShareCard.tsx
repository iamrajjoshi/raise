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
        <strong>{target === "agent" ? "Agent link" : "Reviewer link"}</strong>
        <p>
          It opens this request as the {target === "agent" ? "agent" : "reviewer"}. Copy it now; it
          won’t appear again after this tab closes.
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
