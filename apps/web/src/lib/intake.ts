import {
  attachmentBudgetMessage,
  dataUrlByteLength,
  maxAttachmentBytesPerEntry,
  type AttachmentInput,
} from "@raise/protocol";

export const maxBodyLength = 20_000;
export const screenshotBudgetMessage = attachmentBudgetMessage;

const maxTextFilesPerImport = 4;
const maxTextImportBytes = 16 * 1_024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface ClassifiedFiles {
  screenshots: File[];
  textFiles: File[];
  unsupported: File[];
}

export interface TextImportResult {
  value: string;
  error: string | null;
}

export function screenshotBytes(images: Pick<AttachmentInput, "dataUrl">[]) {
  return images.reduce((total, image) => total + dataUrlByteLength(image.dataUrl), 0);
}

export function canAddScreenshots(
  existing: Pick<AttachmentInput, "dataUrl">[],
  additions: Pick<File, "size">[],
) {
  const addedBytes = additions.reduce((total, file) => total + file.size, 0);
  return screenshotBytes(existing) + addedBytes <= maxAttachmentBytesPerEntry;
}

function isControlCharacter(character: string) {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
}

function hasUnexpectedControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127;
  });
}

export function displayFilename(name: string) {
  return (
    name
      .replace(/[\\/]+/g, "_")
      .split("")
      .filter((character) => !isControlCharacter(character))
      .join("")
      .trim()
      .slice(0, 180) || "text file"
  );
}

export function classifyFiles(files: File[]): ClassifiedFiles {
  const screenshots: File[] = [];
  const textFiles: File[] = [];
  const unsupported: File[] = [];

  for (const file of files) {
    if (imageTypes.has(file.type)) {
      screenshots.push(file);
    } else if (file.type.startsWith("text/") || /\.(txt|md|markdown)$/i.test(file.name)) {
      textFiles.push(file);
    } else {
      unsupported.push(file);
    }
  }

  return { screenshots, textFiles, unsupported };
}

export function appendPlainText(current: string, addition: string) {
  const next = addition.trim();
  if (!next) return current;
  return current.trimEnd() ? `${current.trimEnd()}\n\n${next}` : next;
}

export async function importTextFiles(
  files: File[],
  currentValue: string,
): Promise<TextImportResult> {
  if (!files.length) return { value: currentValue, error: null };
  if (files.length > maxTextFilesPerImport) {
    return { value: currentValue, error: "Drop up to four text files at a time." };
  }
  if (files.reduce((total, file) => total + file.size, 0) > maxTextImportBytes) {
    return {
      value: currentValue,
      error: "Those files are too long. Paste the parts you need.",
    };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const imports: string[] = [];

  for (const file of files) {
    const filename = displayFilename(file.name);
    let contents: string;
    try {
      contents = decoder.decode(await file.arrayBuffer()).trim();
    } catch {
      return {
        value: currentValue,
        error: `Couldn’t read ${filename} as plain text. Paste its text instead.`,
      };
    }
    if (!contents) {
      return { value: currentValue, error: `${filename} is empty.` };
    }
    if (hasUnexpectedControlCharacter(contents)) {
      return {
        value: currentValue,
        error: `Couldn’t read ${filename} as plain text. Paste its text instead.`,
      };
    }
    imports.push(`[Imported from: ${filename}]\n${contents}`);
  }

  const value = appendPlainText(currentValue, imports.join("\n\n"));
  if (value.length > maxBodyLength) {
    return { value: currentValue, error: "That text is too long. Paste the parts you need." };
  }
  return { value, error: null };
}

export function unsupportedFileMessage(file: File) {
  const filename = displayFilename(file.name);
  if (/\.(pdf|docx?)$/i.test(filename)) {
    return `Couldn’t add ${filename}. Paste the relevant text or export it as .txt or .md.`;
  }
  return `Couldn’t add ${filename}. Paste its text instead.`;
}
