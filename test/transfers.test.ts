import assert from "node:assert/strict";
import { test } from "node:test";
import type { FsUploadEndResult } from "../shared/protocol.ts";
import {
  cleanUploadName,
  escapePathForPaste,
  isValidFileName,
  keepBothName,
  numberedUploadName,
  pieceCount,
  pieceLength,
} from "../shared/transfers.ts";
import { decodeBase64, encodeBase64 } from "../src/lib/transfers/base64.ts";
import {
  download,
  type Rpc,
  TransferFailure,
  type TransferHooks,
  upload,
  type UploadSource,
} from "../src/lib/transfers/engine.ts";
import { planImage, sniffImageType, withExtension } from "../src/lib/transfers/image-plan.ts";
import { type Transfer, TransferQueue } from "../src/lib/transfers/queue.ts";

const LIMITS = { maxBytes: 40, chunkBytes: 4 };

const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (parts: Uint8Array[]) => Buffer.concat(parts).toString("utf8");
const failure = (code: string, message = code) => Object.assign(new Error(message), { code });

function sourceOf(text: string): UploadSource {
  const bytes = bytesOf(text);
  return { size: bytes.length, read: async (start, end) => bytes.subarray(start, end) };
}

type Call = { method: string; params: Record<string, unknown> };

/** A Mac with a few files, which follows the rules of the transfer methods. */
function fakeMac(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, bytesOf(text)]),
  );
  const mtimes = new Map([...files.keys()].map((path) => [path, 1000]));
  const uploads = new Map<
    string,
    { path: string; name: string; size: number; mode: string; received: Uint8Array }
  >();
  const mac = {
    files,
    calls: [] as Call[],
    /** Called before each request is answered; what it throws is the answer. */
    before: (_call: Call): void | Promise<void> => {},
    rewrite(path: string, text: string) {
      files.set(path, bytesOf(text));
      mtimes.set(path, (mtimes.get(path) ?? 1000) + 1);
    },
    text: (path: string) => Buffer.from(files.get(path) ?? []).toString("utf8"),
    rpc: (async (method: string, params: Record<string, unknown>) => {
      const call = { method, params };
      mac.calls.push(call);
      await mac.before(call);
      switch (method) {
        case "fs.download": {
          const file = files.get(params.path as string);
          if (!file) throw failure("not_found");
          const mtime = mtimes.get(params.path as string)!;
          const first = params.expected_size === null;
          if (!first && (params.expected_size !== file.length || params.expected_mtime !== mtime)) {
            throw failure("conflict");
          }
          const offset = params.offset as number;
          const piece = file.subarray(offset, offset + (params.length as number));
          return { data: encodeBase64(piece), size: file.length, mtime };
        }
        case "fs.upload_begin": {
          const directory = (params.destination as { path: string }).path;
          const path = `${directory}/${params.name}`;
          if (files.has(path) && params.on_conflict === "fail") throw failure("conflict");
          const id = `up-${uploads.size + 1}`;
          uploads.set(id, {
            path,
            name: params.name as string,
            size: params.size as number,
            mode: params.on_conflict as string,
            received: new Uint8Array(0),
          });
          return { upload_id: id };
        }
        case "fs.upload_chunk": {
          const state = uploads.get(params.upload_id as string);
          if (!state) throw failure("not_found");
          const piece = decodeBase64(params.data as string);
          const offset = params.offset as number;
          if (offset + piece.length <= state.received.length) {
            return { received: state.received.length };
          }
          if (offset !== state.received.length) throw failure("bad_request");
          const joined = new Uint8Array(state.received.length + piece.length);
          joined.set(state.received);
          joined.set(piece, state.received.length);
          state.received = joined;
          return { received: state.received.length };
        }
        case "fs.upload_end": {
          const state = uploads.get(params.upload_id as string);
          if (!state) throw failure("not_found");
          if (state.received.length !== state.size) throw failure("bad_request");
          uploads.delete(params.upload_id as string);
          let { path, name } = state;
          for (let n = 2; state.mode === "rename" && files.has(path); n++) {
            name = keepBothName(state.name, n);
            path = path.slice(0, path.lastIndexOf("/") + 1) + name;
          }
          files.set(path, state.received);
          return { path, name, size: state.size, mtime: 2000 } satisfies FsUploadEndResult;
        }
        case "fs.upload_cancel":
          uploads.delete(params.upload_id as string);
          return {};
        default:
          throw failure("not_supported");
      }
    }) as Rpc,
    pending: () => uploads.size,
  };
  return mac;
}

