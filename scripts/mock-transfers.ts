// The mock agent's side of moving files: the transfer methods of docs/protocol.md, served from the
// fixture tree and from a throwaway uploads area, with the limits and the clean-up the desktop app
// is asked to have.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FsDownloadResult,
  FsTransferInfo,
  FsUploadBeginResult,
  FsUploadChunkResult,
  FsUploadEndResult,
  UploadConflictChoice,
} from "../shared/protocol.ts";
import {
  cleanUploadName,
  isValidFileName,
  keepBothName,
  numberedUploadName,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_MAX_BYTES,
  UPLOAD_IDLE_MS,
  UPLOAD_RESULT_KEPT_MS,
  UPLOADS_AREA_KEPT_MS,
} from "../shared/transfers.ts";
import { failure, FsFailure, mtimeOf, resolveInFixture } from "./mock-files.ts";

type Upload = {
  id: string;
  /** The real directory the file ends up in, where its temporary sibling is too. */
  directory: string;
  /** That directory as the client named it, which is how the result names it. */
  shownDirectory: string;
  temporary: string;
  name: string;
  size: number;
  received: number;
  onConflict: UploadConflictChoice;
  toUploadsArea: boolean;
  touchedAt: number;
};

type Options = {
  /** How long an upload may sit untouched; the protocol's 15 minutes unless a test shortens it. */
  idleMs?: number;
  log?: (line: string) => void;
};

const SWEEP_EVERY_MS = 30_000;
const CONFLICT_CHOICES: readonly string[] = ["fail", "replace", "rename"];
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function wholeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FsFailure("bad_request", `${name} must be a whole number of bytes`);
  }
  return value;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The local date, which names the day's directory in the uploads area. */
