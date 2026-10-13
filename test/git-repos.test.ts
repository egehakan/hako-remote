import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitRepo } from "../shared/protocol.ts";
import { explainFailure, groupRepos, summarizeFiles } from "../src/lib/git/repos.ts";

const OID = "82fa3d482a9f2e3326c51e5481db438d24fa1ed1";

function repo(name: string, change: Partial<GitRepo> = {}): GitRepo {
  return {
    path: `/code/${name}`,
    name,
    root: "/code",
    is_worktree: false,
    main_path: null,
    branch: "main",
    head: OID,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    changed: 0,
    operation: null,
    ...change,
  };
}

test("repositories with work come first, then those to push or pull, then the quiet ones", () => {
  const groups = groupRepos(
    [
      repo("quiet"),
      repo("zeta", { changed: 3 }),
      repo("behind", { behind: 2 }),
      repo("merging", { operation: "merge" }),
      repo("alpha", { changed: 1, ahead: 4 }),
    ],
    "",
  );
  assert.deepEqual(
    groups.map((group) => [group.id, group.repos.map((item) => item.name)]),
    [
      ["changed", ["alpha", "merging", "zeta"]],
      ["sync", ["behind"]],
      ["quiet", ["quiet"]],
    ],
  );
});

test("the filter looks at the name, the branch, the folder's name and the path", () => {
  const repos = [repo("hako"), repo("site", { branch: "redesign" }), repo("notes", { root: "/n" })];
  const names = (needle: string) =>
    groupRepos(repos, needle, new Map([["/n", "Journal"]])).flatMap((group) =>
      group.repos.map((item) => item.name),
    );
  assert.deepEqual(names("HAK"), ["hako"]);
  assert.deepEqual(names("redes"), ["site"]);
  assert.deepEqual(names("journal"), ["notes"]);
  assert.deepEqual(names("/code/"), ["hako", "notes", "site"]);
  assert.deepEqual(names("nothing"), []);
});

test("a set of files is summed up by status, conflicts first", () => {
  const files = (["modified", "untracked", "modified", "conflicted", "deleted"] as const).map(
    (status) => ({ status }),
  );
  assert.equal(summarizeFiles(files), "1 in conflict, 2 modified, 1 untracked, 1 deleted");
});

test("git's output gets a plain title, and an unknown failure only its kind", () => {
  const rejected =
    " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs";
  assert.equal(explainFailure("push", "git_failed", rejected).title, "Push rejected");
  assert.equal(
    explainFailure("pull", "git_failed", "CONFLICT (content): Merge conflict in index.html").title,
    "Pull stopped at conflicts",
  );
  assert.equal(
    explainFailure(
      "pull",
      "git_failed",
      "error: Your local changes to the following files would be overwritten by merge:",
    ).title,
    "Your changes are in the way",
  );
  assert.equal(
    explainFailure(
      "push",
      "git_failed",
      "fatal: Authentication failed for 'https://example.com/a.git/'",
    ).title,
    "Your Mac couldn’t sign in to the remote",
  );
  assert.equal(
    explainFailure("commit", "git_failed", "nothing to commit, working tree clean").title,
    "Nothing to commit",
  );
  assert.deepEqual(explainFailure("push", "git_failed", "something new"), {
    title: "Push failed",
    hint: null,
  });
  assert.equal(explainFailure("push", "timeout", "").title, "Your Mac hasn’t answered yet");
});