function hooksFor(mac: ReturnType<typeof fakeMac>, change: Partial<TransferHooks> = {}) {
  const progress: number[] = [];
  const pauses: boolean[] = [];
  const hooks: TransferHooks = {
    rpc: mac.rpc,
    limits: LIMITS,
    signal: new AbortController().signal,
    onProgress: (moved) => progress.push(moved),
    onPaused: (paused) => pauses.push(paused),
    waitForMac: async () => {},
    ...change,
  };
  return { hooks, progress, pauses };
}

const methodsOf = (mac: ReturnType<typeof fakeMac>) => mac.calls.map((call) => call.method);

async function rejection(promise: Promise<unknown>): Promise<TransferFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TransferFailure);
    return error;
  }
  throw new Error("expected a failure");
}

test("a file is cut into pieces of the chunk size, and the last holds the rest", () => {
  assert.equal(pieceCount(0, 4), 0);
  assert.equal(pieceCount(4, 4), 1);
  assert.equal(pieceCount(10, 4), 3);
  assert.deepEqual(
    [0, 4, 8, 10].map((offset) => pieceLength(offset, 10, 4)),
    [4, 4, 2, 0],
  );
  assert.equal(pieceCount(50 * 1024 * 1024, 1024 * 1024), 50);
});

test("a file name is one segment of a path", () => {
  assert.ok(isValidFileName("notes (2).txt"));
  assert.ok(isValidFileName(".env"));
  for (const bad of ["", ".", "..", "a/b", "a\0b", "é".repeat(128), 7, null]) {
    assert.equal(isValidFileName(bad), false);
  }
});

test("keeping both numbers the name before its extension", () => {
  assert.equal(keepBothName("notes.txt", 2), "notes (2).txt");
  assert.equal(keepBothName("archive.tar.gz", 3), "archive.tar (3).gz");
  assert.equal(keepBothName(".env", 2), ".env (2)");
  assert.equal(keepBothName("Makefile", 2), "Makefile (2)");
  const long = keepBothName(`${"x".repeat(253)}.c`, 2);
  assert.equal(new TextEncoder().encode(long).length, 255);
  assert.ok(long.endsWith(" (2).c"));
});

test("a name in the uploads area is made of letters, digits, dots, dashes and underscores", () => {
  assert.equal(cleanUploadName("IMG_1234.HEIC"), "IMG_1234.heic");
  assert.equal(
    cleanUploadName("Screen Shot 2026-10-13 at 09.41.07.png"),
    "Screen-Shot-2026-10-13-at-09.41.07.png",
  );
  assert.equal(cleanUploadName("fotoğraf (düzenlendi).jpg"), "foto-raf-d-zenlendi.jpg");
  assert.equal(cleanUploadName("$(rm -rf ~);`x`.png"), "rm-rf-x.png");
  assert.equal(cleanUploadName("📷.jpeg"), "file.jpeg");
  assert.equal(cleanUploadName(".hidden"), "hidden");
  assert.equal(cleanUploadName("no extension"), "no-extension");
  assert.equal(cleanUploadName(`${"a".repeat(200)}.png`), `${"a".repeat(64)}.png`);
  assert.equal(numberedUploadName("image.jpg", 2), "image-2.jpg");
  assert.match(cleanUploadName("--..weird..--.PNG"), /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/);
});

test("a path is pasted the way a terminal types a dropped file", () => {
  const plain = "/Users/ege/.hako/uploads/2026-10-13/IMG_1234-2.jpg";
  assert.equal(escapePathForPaste(plain), plain);
  assert.equal(
    escapePathForPaste("/Users/Ege Hakan/it's (1).png"),
    "/Users/Ege\\ Hakan/it\\'s\\ \\(1\\).png",
  );
});

