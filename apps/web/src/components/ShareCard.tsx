import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function ShareCard({ url, target }: { url: string; target: "agent" | "human" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <aside className="share-card">
      <div className="share-copy">
        <strong>Copy the {target === "agent" ? "agent" : "reviewer"} link</strong>
        <p>
          Anyone with this link can reply as the {target === "agent" ? "agent" : "reviewer"}. Raise
          won’t show it again after you close this tab.
        </p>
      </div>
      <button type="button" className="secondary-button copy-button" onClick={copy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? "Copied" : "Copy link"}
      </button>
    </aside>
  );
}
