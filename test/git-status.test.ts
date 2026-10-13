import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidRepoPath, parseNumstat, parseStatus } from "../shared/git.ts";

const OID = "82fa3d482a9f2e3326c51e5481db438d24fa1ed1";
const ZERO = "0000000000000000000000000000000000000000";
const records = (...lines: string[]) => `${lines.join("\0")}\0`;

test("the branch, its upstream and the counts come from the header", () => {
  const status = parseStatus(
    records(
      `# branch.oid ${OID}`,
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
    ),
  );
  assert.deepEqual(status, {
    head: OID,
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    files: [],
  });
});

test("a detached HEAD, a repository without commits and a vanished upstream", () => {
  assert.equal(
    parseStatus(records(`# branch.oid ${OID}`, "# branch.head (detached)")).branch,
    null,
  );
  const unborn = parseStatus(records("# branch.oid (initial)", "# branch.head main"));
  assert.equal(unborn.head, null);
  assert.equal(unborn.branch, "main");
  // Configured, but the branch it names is gone: no counts, and as good as no upstream.
  const gone = parseStatus(
    records(`# branch.oid ${OID}`, "# branch.head topic", "# branch.upstream origin/topic"),
  );
  assert.equal(gone.upstream, null);
  assert.equal(gone.ahead, 0);
});

test("every kind of entry maps to one status against HEAD", () => {
  const status = parseStatus(
    records(
      `# branch.oid ${OID}`,
      "# branch.head main",
      `1 .M N... 100644 100644 100644 ${OID} ${OID} unstaged.txt`,
      `1 M. N... 100644 100644 100644 ${OID} ${OID} staged.txt`,
      `1 MM N... 100644 100644 100644 ${OID} ${OID} both.txt`,
      `1 A. N... 000000 100644 100644 ${ZERO} ${OID} new staged.txt`,
      `1 AM N... 000000 100644 100644 ${ZERO} ${OID} ünï.txt`,
      `1 .D N... 100644 100644 000000 ${OID} ${OID} removed.txt`,
      `1 D. N... 100644 000000 000000 ${OID} ${ZERO} removed staged.txt`,
      `1 AD N... 000000 100644 000000 ${ZERO} ${OID} added then deleted.txt`,
      `1 .T N... 100644 100644 120000 ${OID} ${OID} now a link`,
      `2 RM N... 100644 100644 100644 ${OID} ${OID} R100 dir/new name.txt`,
      "old name.txt",
      `2 RD N... 100644 100644 000000 ${OID} ${OID} R100 moved then deleted.txt`,
      "was here.txt",
      `u UU N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} in conflict.txt`,
      "? notes/untracked file.md",
      "? vendor/nested repository/",
    ),
  );
  assert.deepEqual(
    status.files.map((file) => [file.path, file.status, file.old_path]),
    [
      ["both.txt", "modified", null],
      ["dir/new name.txt", "renamed", "old name.txt"],
      ["in conflict.txt", "conflicted", null],
      ["new staged.txt", "added", null],
      ["notes/untracked file.md", "untracked", null],
      ["now a link", "modified", null],
      ["removed staged.txt", "deleted", null],
      ["removed.txt", "deleted", null],
      ["staged.txt", "modified", null],
      ["unstaged.txt", "modified", null],
      ["vendor/nested repository", "untracked", null],
      ["was here.txt", "deleted", null],
      ["ünï.txt", "added", null],
    ],
  );
});

test("a file deleted in the index and present again untracked is one modified file", () => {
  const status = parseStatus(
    records(`1 D. N... 100644 000000 000000 ${OID} ${ZERO} back.txt`, "? back.txt"),
  );
  assert.deepEqual(status.files, [{ path: "back.txt", old_path: null, status: "modified" }]);
});

test("line counts are read by path, with a rename under its new path and binaries without counts", () => {
  const counts = parseNumstat(
    "0\t1\tk.txt\x001\t0\t\0r.txt\0r new.txt\x002\t0\tünï.txt\0-\t-\ticon.bin\0",
  );
  assert.deepEqual(counts.get("k.txt"), { additions: 0, deletions: 1, binary: false });
  assert.deepEqual(counts.get("r new.txt"), { additions: 1, deletions: 0, binary: false });
  assert.equal(counts.has("r.txt"), false);
  assert.deepEqual(counts.get("icon.bin"), { additions: null, deletions: null, binary: true });
  assert.equal(counts.size, 4);
});

test("a path inside a repository is relative and normalised", () => {
  for (const good of ["a", "a/b.txt", "dir with space/ünï", ".gitignore"]) {
    assert.equal(isValidRepoPath(good), true, good);
  }
  for (const bad of ["", "/a", "a/", "a//b", "./a", "a/../b", "..", 7, null]) {
    assert.equal(isValidRepoPath(bad), false, String(bad));
  }
});