test("base64 survives the round trip, also for a piece longer than one slice", () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 31) % 256);
  assert.deepEqual(decodeBase64(encodeBase64(bytes)), bytes);
  assert.equal(encodeBase64(new Uint8Array(0)), "");
});

test("a download asks for the pieces in order and reports each one", async () => {
  const mac = fakeMac({ "/a.txt": "0123456789" });
  const { hooks, progress } = hooksFor(mac);
  const result = await download(hooks, "/a.txt");
  assert.equal(textOf(result.parts), "0123456789");
  assert.deepEqual(progress, [4, 8, 10]);
  assert.deepEqual(
    mac.calls.map((call) => [call.params.offset, call.params.length, call.params.expected_size]),
    [
      [0, 4, null],
      [4, 4, 10],
      [8, 2, 10],
    ],
  );
});

test("an empty file is one request and no bytes", async () => {
  const mac = fakeMac({ "/empty": "" });
  const { hooks, progress } = hooksFor(mac);
  const result = await download(hooks, "/empty");
  assert.equal(result.size, 0);
  assert.deepEqual(progress, [0]);
  assert.equal(mac.calls.length, 1);
});

test("a file that changes on the Mac between two pieces ends the download", async () => {
  const mac = fakeMac({ "/a.txt": "0123456789" });
  mac.before = (call) => {
    if (call.params.offset === 4) mac.rewrite("/a.txt", "abcdefghij");
  };
  const error = await rejection(download(hooksFor(mac).hooks, "/a.txt"));
  assert.equal(error.code, "changed");
});

test("a download over the limit stops at the first piece", async () => {
  const mac = fakeMac({ "/big": "x".repeat(41) });
  const error = await rejection(download(hooksFor(mac).hooks, "/big"));
  assert.equal(error.code, "too_large");
  assert.equal(mac.calls.length, 1);
});

test("an upload announces the file, sends its pieces in order and asks for it to be placed", async () => {
  const mac = fakeMac();
  const { hooks, progress } = hooksFor(mac);
  const result = await upload(hooks, {
    source: sourceOf("0123456789"),
    destination: { kind: "dir", path: "/d" },
    name: "a.txt",
    onConflict: "fail",
  });
  assert.equal(result.path, "/d/a.txt");
  assert.equal(mac.text("/d/a.txt"), "0123456789");
  assert.deepEqual(progress, [4, 8, 10]);
  assert.deepEqual(methodsOf(mac), [
    "fs.upload_begin",
    "fs.upload_chunk",
    "fs.upload_chunk",
    "fs.upload_chunk",
    "fs.upload_end",
  ]);
});

test("a file over the limit is refused before anything is sent", async () => {
  const mac = fakeMac();
  const error = await rejection(
    upload(hooksFor(mac).hooks, {
      source: sourceOf("x".repeat(41)),
      destination: { kind: "dir", path: "/d" },
      name: "big",
      onConflict: "fail",
    }),
  );
  assert.equal(error.code, "too_large");
  assert.equal(mac.calls.length, 0);
});

test("a piece whose answer was lost is sent again, and the upload goes on from there", async () => {
  const mac = fakeMac();
  let dropped = false;
  const original = mac.rpc;
  // The Mac takes the second piece, but the connection is gone before its answer arrives.
  const rpc: Rpc = async (method, params, timeoutMs) => {
    const answer = await original(method, params, timeoutMs);
    if (method === "fs.upload_chunk" && (params as { offset: number }).offset === 4 && !dropped) {
      dropped = true;
      throw failure("disconnected");
    }
    return answer as never;
  };
  const { hooks, pauses } = hooksFor(mac, { rpc });
  await upload(hooks, {
    source: sourceOf("0123456789"),
    destination: { kind: "dir", path: "/d" },
    name: "a.txt",
    onConflict: "fail",
  });
  assert.equal(mac.text("/d/a.txt"), "0123456789");
  assert.deepEqual(pauses, [true, false]);
  assert.deepEqual(
    mac.calls.filter((call) => call.method === "fs.upload_chunk").map((call) => call.params.offset),
    [0, 4, 4, 8],
  );
});

