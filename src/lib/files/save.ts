// Saving an edited file without losing either side's work: the text on this device, or a change
// made on the Mac since the file was read.

import type { FsWriteParams, FsWriteResult } from "../../../shared/protocol.ts";

export type SaveOutcome =
  | { kind: "saved"; mtime: number; size: number }
  /** The file changed on the Mac since it was read. Nothing was written. */
  | { kind: "conflict" }
  | { kind: "failed"; code: string; message: string }
  /** Another save of this file is still on its way. */
  | { kind: "busy" };

export type WriteFile = (params: FsWriteParams) => Promise<FsWriteResult>;

/**
 * Remembers which version of a file the text on screen is based on, and sends every save with it,
 * so the Mac can refuse a save that would undo a change it knows about and we do not.
 */
export class SaveGuard {
  private readonly path: string;
  private readonly write: WriteFile;
  private baseMtime: number;
  private saving = false;

  constructor(path: string, mtime: number, write: WriteFile) {
    this.path = path;
    this.baseMtime = mtime;
    this.write = write;
  }

  get mtime(): number {
    return this.baseMtime;
  }

  /** Called after the file was read again: the text on screen is now based on that version. */
  rebase(mtime: number): void {
    this.baseMtime = mtime;
  }

  /**
   * `overwrite` is the owner's answer to a conflict: write regardless of what the Mac has now.
   * Without it a changed file comes back as a conflict, and the base version stays what it was, so
   * that saving again asks again instead of slipping through.
   */
  async save(content: string, options: { overwrite?: boolean } = {}): Promise<SaveOutcome> {
    if (this.saving) return { kind: "busy" };
    this.saving = true;
    try {
      const result = await this.write({
        path: this.path,
        content,
        expected_mtime: options.overwrite ? null : this.baseMtime,
      });
      this.baseMtime = result.mtime;
      return { kind: "saved", mtime: result.mtime, size: result.size };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "conflict") return { kind: "conflict" };
      return {
        kind: "failed",
        code: typeof code === "string" ? code : "failed",
        message: error instanceof Error ? error.message : "",
      };
    } finally {
      this.saving = false;
    }
  }
}

export type LineEnding = "\n" | "\r\n";

/**
 * The line ending a file is saved with. The editor holds lines, not line endings, so a file that
 * came with `CR LF` has to get them back, or saving one changed word would rewrite every line.
 */
export function detectLineEnding(content: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    if (index > 0 && content.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}
