import { ImagePlus, X } from "lucide-react";
import { useId, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { AttachmentInput } from "@raise/protocol";
import { imageFiles } from "../lib/api";

interface ImagePickerProps {
  images: AttachmentInput[];
  onChange: (images: AttachmentInput[]) => void;
  compact?: boolean;
}

export function ImagePicker({ images, onChange, compact = false }: ImagePickerProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const add = async (files: File[]) => {
    const next = await imageFiles(files);
    onChange([...images, ...next].slice(0, 4));
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    await add(Array.from(event.dataTransfer.files));
  };

  const handlePaste = async (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length) await add(files);
  };

  return (
    <div className={`image-picker ${compact ? "image-picker-compact" : ""}`} onPaste={handlePaste}>
      {!compact && (
        <div className="picker-label">
          <span>Attachments</span>
          <small>Optional</small>
        </div>
      )}
      {images.length > 0 && (
        <div className="attachment-previews" aria-label="Attached screenshots">
          {images.map((image, index) => (
            <figure className="attachment-preview" key={`${image.name}-${index}`}>
              <img src={image.dataUrl} alt="" />
              <figcaption>{image.name}</figcaption>
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => onChange(images.filter((_, itemIndex) => itemIndex !== index))}
              >
                <X size={14} />
              </button>
            </figure>
          ))}
        </div>
      )}
      {images.length < 4 && (
        <div
          className={`image-drop ${dragging ? "image-drop-active" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            id={inputId}
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={async (event) => {
              await add(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <button type="button" className="quiet-button" onClick={() => input.current?.click()}>
            <ImagePlus size={16} /> Add screenshots
          </button>
          {!compact && <span>Paste or drop PNG, JPEG, or WebP</span>}
        </div>
      )}
    </div>
  );
}