test("an upload the Mac no longer knows fails, and the Mac is told to forget it", async () => {
  const mac = fakeMac();
  mac.before = (call) => {
    if (call.method === "fs.upload_chunk" && call.params.offset === 4) throw failure("not_found");
  };
  const error = await rejection(
    upload(hooksFor(mac).hooks, {
      source: sourceOf("0123456789"),
      destination: { kind: "dir", path: "/d" },
      name: "a.txt",
      onConflict: "fail",
    }),
  );
  assert.equal(error.code, "not_found");
  assert.equal(methodsOf(mac).at(-1), "fs.upload_cancel");
  assert.equal(mac.pending(), 0);
});

function queueFor(mac: ReturnType<typeof fakeMac>) {
  const queue = new TransferQueue({
    rpc: mac.rpc,
    waitForMac: async () => {},
    limits: () => LIMITS,
  });
  /** Resolves once the transfer is in one of these states. */
  const until = (id: number, ...states: Transfer["state"][]) =>
    new Promise<Transfer>((resolve) => {
      const check = () => {
        const item = queue.get(id);
        if (item && states.includes(item.state)) {
          stop();
          resolve(item);
        }
      };
      const stop = queue.subscribe(check);
      check();
    });
  const put = (name: string, text: string) =>
    queue.addUpload({
      group: "files",
      source: sourceOf(text),
      destination: { kind: "dir", path: "/d" },
      name,
    });
  return { queue, until, put };
}

test("a name that is taken asks, and the answer decides: keep both", async () => {
  const mac = fakeMac({ "/d/notes.txt": "the Mac's" });
  const { queue, until, put } = queueFor(mac);
  const id = put("notes.txt", "the phone's");
  await until(id, "asking");
  assert.equal(mac.text("/d/notes.txt"), "the Mac's");
  queue.answer(id, "rename");
  const done = await until(id, "done");
  assert.equal(done.uploaded?.name, "notes (2).txt");
  assert.equal(mac.text("/d/notes.txt"), "the Mac's");
  assert.equal(mac.text("/d/notes (2).txt"), "the phone's");
});

test("a name that is taken asks, and the answer decides: replace, or leave it", async () => {
  const mac = fakeMac({ "/d/notes.txt": "the Mac's" });
  const { queue, until, put } = queueFor(mac);
  const kept = put("notes.txt", "never arrives");
  await until(kept, "asking");
  queue.answer(kept, "cancel");
  assert.equal(queue.get(kept)?.state, "cancelled");
  assert.equal(mac.text("/d/notes.txt"), "the Mac's");

  const replaced = put("notes.txt", "the phone's");
  await until(replaced, "asking");
  queue.answer(replaced, "replace");
  await until(replaced, "done");
  assert.equal(mac.text("/d/notes.txt"), "the phone's");
});

test("the files of one group go one at a time, and a waiting question holds nobody up", async () => {
  const mac = fakeMac({ "/d/b.txt": "taken" });
  const { queue, until, put } = queueFor(mac);
  const [a, b, c] = [put("a.txt", "aaaaaaaa"), put("b.txt", "bbbb"), put("c.txt", "cccc")];
  assert.deepEqual(
    queue.getSnapshot().map((item) => item.state),
    ["running", "queued", "queued"],
  );
  await until(c, "done");
  assert.equal(queue.get(a)?.state, "done");
  assert.equal(queue.get(b)?.state, "asking");
  const firstOf = (name: string) =>
    mac.calls.findIndex((call) => call.method === "fs.upload_begin" && call.params.name === name);
  const lastOfA = mac.calls.findIndex((call) => call.method === "fs.upload_end");
  assert.ok(firstOf("b.txt") > lastOfA);
});

