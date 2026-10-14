// The mock agent's file operations of round 1 in docs/protocol.md: real changes to the fixture tree
// and to nothing outside it, with a "Trash" directory inside the tree standing in for the Mac's,
// and zips made and read with JSZip.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import JSZip from "jszip";
import { isValidPath, nameProblem } from "../shared/files.ts";
import {
  ARCHIVE_KEPT_MS,
  BUILD_OUTPUT_MARKERS,
  EXTRACT_MAX_BYTES,
  EXTRACT_MAX_ENTRIES,
  extractedName,
  HEAVY_DIRECTORIES,
  keepBothNameFor,
  MAX_SOURCES,
  OPERATION_DEADLINE_MS,
} from "../shared/operations.ts";
import type {
  FsArchiveResult,
  FsConflictChoice,
  FsCreateFileResult,
  FsExtractResult,
  FsItemResult,
  FsItemResults,
  FsRenameResult,
  FsStatResult,
} from "../shared/protocol.ts";
import { TRANSFER_MAX_BYTES } from "../shared/transfers.ts";
import { failure, FsFailure, mtimeOf, resolveInFixture } from "./mock-files.ts";

/** An `FsFailure` that also says which limit was exceeded, as `too_large` from these methods does. */
export class LimitFailure extends FsFailure {
  readonly limit: number;

  constructor(message: string, limit: number) {
    super("too_large", message);
    this.limit = limit;
  }
}

type Options = {
  /** The directories of the workspace's folders, which may not go to the Trash. */
  folderDirectories: () => string[];
};

const CHOICES: readonly string[] = ["fail", "rename", "replace"];
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const nameOf = (path: string) => (path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1));
const parentOfPath = (path: string) => {
  const cut = path.lastIndexOf("/");
  return cut === 0 ? "/" : path.slice(0, cut);
};
const joinShown = (directory: string, name: string) =>
  directory === "/" ? `/${name}` : `${directory}/${name}`;
const within = (directory: string, path: string) =>
  path === directory || path.startsWith(`${directory}/`);

function checkName(name: unknown): string {
  if (typeof name !== "string" || nameProblem(name) !== null) {
    throw new FsFailure("bad_request", "A name is 1 to 255 bytes, not . or .., without / or NUL");
  }
  return name;
}

function entryAt(path: string): Stats | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

/** The first keep-both name that nothing in `directory` has, as the disk compares names. */
function freeName(directory: string, name: string, isDirectory: boolean): string {
  if (entryAt(join(directory, name)) === undefined) return name;
  for (let n = 2; ; n++) {
    const candidate = keepBothNameFor(name, isDirectory, n);
    if (entryAt(join(directory, candidate)) === undefined) return candidate;
  }
}

