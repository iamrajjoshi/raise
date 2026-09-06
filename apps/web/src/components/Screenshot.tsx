import { useRef, useState, type MouseEvent } from "react";

interface ScreenshotProps {
  src: string;
  name: string;
  width?: number;
  height?: number;
  onRemove?: () => void;
}

export function Screenshot({ src, name, width, height, onRemove }: ScreenshotProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(
    width && height ? { width, height } : null,
  );

  const open = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActualSize(false);
    dialog.current?.showModal();
  };

  const closeFromBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) dialog.current?.close();
  };

  const sizeLabel = dimensions ? `${dimensions.width} × ${dimensions.height}` : "Screenshot";

  return (
    <figure
      className={`screenshot-card ${dimensions && dimensions.width / dimensions.height > 2.2 ? "screenshot-card-wide" : ""}`}
    >
      <button
        type="button"
        className="screenshot-open"
        aria-label={`Open full-size screenshot: ${name}`}
        onClick={open}
      >
        <span className="screenshot-stage">
          <img
            src={src}
            alt=""
            onLoad={(event) =>
              setDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        </span>
      </button>
      <figcaption className="screenshot-caption">
        <span className="screenshot-name">{name}</span>
        <span className="screenshot-size">{sizeLabel}</span>
        <button
          type="button"
          className="screenshot-view"
          aria-label={`Open full-size screenshot: ${name}`}
          onClick={open}
        >
          VIEW
        </button>
        {onRemove && (
          <button
            type="button"
            className="control control-icon control-quiet screenshot-remove"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
          >
            <span className="control-glyph" aria-hidden="true">
              ×
            </span>
          </button>
        )}
      </figcaption>

      <dialog
        ref={dialog}
        className="screenshot-dialog"
        aria-label={`Full-size screenshot: ${name}`}
        onClick={closeFromBackdrop}
        onClose={() => opener.current?.focus()}
      >
        <div className="screenshot-dialog-window">
          <header className="screenshot-dialog-bar">
            <div>
              <strong>{name}</strong>
              <span>{sizeLabel}</span>
            </div>
            <div className="screenshot-dialog-controls">
              <button
                type="button"
                className={`control control-quiet ${actualSize ? "" : "control-selected"}`}
                aria-pressed={!actualSize}
                onClick={() => setActualSize(false)}
              >
                Fit
              </button>
              <button
                type="button"
                className={`control control-quiet ${actualSize ? "control-selected" : ""}`}
                aria-pressed={actualSize}
                onClick={() => setActualSize(true)}
              >
                100%
              </button>
              <button
                type="button"
                className="control control-secondary"
                onClick={() => dialog.current?.close()}
              >
                Close <span aria-hidden="true">Esc</span>
              </button>
            </div>
          </header>
          <div className={`screenshot-full ${actualSize ? "screenshot-full-actual" : ""}`}>
            <img src={src} alt={name} />
          </div>
        </div>
      </dialog>
    </figure>
  );
}
