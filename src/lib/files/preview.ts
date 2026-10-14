// Which files open as a preview, drawn in the browser from the file's bytes.

export type PreviewKind = "pdf" | "docx" | "sheet" | "slides";

const KINDS: Record<string, PreviewKind> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "sheet",
  xls: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  pptx: "slides",
};

export function previewKindOf(name: string): PreviewKind | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** True for a table that is text, which also opens in the editor. */
export function isDelimitedText(name: string): boolean {
  return /\.(csv|tsv)$/i.test(name);
}

/** The most rows of one sheet that are shown. */
export const SHEET_ROW_LIMIT = 2_000;
/** The most columns of one sheet that are shown. */
export const SHEET_COLUMN_LIMIT = 200;

export function isZip(name: string): boolean {
  return /\.zip$/i.test(name);
}