export function createOperationMethods(root: string, options: Options) {
  const trash = join(root, ".Trash");
  const archives = join(root, ".hako", "archives");

  /**
   * Where a path is, without following a link at its end: its directory's real location, which
   * must be inside the fixture, joined with its own name.
   */
  function locate(path: unknown): string {
    if (!isValidPath(path)) {
      throw new FsFailure("bad_request", "path must be an absolute, normalised path");
    }
    if (path === "/" || path === root) return resolveInFixture(root, path);
    return join(resolveInFixture(root, parentOfPath(path)), nameOf(path));
  }

  function directoryAt(path: unknown): string {
    const real = resolveInFixture(root, path);
    try {
      if (!statSync(real).isDirectory()) {
        throw new FsFailure("not_a_directory", `${String(path)} is not a directory`);
      }
    } catch (error) {
      throw failure(error, String(path));
    }
    return real;
  }

  function copyOrMove(params: Record<string, unknown>, moving: boolean): FsItemResults {
    const { sources } = params;
    // A malformed path fails only its own item, below.
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_SOURCES) {
      throw new FsFailure("bad_request", `sources must be 1 to ${MAX_SOURCES} absolute paths`);
    }
    const onConflict = (params.on_conflict ?? "fail") as FsConflictChoice;
    if (!CHOICES.includes(onConflict)) {
      throw new FsFailure("bad_request", 'on_conflict must be "fail", "rename" or "replace"');
    }
    const shownDestination = String(params.destination);
    const destination = directoryAt(params.destination);
    const started = Date.now();

    return {
      results: (sources as unknown[]).map((given): FsItemResult => {
        const source = String(given);
        if (!isValidPath(given)) {
          return {
            source,
            path: null,
            error: {
              code: "bad_request",
              message: `${source} is not an absolute, normalised path`,
            },
          };
        }
        if (Date.now() - started > OPERATION_DEADLINE_MS) {
          return {
            source,
            path: null,
            error: { code: "failed", message: "Stopped after 240 seconds" },
          };
        }
        let target: string | null = null;
        let made = false;
        try {
          const from = locate(source);
          const own = lstatSync(from);
          const isDirectory = own.isDirectory();
          if (isDirectory && within(realpathSync(from), destination)) {
            throw new FsFailure(
              "bad_request",
              `${source} can’t go into itself or into a folder inside it`,
            );
          }
          const home = realpathSync(dirname(from)) === destination;
          if (moving && home) return { source, path: source, error: null };

          let name = nameOf(source);
          const existing = entryAt(join(destination, name));
          if (existing !== undefined) {
            if (onConflict === "fail") {
              throw new FsFailure("conflict", `${name} already exists in ${shownDestination}`);
            }
            if (onConflict === "rename") {
              name = freeName(destination, name, isDirectory);
            } else if (home) {
              throw new FsFailure("conflict", `${name} can’t replace itself`);
            } else if (existing.isDirectory() || isDirectory) {
              throw new FsFailure(
                "conflict",
                existing.isDirectory()
                  ? `${name} in ${shownDestination} is a folder, which is never replaced`
                  : `A folder can’t replace the file ${name} in ${shownDestination}`,
              );
            } else {
              rmSync(join(destination, name));
            }
          }
          target = join(destination, name);
          if (moving) {
            renameSync(from, target);
          } else {
            made = true;
            cpSync(from, target, {
              recursive: true,
              verbatimSymlinks: true,
              preserveTimestamps: true,
              errorOnExist: true,
              force: false,
            });
          }
          return { source, path: joinShown(shownDestination, name), error: null };
        } catch (error) {
          // Whatever a copy that failed half-way made is taken away again.
          if (made && target !== null) rmSync(target, { recursive: true, force: true });
          const { code, message } = failure(error, source);
          return { source, path: null, error: { code, message } };
        }
      }),
    };
  }

  /** Adds a directory's contents to a zip, and counts the heavy directories left out. */
  function addTree(
    zip: JSZip,
    directory: string,
    prefix: string,
    skipHeavy: boolean,
    budget: { bytes: number; skipped: number },
  ): void {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(directory, name);
      const inZip = `${prefix}${name}`;
      try {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) {
          zip.file(inZip, readlinkSync(path), {
            unixPermissions: S_IFLNK | 0o777,
            date: stats.mtime,
          });
        } else if (stats.isDirectory()) {
          const heavy =
            HEAVY_DIRECTORIES.includes(name) ||
            (name === "target" &&
              BUILD_OUTPUT_MARKERS.some((marker) => entryAt(join(path, marker)) !== undefined));
          if (skipHeavy && heavy) {
            budget.skipped++;
            continue;
          }
          readdirSync(path);
          zip.folder(inZip);
          addTree(zip, path, `${inZip}/`, skipHeavy, budget);
        } else if (stats.isFile()) {
          budget.bytes += stats.size;
          if (budget.bytes > TRANSFER_MAX_BYTES * 4) {
            throw new LimitFailure(
              `The zip would be over the ${TRANSFER_MAX_BYTES}-byte limit`,
              TRANSFER_MAX_BYTES,
            );
          }
          zip.file(inZip, readFileSync(path), {
            unixPermissions: stats.mode,
            date: stats.mtime,
          });
        }
      } catch (error) {
        if (error instanceof FsFailure) throw error;
        // Unreadable entries are left out without a word.
      }
    }
  }

  const methods = {
    "fs.stat": (params: Record<string, unknown>): FsStatResult => {
      const path = locate(params.path);
      try {
        const stats = lstatSync(path);
        const kind = stats.isSymbolicLink()
          ? "symlink"
          : stats.isDirectory()
            ? "dir"
            : stats.isFile()
              ? "file"
              : "other";
        return {
          kind,
          size: kind === "dir" ? 0 : stats.size,
          mtime: mtimeOf(stats),
          target: kind === "symlink" ? readlinkSync(path) : null,
        };
      } catch (error) {
        throw failure(error, String(params.path));
      }
    },

    "fs.create_file": (params: Record<string, unknown>): FsCreateFileResult => {
      const { path } = params;
      if (!isValidPath(path) || path === "/") {
        throw new FsFailure("bad_request", "path must be an absolute, normalised path");
      }
      const name = checkName(nameOf(path));
      const parent = directoryAt(parentOfPath(path));
      try {
        closeSync(openSync(join(parent, name), "wx"));
        return { mtime: mtimeOf(statSync(join(parent, name))) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new FsFailure("conflict", `${path} already exists`);
        }
        throw failure(error, path);
      }
    },

    "fs.rename": (params: Record<string, unknown>): FsRenameResult => {
      const { path } = params;
      const name = checkName(params.name);
      if (!isValidPath(path) || path === "/") {
        throw new FsFailure("bad_request", "The root directory keeps its name");
      }
      const from = locate(path);
      try {
        const own = lstatSync(from);
        if (from === root) {
          throw new FsFailure("bad_request", "The home directory keeps its name");
        }
        const to = join(dirname(from), name);
        const there = entryAt(to);
        // A change of letter case only finds the item itself under its new name.
        if (there !== undefined && !(there.ino === own.ino && there.dev === own.dev)) {
          throw new FsFailure("conflict", `${name} already exists in ${parentOfPath(path)}`);
        }
        renameSync(from, to);
        return { path: joinShown(parentOfPath(path), name) };
      } catch (error) {
        throw failure(error, path);
      }
    },

    "fs.copy": (params: Record<string, unknown>) => copyOrMove(params, false),
    "fs.move": (params: Record<string, unknown>) => copyOrMove(params, true),

    "fs.trash": (params: Record<string, unknown>): FsItemResults => {
      const { paths } = params;
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_SOURCES) {
        throw new FsFailure("bad_request", `paths must be 1 to ${MAX_SOURCES} absolute paths`);
      }
      mkdirSync(trash, { recursive: true });
      const protectedPaths = new Set(["/", root, ...options.folderDirectories()]);
      return {
        results: (paths as unknown[]).map((given): FsItemResult => {
          const source = String(given);
          try {
            const from = locate(given);
            if (protectedPaths.has(source) || protectedPaths.has(realpathSync(from))) {
              throw new FsFailure(
                "bad_request",
                `${source} is the home directory or a folder’s own directory`,
              );
            }
            const own = lstatSync(from);
            const name = freeName(trash, nameOf(source), own.isDirectory());
            renameSync(from, join(trash, name));
            return { source, path: join(trash, name), error: null };
          } catch (error) {
            const { code, message } = failure(error, source);
            return { source, path: null, error: { code, message } };
          }
        }),
      };
    },

    "fs.archive": async (params: Record<string, unknown>): Promise<FsArchiveResult> => {
      const shown = String(params.path);
      const directory = resolveInFixture(root, params.path);
      const skipHeavy = params.skip_heavy !== false;
      try {
        if (!statSync(directory).isDirectory()) {
          throw new FsFailure("bad_request", `${shown} is a file; download it as it is`);
        }
      } catch (error) {
        throw failure(error, shown);
      }
      const zip = new JSZip();
      const budget = { bytes: 0, skipped: 0 };
      addTree(zip, directory, "", skipHeavy, budget);
      const bytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        platform: "UNIX",
      });
      if (bytes.length > TRANSFER_MAX_BYTES) {
        throw new LimitFailure(
          `The zip would be over the ${TRANSFER_MAX_BYTES}-byte limit`,
          TRANSFER_MAX_BYTES,
        );
      }
      const home = join(archives, randomBytes(8).toString("hex"));
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const name = `${nameOf(shown) === "/" ? "root" : nameOf(shown)}.zip`;
      const path = join(home, name);
      writeFileSync(path, bytes, { mode: 0o600 });
      setTimeout(() => rmSync(home, { recursive: true, force: true }), ARCHIVE_KEPT_MS).unref();
      return { path, name, size: bytes.length, skipped: budget.skipped };
    },

    "fs.extract": async (params: Record<string, unknown>): Promise<FsExtractResult> => {
      const shownZip = String(params.path);
      const shownDestination = String(params.destination);
      const file = resolveInFixture(root, params.path);
      const destination = directoryAt(params.destination);
      let zip: JSZip;
      try {
        if (!statSync(file).isFile()) throw new FsFailure("bad_request", `${shownZip} is no file`);
        zip = await JSZip.loadAsync(readFileSync(file), { createFolders: false });
      } catch (error) {
        if (error instanceof FsFailure) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (/encrypt/i.test(message)) {
          throw new FsFailure("bad_request", `${nameOf(shownZip)} is encrypted`);
        }
        if ((error as NodeJS.ErrnoException).code) throw failure(error, shownZip);
        throw new FsFailure("failed", `${nameOf(shownZip)} can’t be read as a zip: ${message}`);
      }

      type Planned = { path: string; entry: JSZip.JSZipObject; link: boolean };
      const planned: Planned[] = [];
      let total = 0;
      for (const entry of Object.values(zip.files)) {
        // JSZip tidies `..` out of the names it reads; what the zip really says is kept here.
        const original =
          (entry as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
        const name = original.replace(/\/+$/, "");
        const segments = name.split("/");
        if (segments[0] === "__MACOSX" || segments.at(-1) === ".DS_Store") continue;
        if (name.startsWith("/") || name.includes("\\") || name.includes("\0")) {
          throw new FsFailure("bad_request", `${original} would land outside the new folder`);
        }
        if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
          throw new FsFailure("bad_request", `${original} would land outside the new folder`);
        }
        const mode = entry.unixPermissions;
        const link = typeof mode === "number" && (mode & S_IFMT) === S_IFLNK;
        const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
          ?.uncompressedSize;
        total += typeof size === "number" ? size : 0;
        planned.push({ path: name, entry, link });
      }
      if (planned.length > EXTRACT_MAX_ENTRIES) {
        throw new LimitFailure(
          `${nameOf(shownZip)} holds ${planned.length} entries, over ${EXTRACT_MAX_ENTRIES}`,
          EXTRACT_MAX_ENTRIES,
        );
      }
      if (total > EXTRACT_MAX_BYTES) {
        throw new LimitFailure(
          `${nameOf(shownZip)} unpacks to ${total} bytes, over ${EXTRACT_MAX_BYTES}`,
          EXTRACT_MAX_BYTES,
        );
      }

      // A zip whose every entry is under one folder unpacks that folder's contents, named after it,
      // so the zip of a folder comes back as that folder and not as a folder inside another.
      const tops = new Set(planned.map((item) => item.path.split("/")[0]));
      const [top] = tops;
      const single =
        tops.size === 1 &&
        planned.every((item) => item.path !== top || item.entry.dir) &&
        planned.some((item) => item.path.startsWith(`${top}/`));
      const placed = planned
        .map((item) => ({ ...item, path: single ? item.path.slice(top.length + 1) : item.path }))
        .filter((item) => item.path !== "");
      for (const { path, entry, link } of placed) {
        if (!link) continue;
        const target = await entry.async("string");
        const landing = posix.normalize(posix.join(posix.dirname(path), target));
        if (target.startsWith("/") || landing === ".." || landing.startsWith("../")) {
          throw new FsFailure("bad_request", `${entry.name} points outside the new folder`);
        }
      }

      const base = single ? top : extractedName(nameOf(shownZip));
      const folderName = freeName(destination, base, true);
      const folder = join(destination, folderName);
      try {
        mkdirSync(folder);
        for (const { path, entry, link } of placed) {
          const target = join(folder, path);
          if (entry.dir) {
            mkdirSync(target, { recursive: true });
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          if (link) {
            symlinkSync(await entry.async("string"), target);
          } else {
            const mode = entry.unixPermissions;
            writeFileSync(target, await entry.async("nodebuffer"), {
              mode: typeof mode === "number" && mode & 0o777 ? mode & 0o777 : 0o644,
            });
          }
        }
      } catch (error) {
        rmSync(folder, { recursive: true, force: true });
        throw failure(error, shownDestination);
      }
      return { path: joinShown(shownDestination, folderName), entries: placed.length };
    },
  };

  return { methods, trash };
}
