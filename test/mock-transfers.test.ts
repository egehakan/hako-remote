import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createTransferMethods } from "../scripts/mock-transfers.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "hako-transfer-test-")));
mkdirSync(join(root, "inbox"));
writeFileSync(join(root, "inbox", "notes.txt"), "the Mac's");
const mock = createTransferMethods(root);
const { methods } = mock;
after(() => {
  mock.dispose();
  rmSync(root, { recursive: true, force: true });
});

const base64 = (text: string) => Buffer.from(text).toString("base64");
const inbox = { kind: "dir", path: join(root, "inbox") };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "no error";
}

function send(name: string, text: string, destination: object, onConflict = "fail") {
  const { upload_id: id } = methods["fs.upload_begin"]({
    destination,
    name,
    size: text.length,
    on_conflict: onConflict,
  });
  if (text !== "") methods["fs.upload_chunk"]({ upload_id: id, offset: 0, data: base64(text) });
  return { id, result: methods["fs.upload_end"]({ upload_id: id }) };
}

test("an upload is a hidden sibling until it is whole, and only then has its name", () => {
  const { upload_id: id } = methods["fs.upload_begin"]({
    destination: inbox,
    name: "new.txt",
    size: 8,
    on_conflict: "fail",
  });
  assert.deepEqual(readdirSync(join(root, "inbox")).sort(), [`.hako-upload-${id}`, "notes.txt"]);
  assert.deepEqual(methods["fs.upload_chunk"]({ upload_id: id, offset: 0, data: base64("0123") }), {
    received: 4,
  });
  // Too early, a repeat, a gap, and too much.
  assert.equal(
    codeOf(() => methods["fs.upload_end"]({ upload_id: id })),
    "bad_request",
  );
  assert.deepEqual(methods["fs.upload_chunk"]({ upload_id: id, offset: 0, data: base64("0123") }), {
    received: 4,
  });
  const chunk = (offset: number, text: string) =>
    codeOf(() => methods["fs.upload_chunk"]({ upload_id: id, offset, data: base64(text) }));
  assert.equal(chunk(6, "67"), "bad_request");
  assert.equal(chunk(4, "45678"), "bad_request");
  assert.equal(existsSync(join(root, "inbox", "new.txt")), false);

  methods["fs.upload_chunk"]({ upload_id: id, offset: 4, data: base64("4567") });
  const result = methods["fs.upload_end"]({ upload_id: id });
  assert.equal(result.path, join(root, "inbox", "new.txt"));
  assert.equal(readFileSync(result.path, "utf8"), "01234567");
  assert.deepEqual(readdirSync(join(root, "inbox")).sort(), ["new.txt", "notes.txt"]);
  // Asked again, as after a lost answer, it says the same.
  assert.deepEqual(methods["fs.upload_end"]({ upload_id: id }), result);
});

test("a name that is taken is refused, replaced or numbered, as asked", () => {
  assert.equal(
    codeOf(() => send("notes.txt", "x", inbox)),
    "conflict",
  );
  assert.equal(readFileSync(join(root, "inbox", "notes.txt"), "utf8"), "the Mac's");

  assert.equal(send("notes.txt", "second", inbox, "rename").result.name, "notes (2).txt");
  assert.equal(send("notes.txt", "third", inbox, "rename").result.name, "notes (3).txt");
  assert.equal(readFileSync(join(root, "inbox", "notes.txt"), "utf8"), "the Mac's");

  assert.equal(send("notes.txt", "the phone's", inbox, "replace").result.name, "notes.txt");
  assert.equal(readFileSync(join(root, "inbox", "notes.txt"), "utf8"), "the phone's");
});

test("cancelling removes the temporary file, and the upload is then unknown", () => {
  const { upload_id: id } = methods["fs.upload_begin"]({
    destination: inbox,
    name: "gone.txt",
    size: 4,
    on_conflict: "fail",
  });
  assert.deepEqual(methods["fs.upload_cancel"]({ upload_id: id }), {});
  assert.equal(existsSync(join(root, "inbox", `.hako-upload-${id}`)), false);
  assert.equal(
    codeOf(() => methods["fs.upload_chunk"]({ upload_id: id, offset: 0, data: base64("0123") })),
    "not_found",
  );
  assert.deepEqual(methods["fs.upload_cancel"]({ upload_id: id }), {});
});

test("limits, places outside the tree and folders that refuse are all told apart", () => {
  const begin = (change: object) =>
    codeOf(() =>
      methods["fs.upload_begin"]({
        destination: inbox,
        name: "a",
        size: 1,
        on_conflict: "fail",
        ...change,
      }),
    );
  assert.equal(begin({ size: 50 * 1024 * 1024 + 1 }), "too_large");
  assert.equal(begin({ name: "a/b" }), "bad_request");
  assert.equal(begin({ destination: { kind: "dir", path: "/tmp" } }), "permission_denied");
  assert.equal(begin({ destination: { kind: "dir", path: join(root, "nowhere") } }), "not_found");
  assert.equal(
    begin({ destination: { kind: "dir", path: join(root, "inbox", "notes.txt") } }),
    "not_a_directory",
  );
  mkdirSync(join(root, "locked"), { mode: 0o555 });
  assert.equal(
    begin({ destination: { kind: "dir", path: join(root, "locked") } }),
    "permission_denied",
  );
  chmodSync(join(root, "locked"), 0o755);
});

test("the uploads area gives every file a clean name of its own, and its full path", () => {
  const first = send("Screen Shot (1).PNG", "one", { kind: "uploads" }).result;
  const second = send("Screen Shot (1).PNG", "two", { kind: "uploads" }).result;
  assert.match(first.path, /\/\d{4}-\d{2}-\d{2}\/Screen-Shot-1\.png$/);
  assert.ok(first.path.startsWith(`${mock.uploadsRoot}/`));
  assert.equal(second.name, "Screen-Shot-1-2.png");
  assert.equal(readFileSync(first.path, "utf8"), "one");
  assert.equal(readFileSync(second.path, "utf8"), "two");
});

test("a download is read in pieces, and refuses to go on once the file has changed", () => {
  const path = join(root, "inbox", "data.bin");
  writeFileSync(path, "0123456789");
  const piece = (offset: number, expected: { size: number; mtime: number } | null) =>
    methods["fs.download"]({
      path,
      offset,
      length: 4,
      expected_size: expected?.size ?? null,
      expected_mtime: expected?.mtime ?? null,
    });
  const first = piece(0, null);
  assert.equal(Buffer.from(first.data, "base64").toString(), "0123");
  assert.equal(first.size, 10);
  assert.equal(Buffer.from(piece(8, first).data, "base64").toString(), "89");
  assert.equal(piece(10, first).data, "");
  assert.equal(
    codeOf(() => piece(11, first)),
    "bad_request",
  );

  writeFileSync(path, "0123456789 and more");
  assert.equal(
    codeOf(() => piece(4, first)),
    "conflict",
  );
  assert.equal(
    codeOf(() =>
      methods["fs.download"]({
        path: "/etc/hosts",
        offset: 0,
        length: 4,
        expected_size: null,
        expected_mtime: null,
      }),
    ),
    "permission_denied",
  );
  assert.equal(
    codeOf(() => piece(0, { size: 10, mtime: null as unknown as number })),
    "bad_request",
  );
});
