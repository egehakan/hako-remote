import assert from "node:assert/strict";
import { test } from "node:test";
import type { FsWriteParams, FsWriteResult } from "../shared/protocol.ts";
import { detectLineEnding, SaveGuard } from "../src/lib/files/save.ts";

/** A Mac with one file, which refuses a write based on a version it no longer has. */
function fakeMac(mtime: number) {
  const mac = {
    mtime,
    content: "original",
    calls: [] as FsWriteParams[],
    write: async (params: FsWriteParams): Promise<FsWriteResult> => {
      mac.calls.push(params);
      if (params.expected_mtime !== null && params.expected_mtime !== mac.mtime) {
        throw Object.assign(new Error("changed since it was read"), { code: "conflict" });
      }
      mac.content = params.content;
      mac.mtime += 1000;
      return { mtime: mac.mtime, size: params.content.length };
    },
  };
  return mac;
}

test("a save names the version it is based on, and the next save the one it made", async () => {
  const mac = fakeMac(5000);
  const guard = new SaveGuard("/a.txt", 5000, mac.write);
  assert.deepEqual(await guard.save("one"), { kind: "saved", mtime: 6000, size: 3 });
  assert.deepEqual(await guard.save("two"), { kind: "saved", mtime: 7000, size: 3 });
  assert.deepEqual(
    mac.calls.map((call) => call.expected_mtime),
    [5000, 6000],
  );
  assert.equal(mac.content, "two");
});

test("a file changed on the Mac is not written over, however often saving is tried", async () => {
  const mac = fakeMac(5000);
  const guard = new SaveGuard("/a.txt", 5000, mac.write);
  mac.mtime = 5500;
  mac.content = "edited on the Mac";
  assert.deepEqual(await guard.save("mine"), { kind: "conflict" });
  assert.deepEqual(await guard.save("mine"), { kind: "conflict" });
  assert.equal(mac.content, "edited on the Mac");
  assert.equal(guard.mtime, 5000);
});

test("overwriting skips the check once, and later saves are checked again", async () => {
  const mac = fakeMac(5000);
  const guard = new SaveGuard("/a.txt", 5000, mac.write);
  mac.mtime = 5500;
  assert.equal((await guard.save("mine")).kind, "conflict");
  assert.equal((await guard.save("mine", { overwrite: true })).kind, "saved");
  assert.equal(mac.calls.at(-1)?.expected_mtime, null);
  assert.equal(mac.content, "mine");

  mac.mtime += 1;
  assert.equal((await guard.save("mine again")).kind, "conflict");
});

test("after reloading, saves are based on the version that was reloaded", async () => {
  const mac = fakeMac(5000);
  const guard = new SaveGuard("/a.txt", 5000, mac.write);
  mac.mtime = 5500;
  assert.equal((await guard.save("mine")).kind, "conflict");
  guard.rebase(5500);
  assert.equal((await guard.save("merged")).kind, "saved");
});

test("other failures keep the Mac's words and leave the base version alone", async () => {
  const guard = new SaveGuard("/a.txt", 5000, async () => {
    throw Object.assign(new Error("Permission denied: /a.txt"), { code: "permission_denied" });
  });
  assert.deepEqual(await guard.save("mine"), {
    kind: "failed",
    code: "permission_denied",
    message: "Permission denied: /a.txt",
  });
  assert.equal(guard.mtime, 5000);
});

test("a second save while one is on its way is turned away, not sent", async () => {
  let release: (result: FsWriteResult) => void = () => {};
  let calls = 0;
  const guard = new SaveGuard("/a.txt", 5000, () => {
    calls++;
    return new Promise<FsWriteResult>((resolve) => {
      release = resolve;
    });
  });
  const first = guard.save("one");
  assert.deepEqual(await guard.save("two"), { kind: "busy" });
  release({ mtime: 6000, size: 3 });
  assert.equal((await first).kind, "saved");
  assert.equal(calls, 1);
});

test("a file keeps the line endings it came with", () => {
  assert.equal(detectLineEnding("a\r\nb\r\nc\r\n"), "\r\n");
  assert.equal(detectLineEnding("a\nb\nc\n"), "\n");
  assert.equal(detectLineEnding("no line break at all"), "\n");
  assert.equal(detectLineEnding(""), "\n");
  // Mixed: the majority decides.
  assert.equal(detectLineEnding("a\r\nb\nc\n"), "\n");
  assert.equal(detectLineEnding("a\r\nb\r\nc\n"), "\r\n");
});