test("cancelling mid-way leaves nothing on the Mac, and trying again starts over", async () => {
  const mac = fakeMac();
  const { queue, until, put } = queueFor(mac);
  let cancelAt: number | null = 4;
  const id = put("a.txt", "0123456789");
  mac.before = (call) => {
    if (call.method === "fs.upload_chunk" && call.params.offset === cancelAt) queue.cancel(id);
  };
  await until(id, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mac.files.has("/d/a.txt"), false);
  assert.equal(mac.pending(), 0);
  assert.ok(methodsOf(mac).includes("fs.upload_cancel"));

  cancelAt = null;
  queue.retry(id);
  const done = await until(id, "done");
  assert.equal(done.moved, 10);
  assert.equal(mac.text("/d/a.txt"), "0123456789");
});

test("a file that is too large fails as it is added, and a changed download can be retried", async () => {
  const mac = fakeMac({ "/a.txt": "0123456789" });
  const { queue, until, put } = queueFor(mac);
  const big = put("big", "x".repeat(41));
  assert.equal(queue.get(big)?.state, "failed");
  assert.equal(queue.get(big)?.error?.code, "too_large");
  assert.equal(mac.calls.length, 0);

  let change = true;
  mac.before = (call) => {
    if (change && call.params.offset === 4) mac.rewrite("/a.txt", "abcdefghij");
  };
  const id = queue.addDownload({ group: "files", path: "/a.txt", name: "a.txt" });
  assert.equal((await until(id, "failed")).error?.code, "changed");
  change = false;
  queue.retry(id);
  const done = await until(id, "done");
  assert.equal(textOf(done.downloaded?.parts ?? []), "abcdefghij");
  queue.dismiss(id);
  assert.equal(queue.get(id), null);
});

test("a picture is told by its first bytes, whatever its name says", () => {
  const head = (...bytes: number[]) => Uint8Array.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImageType(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(sniffImageType(head(0xff, 0xd8, 0xff, 0xe1)), "image/jpeg");
  assert.equal(sniffImageType(bytesOf("GIF89a......")), "image/gif");
  assert.equal(sniffImageType(bytesOf("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageType(bytesOf("\0\0\0\x18ftypheic")), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
});

test("a picture Claude Code takes, and of a size it takes, keeps its own bytes", () => {
  assert.deepEqual(planImage({ name: "shot.png", type: "image/png", width: 1170, height: 2532 }), {
    action: "keep",
    name: "shot.png",
  });
  assert.deepEqual(planImage({ name: "a.JPEG", type: "image/jpeg", width: 2576, height: 1932 }), {
    action: "keep",
    name: "a.JPEG",
  });
  // A name that lies about the format is put right, so the Mac's file says what it is.
  assert.deepEqual(planImage({ name: "photo.heic", type: "image/jpeg", width: 800, height: 600 }), {
    action: "keep",
    name: "photo.jpg",
  });
});

test("any other format is drawn again as a JPEG, and a large one is scaled down", () => {
  assert.deepEqual(planImage({ name: "IMG_0042.HEIC", type: null, width: 1000, height: 750 }), {
    action: "encode",
    type: "image/jpeg",
    width: 1000,
    height: 750,
    name: "IMG_0042.jpg",
  });
  assert.deepEqual(planImage({ name: "IMG_0042.HEIC", type: null, width: 4032, height: 3024 }), {
    action: "encode",
    type: "image/jpeg",
    width: 2576,
    height: 1932,
    name: "IMG_0042.jpg",
  });
});

test("a large picture of an accepted format is scaled down on its longer side", () => {
  assert.deepEqual(planImage({ name: "p.jpg", type: "image/jpeg", width: 3024, height: 4032 }), {
    action: "encode",
    type: "image/jpeg",
    width: 1932,
    height: 2576,
    name: "p.jpg",
  });
  const tall = planImage({ name: "page.png", type: "image/png", width: 1170, height: 9000 });
  assert.deepEqual(tall, {
    action: "encode",
    type: "image/png",
    width: 335,
    height: 2576,
    name: "page.png",
  });
  assert.equal(withExtension("anim.gif", "image/png"), "anim.png");
  assert.equal(withExtension("image", "image/jpeg"), "image.jpg");
});