function today(): string {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

export function createTransferMethods(root: string, options: Options = {}) {
  const idleMs = options.idleMs ?? UPLOAD_IDLE_MS;
  const log = options.log ?? (() => {});
  const uploadsRoot = realpathSync(mkdtempSync(join(tmpdir(), "hako-mock-uploads-")));
  const uploads = new Map<string, Upload>();
  const finished = new Map<string, { result: FsUploadEndResult; at: number }>();

  function discard(upload: Upload): void {
    uploads.delete(upload.id);
    rmSync(upload.temporary, { force: true });
  }

  /** Removes what the uploads area has kept for longer than a week, and the days left empty. */
  function sweepUploadsArea(now: number): void {
    for (const day of readdirSync(uploadsRoot)) {
      const directory = join(uploadsRoot, day);
      try {
        for (const name of readdirSync(directory)) {
          const file = join(directory, name);
          const pending = [...uploads.values()].some((upload) => upload.temporary === file);
          if (!pending && now - statSync(file).mtimeMs > UPLOADS_AREA_KEPT_MS) {
            rmSync(file, { force: true });
          }
        }
        if (readdirSync(directory).length === 0) rmdirSync(directory);
      } catch {
        // Something else is tidying up, or it is not a directory: leave it.
      }
    }
  }

  function sweep(): void {
    const now = Date.now();
    for (const upload of [...uploads.values()]) {
      if (now - upload.touchedAt <= idleMs) continue;
      log(`gave up on the upload of ${upload.name} after ${upload.received} bytes`);
      discard(upload);
    }
    for (const [id, kept] of finished) {
      if (now - kept.at > UPLOAD_RESULT_KEPT_MS) finished.delete(id);
    }
    sweepUploadsArea(now);
  }

  const sweeper = setInterval(sweep, Math.min(SWEEP_EVERY_MS, idleMs));
  sweeper.unref();

  function uploadFor(params: Record<string, unknown>): Upload {
    const upload = uploads.get(String(params.upload_id ?? ""));
    if (!upload) {
      throw new FsFailure("not_found", "No such upload: it was cancelled, or left for too long");
    }
    upload.touchedAt = Date.now();
    return upload;
  }

  /** Gives the temporary file its final name without ever replacing a file that is there. */
  function placeUnder(upload: Upload, candidates: (attempt: number) => string): string {
    for (let attempt = 1; ; attempt++) {
      const name = candidates(attempt);
      try {
        linkSync(upload.temporary, join(upload.directory, name));
        rmSync(upload.temporary, { force: true });
        return name;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  const methods = {
    "fs.transfer_info": (): FsTransferInfo => ({
      max_bytes: TRANSFER_MAX_BYTES,
      chunk_bytes: TRANSFER_CHUNK_BYTES,
    }),

    "fs.download": (params: Record<string, unknown>): FsDownloadResult => {
      const offset = wholeNumber(params.offset, "offset");
      const length = wholeNumber(params.length, "length");
      if (length < 1 || length > TRANSFER_CHUNK_BYTES) {
        throw new FsFailure("bad_request", `length must be 1 to ${TRANSFER_CHUNK_BYTES}`);
      }
      const { expected_size: expectedSize, expected_mtime: expectedMtime } = params;
      const first = expectedSize === null && expectedMtime === null;
      if (!first && (typeof expectedSize !== "number" || typeof expectedMtime !== "number")) {
        throw new FsFailure(
          "bad_request",
          "expected_size and expected_mtime must both be numbers, or both be null",
        );
      }
      const file = resolveInFixture(root, params.path);
      const path = String(params.path);
      let descriptor: number | null = null;
      try {
        const before = statSync(file);
        if (before.isDirectory()) throw new FsFailure("is_a_directory", `${path} is a directory`);
        if (!before.isFile()) throw new FsFailure("failed", `${path} is not a regular file`);
        descriptor = openSync(file, "r");
        const stats = fstatSync(descriptor);
        if (stats.size > TRANSFER_MAX_BYTES) {
          throw new FsFailure(
            "too_large",
            `${path} is ${stats.size} bytes, over the limit of ${TRANSFER_MAX_BYTES}`,
          );
        }
        if (!first && (stats.size !== expectedSize || mtimeOf(stats) !== expectedMtime)) {
          throw new FsFailure("conflict", `${path} changed on the Mac while it was being read`);
        }
        if (offset > stats.size) {
          throw new FsFailure("bad_request", `offset is beyond the ${stats.size} bytes of ${path}`);
        }
        const bytes = Buffer.alloc(Math.min(length, stats.size - offset));
        let read = 0;
        while (read < bytes.length) {
          const count = readSync(descriptor, bytes, read, bytes.length - read, offset + read);
          if (count === 0) break;
          read += count;
        }
        const after = fstatSync(descriptor);
        if (read < bytes.length || after.size !== stats.size || mtimeOf(after) !== mtimeOf(stats)) {
          throw new FsFailure("conflict", `${path} changed on the Mac while it was being read`);
        }
        return { data: bytes.toString("base64"), size: stats.size, mtime: mtimeOf(stats) };
      } catch (error) {
        throw failure(error, path);
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
    },

    "fs.upload_begin": (params: Record<string, unknown>): FsUploadBeginResult => {
      const destination = params.destination as { kind?: unknown; path?: unknown } | null;
      if (typeof destination !== "object" || destination === null) {
        throw new FsFailure("bad_request", "destination must be an object");
      }
      if (destination.kind !== "dir" && destination.kind !== "uploads") {
        throw new FsFailure("bad_request", 'destination.kind must be "dir" or "uploads"');
      }
      const { name } = params;
      if (!isValidFileName(name)) {
        throw new FsFailure("bad_request", "name must be one file name of at most 255 bytes");
      }
      const size = wholeNumber(params.size, "size");
      if (size > TRANSFER_MAX_BYTES) {
        throw new FsFailure(
          "too_large",
          `${name} is ${size} bytes, over the limit of ${TRANSFER_MAX_BYTES}`,
        );
      }
      const onConflict = params.on_conflict ?? "fail";
      if (typeof onConflict !== "string" || !CONFLICT_CHOICES.includes(onConflict)) {
        throw new FsFailure("bad_request", 'on_conflict must be "fail", "replace" or "rename"');
      }

      const toUploadsArea = destination.kind === "uploads";
      let directory: string;
      let shownDirectory: string;
      if (toUploadsArea) {
        directory = join(uploadsRoot, today());
        shownDirectory = directory;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      } else {
        directory = resolveInFixture(root, destination.path);
        shownDirectory = String(destination.path);
        try {
          if (!statSync(directory).isDirectory()) {
            throw new FsFailure("not_a_directory", `${shownDirectory} is not a directory`);
          }
          const taken = exists(join(directory, name));
          if (taken && onConflict === "fail") {
            throw new FsFailure("conflict", `${name} already exists in ${shownDirectory}`);
          }
          if (taken && onConflict === "replace" && lstatSync(join(directory, name)).isDirectory()) {
            throw new FsFailure("is_a_directory", `${name} in ${shownDirectory} is a directory`);
          }
        } catch (error) {
          throw failure(error, shownDirectory);
        }
      }

      const id = randomBytes(12).toString("base64url");
      const temporary = join(directory, `.hako-upload-${id}`);
      try {
        closeSync(openSync(temporary, "wx", 0o600));
      } catch (error) {
        throw failure(error, shownDirectory);
      }
      uploads.set(id, {
        id,
        directory,
        shownDirectory,
        temporary,
        name,
        size,
        received: 0,
        onConflict: onConflict as UploadConflictChoice,
        toUploadsArea,
        touchedAt: Date.now(),
      });
      return { upload_id: id };
    },

    "fs.upload_chunk": (params: Record<string, unknown>): FsUploadChunkResult => {
      const upload = uploadFor(params);
      const offset = wholeNumber(params.offset, "offset");
      const { data } = params;
      if (typeof data !== "string" || !BASE64.test(data)) {
        throw new FsFailure("bad_request", "data must be base64 with padding");
      }
      const bytes = Buffer.from(data, "base64");
      if (bytes.length < 1 || bytes.length > TRANSFER_CHUNK_BYTES) {
        throw new FsFailure("bad_request", `a piece holds 1 to ${TRANSFER_CHUNK_BYTES} bytes`);
      }
      // A piece that is already here is one whose answer got lost on the way back.
      if (offset + bytes.length <= upload.received) return { received: upload.received };
      if (offset !== upload.received) {
        throw new FsFailure(
          "bad_request",
          `the next piece starts at ${upload.received}, not at ${offset}`,
        );
      }
      if (offset + bytes.length > upload.size) {
        throw new FsFailure(
          "bad_request",
          `more than the ${upload.size} bytes that were announced`,
        );
      }
      try {
        const descriptor = openSync(upload.temporary, "r+");
        try {
          writeSync(descriptor, bytes, 0, bytes.length, offset);
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        discard(upload);
        throw failure(error, upload.shownDirectory);
      }
      upload.received += bytes.length;
      return { received: upload.received };
    },

    "fs.upload_end": (params: Record<string, unknown>): FsUploadEndResult => {
      const kept = finished.get(String(params.upload_id ?? ""));
      if (kept) return kept.result;
      const upload = uploadFor(params);
      if (upload.received !== upload.size) {
        throw new FsFailure(
          "bad_request",
          `${upload.received} of ${upload.size} bytes have arrived so far`,
        );
      }
      try {
        if (statSync(upload.temporary).size !== upload.size) {
          throw new FsFailure("failed", `${upload.name} did not arrive whole`);
        }
        let name: string;
        if (upload.toUploadsArea) {
          const clean = cleanUploadName(upload.name);
          name = placeUnder(upload, (attempt) =>
            attempt === 1 ? clean : numberedUploadName(clean, attempt),
          );
        } else if (upload.onConflict === "replace") {
          const target = join(upload.directory, upload.name);
          let mode = 0o644;
          try {
            const existing = lstatSync(target);
            if (existing.isDirectory()) {
              throw new FsFailure(
                "is_a_directory",
                `${upload.name} in ${upload.shownDirectory} is a directory`,
              );
            }
            if (existing.isFile()) mode = existing.mode & 0o777;
          } catch (error) {
            if (error instanceof FsFailure) throw error;
          }
          chmodSync(upload.temporary, mode);
          renameSync(upload.temporary, target);
          name = upload.name;
        } else if (upload.onConflict === "rename") {
          chmodSync(upload.temporary, 0o644);
          name = placeUnder(upload, (attempt) =>
            attempt === 1 ? upload.name : keepBothName(upload.name, attempt),
          );
        } else {
          chmodSync(upload.temporary, 0o644);
          try {
            linkSync(upload.temporary, join(upload.directory, upload.name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            throw new FsFailure(
              "conflict",
              `${upload.name} already exists in ${upload.shownDirectory}`,
            );
          }
          name = upload.name;
        }
        const stats = statSync(join(upload.directory, name));
        const result: FsUploadEndResult = {
          path: upload.shownDirectory === "/" ? `/${name}` : `${upload.shownDirectory}/${name}`,
          name,
          size: stats.size,
          mtime: mtimeOf(stats),
        };
        finished.set(upload.id, { result, at: Date.now() });
        return result;
      } catch (error) {
        throw failure(error, upload.shownDirectory);
      } finally {
        discard(upload);
      }
    },

    "fs.upload_cancel": (params: Record<string, unknown>) => {
      const upload = uploads.get(String(params.upload_id ?? ""));
      if (upload) discard(upload);
      return {};
    },
  };

  return {
    methods,
    uploadsRoot,
    /** Leaves nothing behind: the unfinished uploads' temporary files, and the uploads area. */
    dispose(): void {
      clearInterval(sweeper);
      for (const upload of [...uploads.values()]) discard(upload);
      rmSync(uploadsRoot, { recursive: true, force: true });
    },
  };
}
