import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AttachmentInput } from "@raise/protocol";
import { imageFiles, RequestError } from "../lib/api";
import {
  appendPlainText,
  canAddScreenshots,
  classifyFiles,
  importTextFiles,
  maxBodyLength,
  screenshotBudgetMessage,
  unsupportedFileMessage,
} from "../lib/intake";
import { Screenshot } from "./Screenshot";

interface ScratchpadProps {
  value: string;
  onChange: (value: string) => void;
  images: AttachmentInput[];
  onImagesChange: (images: AttachmentInput[]) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  label: string;
  placeholder: string;
  submitLabel: string;
  busyLabel?: string;
  busy: boolean;
  canSubmit: boolean;
  error?: string | null;
  note?: ReactNode;
  compact?: boolean;
  autoFocus?: boolean;
}

export function Scratchpad({
  value,
  onChange,
  images,
  onImagesChange,
  onSubmit,
  label,
  placeholder,
  submitLabel,
  busyLabel = "Sending…",
  busy,
  canSubmit,
  error,
  note,
  compact = false,
  autoFocus = false,
}: ScratchpadProps) {
  const generatedId = useId();
  const textareaId = `scratchpad-${generatedId}`;
  const inputId = `scratchpad-files-${generatedId}`;
  const hintId = `scratchpad-hint-${generatedId}`;
  const fileErrorId = `scratchpad-file-error-${generatedId}`;
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const valueRef = useRef(value);
  const imagesRef = useRef(images);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  valueRef.current = value;
  imagesRef.current = images;

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setFileError(null);

    const { screenshots, textFiles, unsupported } = classifyFiles(files);
    const problems: string[] = [];

    if (screenshots.length > 0 && !canAddScreenshots(imagesRef.current, screenshots)) {
      problems.push(screenshotBudgetMessage);
    } else if (screenshots.length > 0) {
      try {
        const added = await imageFiles(screenshots);
        const nextImages = [...imagesRef.current, ...added];
        imagesRef.current = nextImages;
        onImagesChange(nextImages);
      } catch (caught) {
        problems.push(
          caught instanceof RequestError
            ? caught.message
            : "That screenshot didn’t come through. Paste it again or choose the file.",
        );
      }
    }

    const textImport = await importTextFiles(textFiles, valueRef.current);
    if (textImport.value !== valueRef.current) {
      valueRef.current = textImport.value;
      onChange(textImport.value);
    }
    if (textImport.error) problems.push(textImport.error);

    if (unsupported.length) {
      problems.push(unsupportedFileMessage(unsupported[0] as File));
    }
    setFileError(problems[0] ?? null);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const files = itemFiles.length ? itemFiles : Array.from(event.clipboardData.files);
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    void addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      void addFiles(files);
      return;
    }

    const droppedText = event.dataTransfer.getData("text/plain");
    const nextValue = appendPlainText(valueRef.current, droppedText);
    if (nextValue.length > maxBodyLength) {
      setFileError("That’s too much text at once. Paste only the parts you need.");
    } else if (nextValue !== valueRef.current) {
      setFileError(null);
      valueRef.current = nextValue;
      onChange(nextValue);
    }
  };

  const submitFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <form className="scratchpad-form" onSubmit={onSubmit}>
      <div
        className={`scratchpad ${compact ? "scratchpad-compact" : ""} ${dragging ? "scratchpad-dragging" : ""}`}
        onPaste={handlePaste}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <label className="sr-only" htmlFor={textareaId}>
          {label}
        </label>
        <textarea
          className="scratchpad-textarea"
          id={textareaId}
          value={value}
          onChange={(event) => {
            setFileError(null);
            onChange(event.target.value);
          }}
          onKeyDown={submitFromKeyboard}
          placeholder={placeholder}
          maxLength={maxBodyLength}
          aria-describedby={`${hintId}${fileError ? ` ${fileErrorId}` : ""}`}
          autoFocus={autoFocus}
        />

        {dragging && (
          <div className="scratchpad-drop" aria-hidden="true">
            Drop to add
          </div>
        )}

        {images.length > 0 && (
          <div className="attachment-previews" aria-label="Attached screenshots">
            {images.map((image, index) => (
              <Screenshot
                src={image.dataUrl}
                name={image.name}
                key={`${image.name}-${index}`}
                onRemove={() =>
                  onImagesChange(images.filter((_, itemIndex) => itemIndex !== index))
                }
              />
            ))}
          </div>
        )}

        {fileError && (
          <p className="scratchpad-file-error" id={fileErrorId} role="alert">
            {fileError}
          </p>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="scratchpad-toolbar">
          <input
            id={inputId}
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,text/plain,text/markdown,.txt,.md,.markdown"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void addFiles(files);
            }}
          />
          <button
            type="button"
            className="control control-secondary scratchpad-attach"
            onClick={() => input.current?.click()}
          >
            <span className="control-glyph" aria-hidden="true">
              +
            </span>
            Add file
          </button>
          <p className="scratchpad-hint" id={hintId}>
            <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Enter</kbd> to send
          </p>
          {note && <div className="scratchpad-note">{note}</div>}
          <button
            type="submit"
            className="control control-primary scratchpad-submit"
            disabled={busy || !canSubmit}
            aria-keyshortcuts="Control+Enter Meta+Enter"
          >
            {busy ? busyLabel : submitLabel}
            {!busy && (
              <span className="control-glyph" aria-hidden="true">
                ↵
              </span>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
