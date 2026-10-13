// The mock agent's repositories: throwaway git repositories inside the fixture tree, one for every
// state the web client has to cope with, and the `git.*` methods of docs/protocol.md served by the
// real `git` command line from those repositories and from nowhere else.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isValidPath } from "../shared/files.ts";
import {
  GIT_COMMAND_LIMIT_MS,
  GIT_DIFF_LIMIT_BYTES,
  GIT_MESSAGE_LIMIT_BYTES,
  GIT_OUTPUT_LIMIT_BYTES,
  GIT_STATUS_LIMIT,
  isValidRepoPath,
  type ParsedStatus,
  parseNumstat,
  parseStatus,
  type StatusEntry,
} from "../shared/git.ts";
import type {
  ErrorCode,
  GitCommitResult,
  GitDiffResult,
  GitDiscardResult,
  GitFile,
  GitOperation,
  GitPullResult,
  GitPushResult,
  GitRepo,
  GitReposResult,
  GitStatusResult,
  Window,
} from "../shared/protocol.ts";

export class GitFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What `git diff` compares with in a repository that has no commit yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const REMOTES = ".mock-git";
const SKIPPED = new Set([".git", "node_modules", "target", "dist"]);
const MAX_DEPTH = 6;

/**
 * Git as the mock runs it: deaf to the configuration of whoever starts the mock, and never
 * waiting for someone to type a password.
 */
function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    LC_ALL: "C",
  };
}

// The fixture

const PROTOCOL_RS = `//! Frames of the remote protocol.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Frame {
    Req { id: String, method: String, params: serde_json::Value },
    Res { id: String, ok: bool, result: Option<serde_json::Value> },
    Ntf { method: String, params: serde_json::Value },
    Evt { event: String, data: serde_json::Value },
}

impl Frame {
    pub fn event(name: &str, data: serde_json::Value) -> Self {
        Frame::Evt { event: name.to_string(), data }
    }

    pub fn ok(id: String, result: serde_json::Value) -> Self {
        Frame::Res { id, ok: true, result: Some(result) }
    }
}

pub fn encode(frame: &Frame) -> String {
    serde_json::to_string(frame).expect("a frame is always valid JSON")
}

pub fn decode(text: &str) -> Option<Frame> {
    serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_round_trips() {
        let frame = Frame::event("workspace.changed", serde_json::json!({}));
        assert!(decode(&encode(&frame)).is_some());
    }
}
`;

const OUTPUT_STREAM_RS = `//! One terminal's output as a numbered stream of bytes.

pub struct OutputStream {
    seq: u64,
    pending: Vec<u8>,
}

impl OutputStream {
    pub fn new() -> Self {
        Self { seq: 0, pending: Vec::new() }
    }

    /// Takes what the PTY produced and returns the offset of its first byte.
    pub fn push(&mut self, bytes: &[u8]) -> u64 {
        let start = self.seq;
        self.seq += bytes.len() as u64;
        self.pending.extend_from_slice(bytes);
        start
    }
}
`;

const REMOTE_MD = `# Remote access

Hako dials out to the relay and answers what a phone asks.

| Method | What it does |
|---|---|
| \`workspace.list\` | Lists windows, folders and tabs |
| \`term.subscribe\` | Starts a terminal's stream |

Notes in other scripts stay as they are: 端末, терминал, τερματικό, and a box 📦.
`;

function longSource(changed: boolean): string {
  const lines: string[] = [];
  for (let index = 0; index < 3000; index++) {
    if (changed && index % 9 === 4) {
      lines.push(`export const value${index} = ${index} * 3; // line ${index + 1}, tripled`);
      if (index % 90 === 4) lines.push(`export const extra${index} = value${index} + 1;`);
    } else if (changed && index % 250 === 7) {
      // Dropped in the working tree.
    } else {
      lines.push(`export const value${index} = ${index} * 2; // line ${index + 1}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function generatedData(revision: number): string {
  const rows: string[] = [];
  for (let index = 0; index < 26_000; index++) {
    rows.push(
      `  { "id": ${index}, "revision": ${revision}, "label": "row ${index} of the generated table" },`,
    );
  }
  return `[\n${rows.join("\n")}\n  null\n]\n`;
}

function minified(scale: number): string {
  const parts = Array.from(
    { length: 160 },
    (_, index) => `function f${index}(a,b){return a+b*${index * scale}}`,
  );
  return `${parts.join(";")}\n`;
}

function noise(length: number, step: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, index) => (index * step + 11) % 256));
}

const TEAMMATE_SCRIPT = `#!/bin/sh
# A teammate pushes one commit to the remote of egehakan.com: a rule at the end of style.css.
# After it, a push from egehakan.com is rejected until a pull, a pull with style.css edited and
# not committed is refused, and any other pull brings the commit in.
set -e
cd "$(dirname "$0")/teammate"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
git fetch -q origin
git reset -q --hard origin/main
printf '\\n.note-%s {\\n  color: #e8923e;\\n}\\n' "$(date +%s)" >> style.css
git commit -q -a -m "Add a note style"
git push -q origin HEAD:main
echo "the teammate pushed $(git rev-parse --short HEAD) to the remote of egehakan.com"
`;

/**
 * Turns the folders of the fixture tree into repositories. Everything happens inside `home`, the
 * tree the mock agent removes when it stops. Returns the script that makes the remote move.
 */
export function createGitFixture(home: string): { teammateScript: string } {
  const env = gitEnvironment(home);
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };
  const write = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  /** Makes a directory a repository whose commits carry a name of their own, set in that repository only. */
  const init = (directory: string, name = "Mock Owner", email = "owner@hako.invalid") => {
    mkdirSync(directory, { recursive: true });
    git(directory, "init", "-q", "-b", "main");
    identify(directory, name, email);
  };
  const identify = (directory: string, name: string, email: string) => {
    git(directory, "config", "user.name", name);
    git(directory, "config", "user.email", email);
    git(directory, "config", "commit.gpgsign", "false");
  };
  const commitAll = (directory: string, message: string) => {
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", message);
  };
  const code = join(home, "Documents/GitHub");

  // hako: one change of every kind.
  const hako = join(code, "hako");
  init(hako);
  write(join(hako, ".gitignore"), "target/\nvendor/glyphs/\n");
  write(
    join(hako, "app/src/legacy.rs"),
    "// Input as the first prototype read it.\npub fn read_key() -> u8 {\n    0\n}\n",
  );
  write(
    join(hako, "scripts/old-build.sh"),
    "#!/bin/sh\n# Replaced by script/run.\ncargo build --release\n",
  );
  write(join(hako, "assets/icon.bin"), noise(2048, 37));
  write(join(hako, "app/web/bundle.min.js"), minified(1));
  commitAll(hako, "Start the terminal");
  write(join(hako, "app/src/remote/protocol.rs"), PROTOCOL_RS);
  write(join(hako, "docs/remote.md"), REMOTE_MD);
  commitAll(hako, "Add the remote protocol");

  write(
    join(hako, "app/src/remote/protocol.rs"),
    PROTOCOL_RS.replace(
      "MAX_FRAME_BYTES: usize = 8 * 1024 * 1024",
      "MAX_FRAME_BYTES: usize = 16 * 1024 * 1024",
    )
      .replace(
        "    Evt { event: String, data: serde_json::Value },\n",
        "    Evt { event: String, data: serde_json::Value },\n    Ping,\n    Pong,\n",
      )
      .replace(
        "    pub fn ok(id: String, result: serde_json::Value) -> Self {\n        Frame::Res { id, ok: true, result: Some(result) }",
        "    pub fn ok(id: impl Into<String>, result: serde_json::Value) -> Self {\n        Frame::Res { id: id.into(), ok: true, result: Some(result) }",
      )
      .replace(
        "        assert!(decode(&encode(&frame)).is_some());\n    }\n",
        '        assert!(decode(&encode(&frame)).is_some());\n    }\n\n    #[test]\n    fn a_ping_is_one_word() {\n        assert_eq!(encode(&Frame::Ping), r#"{"t":"ping"}"#);\n    }\n',
      ),
  );
  write(
    join(hako, "README.md"),
    "# hako\n\nA personal terminal.\n\nIt can be reached from a phone through Hako Remote.\n",
  );
  git(hako, "add", "README.md");
  write(join(hako, "app/src/remote/output_stream.rs"), OUTPUT_STREAM_RS);
  git(hako, "add", "app/src/remote/output_stream.rs");
  rmSync(join(hako, "scripts/old-build.sh"));
  git(hako, "mv", "app/src/legacy.rs", "app/src/remote/legacy_input.rs");
  write(
    join(hako, "app/src/remote/legacy_input.rs"),
    '// Input as the first prototype read it.\npub fn read_key() -> u8 {\n    0\n}\n\npub const KEPT_FOR: &str = "old sessions";\n',
  );
  write(
    join(hako, "notes/review.md"),
    "# Review notes\n\n- The stream offsets never go back.\n- Ask before closing a tab.\n",
  );
  write(
    join(hako, "app/src/remote/boundary_tests.rs"),
    "#[test]\nfn a_snapshot_ends_on_a_whole_character() {\n    assert!(true);\n}\n",
  );
  write(join(hako, "assets/icon.bin"), noise(2304, 41));
  write(join(hako, "assets/splash.bin"), noise(512, 13));
  write(join(hako, "app/web/bundle.min.js"), minified(2));
  // Without its final newline, which a diff has to say.
  write(
    join(hako, "Cargo.toml"),
    readFileSync(join(hako, "Cargo.toml"), "utf8")
      .replace('version = "0.1.0"', 'version = "0.2.0"')
      .trimEnd(),
  );
  write(
    join(hako, "docs/remote.md"),
    REMOTE_MD.replace(
      "| `term.subscribe` | Starts a terminal's stream |",
      "| `term.subscribe` | Starts a terminal's stream, with a snapshot |\n| `git.status` | Lists what changed |",
    ).replace("a box 📦", "two boxes 📦📦"),
  );

  // A repository inside another one, pinned to a tag.
  const glyphs = join(hako, "vendor/glyphs");
  init(glyphs);
  write(join(glyphs, "glyphs.toml"), '[font]\nname = "Hako Glyphs"\nsize = 13\n');
  write(join(glyphs, "README.md"), "# glyphs\n\nThe box-drawing glyphs Hako ships.\n");
  commitAll(glyphs, "Add the glyph table");
  git(glyphs, "tag", "v1.2.0");
  write(join(glyphs, "glyphs.toml"), '[font]\nname = "Hako Glyphs"\nsize = 14\nligatures = true\n');
  commitAll(glyphs, "Turn ligatures on");
  git(glyphs, "checkout", "-q", "--detach", "v1.2.0");
  write(
    join(glyphs, "glyphs.toml"),
    '[font]\nname = "Hako Glyphs"\nsize = 13\nfallback = "Menlo"\n',
  );

  // hako-remote: a long diff, and one that is over the limit.
  const remote = join(code, "hako-remote");
  init(remote);
  write(join(remote, ".gitignore"), "fixtures/\nnode_modules/\ndist/\n");
  write(join(remote, "samples/long.ts"), longSource(false));
  write(join(remote, "data/generated.json"), generatedData(1));
  commitAll(remote, "Add the relay and its samples");
  write(join(remote, "samples/long.ts"), longSource(true));
  write(join(remote, "data/generated.json"), generatedData(2));

  // Notes: nothing to commit, and nowhere to push.
  const notes = join(home, "Notes");
  init(notes);
  commitAll(notes, "Start the notes");

  // egehakan.com: a remote that has moved on, a commit that is not pushed, and the two in conflict.
  const site = join(code, "egehakan.com");
  const bare = join(home, REMOTES, "egehakan.com.git");
  const teammate = join(home, REMOTES, "teammate");
  init(site);
  git(site, "config", "pull.rebase", "false");
  commitAll(site, "Publish the site");
  mkdirSync(dirname(bare), { recursive: true });
  git(dirname(bare), "init", "-q", "--bare", "-b", "main", bare);
  git(site, "remote", "add", "origin", bare);
  git(site, "push", "-q", "-u", "origin", "main");
  git(site, "worktree", "add", "-q", "-b", "redesign", join(code, "egehakan.com-redesign"));

  git(dirname(bare), "clone", "-q", bare, teammate);
  identify(teammate, "Teammate", "teammate@hako.invalid");
  const page = readFileSync(join(site, "index.html"), "utf8");
  write(
    join(teammate, "index.html"),
    page.replace("<title>Hako</title>", "<title>Ege Hakan Karaağaç</title>"),
  );
  commitAll(teammate, "Put the full name in the title");
  git(teammate, "push", "-q", "origin", "HEAD:main");
  write(
    join(site, "index.html"),
    page.replace("<title>Hako</title>", "<title>egehakan.com</title>"),
  );
  commitAll(site, "Use the address as the title");
  git(site, "fetch", "-q", "origin");

  // The linked worktree: a branch that has never been pushed, with work in progress.
  const redesign = join(code, "egehakan.com-redesign");
  write(
    join(redesign, "style.css"),
    readFileSync(join(redesign, "style.css"), "utf8").replace(
      "--amber: #e8923e;",
      "--amber: #f0a04b;\n  --ink: #0c0d11;",
    ),
  );
  write(
    join(redesign, "about.html"),
    "<!doctype html>\n<title>About</title>\n<p>One person, one terminal.</p>\n",
  );

  const teammateScript = join(home, REMOTES, "teammate-pushes.sh");
  write(teammateScript, TEAMMATE_SCRIPT);
  chmodSync(teammateScript, 0o755);
  return { teammateScript };
}

// The methods

export type GitMethodOptions = {
  /** Answers `git.repos` with nothing, as a Mac whose folders hold no repository would. */
  empty: boolean;
  /** Makes push and pull take this much longer, as a slow network would. */
  networkDelayMs: number;
  /** Called with the path of a repository after something in it changed. */
  onChanged: (repo: string) => void;
};

/** How often the mock looks for changes made behind its back, by its shell or by an editor. */
const WATCH_INTERVAL_MS = 3_000;

type GitRun = { code: number; stdout: Buffer; output: string };
type Method = (params: Record<string, unknown>) => unknown;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The end of what git printed, which is where it says what went wrong. */
function tail(output: string): string {
  const bytes = Buffer.from(output.trim(), "utf8");
  if (bytes.length <= GIT_OUTPUT_LIMIT_BYTES) return bytes.toString("utf8");
  return bytes.subarray(bytes.length - GIT_OUTPUT_LIMIT_BYTES).toString("utf8");
}

export function createGitMethods(
  home: string,
  windows: () => Window[],
  options: GitMethodOptions,
): Record<string, Method> {
  const env = gitEnvironment(home);
  /** Repositories found by the last walk, by path, with the folder each belongs to. */
  let known = new Map<string, string>();
  const busy = new Set<string>();

  function run(
    cwd: string,
    args: string[],
    input: string | null = null,
    limitMs = GIT_COMMAND_LIMIT_MS,
  ): Promise<GitRun> {
    return new Promise((resolve) => {
      const child = spawn("git", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const all: Buffer[] = [];
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        child.kill("SIGTERM");
      }, limitMs);
      child.stdout.on("data", (chunk: Buffer) => {
        out.push(chunk);
        all.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => all.push(chunk));
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
      const finish = (code: number, note = "") => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out),
          output: Buffer.concat(all).toString("utf8") + note,
        });
      };
      child.on("error", (error) => finish(127, `\ngit could not be started: ${error.message}`));
      child.on("close", (code) =>
        finish(
          stopped ? 124 : (code ?? 1),
          stopped ? `\nStopped after ${Math.round(limitMs / 1000)} seconds.` : "",
        ),
      );
    });
  }

  async function read(cwd: string, args: string[]): Promise<string> {
    const result = await run(cwd, args);
    if (result.code !== 0) throw new GitFailure("git_failed", tail(result.output));
    return result.stdout.toString("utf8");
  }

  /** Fails with git's own words when a command did not succeed. */
  function check(...runs: GitRun[]): string {
    const output = runs
      .map((result) => result.output.trim())
      .filter(Boolean)
      .join("\n");
    if (runs.some((result) => result.code !== 0)) throw new GitFailure("git_failed", tail(output));
    return tail(output);
  }

  function findWorkingTrees(directory: string, depth: number, found: string[]): void {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    if (names.includes(".git")) found.push(directory);
    if (depth >= MAX_DEPTH) return;
    for (const name of names) {
      if (SKIPPED.has(name)) continue;
      const path = join(directory, name);
      try {
        if (statSync(path).isDirectory()) findWorkingTrees(path, depth + 1, found);
      } catch {
        // A link that points nowhere, or a directory that may not be read.
      }
    }
  }

  /** Every working tree under the folders, and the linked worktrees of those, wherever they are. */
  async function discover(): Promise<Map<string, string>> {
    const roots = [
      ...new Set(windows().flatMap((window) => window.folders.map((folder) => folder.directory))),
    ];
    const found = new Map<string, string>();
    // The folder a repository belongs to is the deepest one that holds it.
    const rootOf = (path: string) =>
      roots
        .filter((root) => path === root || path.startsWith(`${root}/`))
        .sort((a, b) => b.length - a.length)[0];
    for (const root of roots) {
      const trees: string[] = [];
      findWorkingTrees(root, 0, trees);
      for (const tree of trees) if (!found.has(tree)) found.set(tree, rootOf(tree) ?? root);
    }
    for (const [tree, root] of [...found]) {
      const listing = await run(tree, ["worktree", "list", "--porcelain"]);
      if (listing.code !== 0) continue;
      for (const line of listing.stdout.toString("utf8").split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const linked = line.slice(9);
        if (!found.has(linked) && existsSync(linked)) found.set(linked, rootOf(linked) ?? root);
      }
    }
    return found;
  }

  /** The repository a request names, which has to be one of the fixture's. */
  async function resolve(repo: unknown): Promise<string> {
    if (!isValidPath(repo)) {
      throw new GitFailure("bad_request", "repo must be an absolute, normalised path");
    }
    let real: string;
    try {
      real = realpathSync(repo);
    } catch {
      throw new GitFailure("not_found", `No repository at ${repo}`);
    }
    if (real !== home && !real.startsWith(`${home}/`)) {
      throw new GitFailure(
        "not_found",
        `The mock agent serves only the repositories of its fixture, and ${repo} is outside it.`,
      );
    }
    if (!known.has(repo)) known = await discover();
    if (!known.has(repo)) throw new GitFailure("not_found", `No repository at ${repo}`);
    return repo;
  }

  function repoPath(value: unknown, name: string): string {
    if (!isValidRepoPath(value)) {
      throw new GitFailure("bad_request", `${name} must be a path inside the repository`);
    }
    return value;
  }

  const STATUS = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"];

  async function statusOf(repo: string, paths: string[] = []): Promise<ParsedStatus> {
    return parseStatus(await read(repo, paths.length > 0 ? [...STATUS, "--", ...paths] : STATUS));
  }

  async function describe(repo: string, status?: ParsedStatus): Promise<GitRepo> {
    const parsed = status ?? (await statusOf(repo));
    const [gitDir, commonDir] = (
      await read(repo, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
    )
      .trim()
      .split("\n");
    const linked = gitDir !== commonDir;
    const operation: GitOperation | null = existsSync(join(gitDir, "MERGE_HEAD"))
      ? "merge"
      : existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))
        ? "rebase"
        : existsSync(join(gitDir, "CHERRY_PICK_HEAD"))
          ? "cherry-pick"
          : existsSync(join(gitDir, "REVERT_HEAD"))
            ? "revert"
            : null;
    return {
      path: repo,
      name: basename(repo),
      root: known.get(repo) ?? repo,
      is_worktree: linked,
      main_path: linked && basename(commonDir) === ".git" ? dirname(commonDir) : null,
      branch: parsed.branch,
      head: parsed.head,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      changed: parsed.files.length,
      operation,
    };
  }

  /** Lines and binary-ness of a file git does not track yet, read from the file itself. */
  function countUntracked(file: string): Pick<GitFile, "additions" | "deletions" | "binary"> {
    try {
      const stats = statSync(file);
      if (!stats.isFile() || stats.size > GIT_DIFF_LIMIT_BYTES) {
        return { additions: null, deletions: null, binary: false };
      }
      const bytes = readFileSync(file);
      if (bytes.subarray(0, 8000).includes(0)) {
        return { additions: null, deletions: null, binary: true };
      }
      let lines = 0;
      for (const byte of bytes) if (byte === 0x0a) lines++;
      if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) lines++;
      return { additions: lines, deletions: 0, binary: false };
    } catch {
      return { additions: null, deletions: null, binary: false };
    }
  }

  /** One repository at a time may be written to; a second request is told so instead of queued. */
  async function exclusively<T>(repo: string, work: () => Promise<T>): Promise<T> {
    if (busy.has(repo)) {
      throw new GitFailure("busy", "Another git command is still running in this repository.");
    }
    busy.add(repo);
    try {
      return await work();
    } finally {
      busy.delete(repo);
      options.onChanged(repo);
    }
  }

  async function entryFor(
    repo: string,
    path: string,
    oldPath: string | null,
  ): Promise<StatusEntry | null> {
    const status = await statusOf(repo, oldPath === null ? [path] : [path, oldPath]);
    return status.files.find((file) => file.path === path) ?? null;
  }

  // What each repository's status looked like at the last look, so a change can be announced.
  const seen = new Map<string, string>();
  let looking = false;
  const watch = setInterval(async () => {
    if (looking || known.size === 0) return;
    looking = true;
    for (const repo of known.keys()) {
      if (busy.has(repo)) continue;
      const result = await run(repo, ["--no-optional-locks", ...STATUS]);
      if (result.code !== 0) continue;
      const now = result.stdout.toString("utf8");
      const before = seen.get(repo);
      seen.set(repo, now);
      if (before !== undefined && before !== now) options.onChanged(repo);
    }
    looking = false;
  }, WATCH_INTERVAL_MS);
  watch.unref();

  return {
    "git.repos": async (): Promise<GitReposResult> => {
      if (options.empty) return { repos: [] };
      known = await discover();
      const repos: GitRepo[] = [];
      for (const path of known.keys()) {
        try {
          repos.push(await describe(path));
        } catch {
          // Not a working tree after all, or one git cannot read: leave it out.
        }
      }
      const order = [...new Set([...known.values()])];
      repos.sort(
        (a, b) =>
          order.indexOf(a.root) - order.indexOf(b.root) ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      return { repos };
    },

    "git.status": async (params): Promise<GitStatusResult> => {
      const repo = await resolve(params.repo);
      const status = await statusOf(repo);
      const base = status.head === null ? EMPTY_TREE : "HEAD";
      const counts = parseNumstat(await read(repo, ["diff", base, "--numstat", "-M", "-z"]));
      const files = status.files.slice(0, GIT_STATUS_LIMIT).map((entry): GitFile => {
        if (entry.status === "untracked")
          return { ...entry, ...countUntracked(join(repo, entry.path)) };
        const count = counts.get(entry.path);
        return {
          ...entry,
          additions: count ? count.additions : 0,
          deletions: count ? count.deletions : 0,
          binary: count?.binary ?? false,
        };
      });
      return {
        repo: await describe(repo, status),
        files,
        truncated: status.files.length > GIT_STATUS_LIMIT,
      };
    },

    "git.diff": async (params): Promise<GitDiffResult> => {
      const repo = await resolve(params.repo);
      const path = repoPath(params.path, "path");
      const oldPath = params.old_path == null ? null : repoPath(params.old_path, "old_path");
      const entry = await entryFor(repo, path, oldPath);
      if (statSync(join(repo, path), { throwIfNoEntry: false })?.isDirectory()) {
        throw new GitFailure("failed", `${path} is a directory, which has no diff of its own.`);
      }
      const head = (await run(repo, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
      const shared = [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ];
      let result: GitRun;
      if (entry?.status === "untracked") {
        // Exit status 1 only says that the two differ.
        result = await run(repo, [...shared, "--no-index", "--", "/dev/null", path]);
        if (result.code > 1) throw new GitFailure("git_failed", tail(result.output));
      } else {
        if (entry === null) {
          const inHead = (await run(repo, ["cat-file", "-e", `HEAD:${path}`])).code === 0;
          if (!inHead && !existsSync(join(repo, path))) {
            throw new GitFailure("not_found", `Nothing at ${path} in this repository`);
          }
        }
        const paths = entry?.old_path ? [entry.old_path, path] : [path];
        result = await run(repo, [...shared, "-M", head ? "HEAD" : EMPTY_TREE, "--", ...paths]);
        if (result.code !== 0) throw new GitFailure("git_failed", tail(result.output));
      }
      if (result.stdout.length > GIT_DIFF_LIMIT_BYTES) {
        return { kind: "too_large", limit: GIT_DIFF_LIMIT_BYTES };
      }
      const diff = result.stdout.toString("utf8");
      const firstHunk = diff.search(/^@@ /m);
      if (/^Binary files .* differ$/m.test(firstHunk === -1 ? diff : diff.slice(0, firstHunk))) {
        const before = await run(repo, ["cat-file", "-s", `HEAD:${entry?.old_path ?? path}`]);
        let after: number | null = null;
        try {
          after = statSync(join(repo, path)).size;
        } catch {
          // Deleted.
        }
        return {
          kind: "binary",
          old_size: before.code === 0 ? Number(before.stdout.toString("utf8").trim()) : null,
          new_size: after,
        };
      }
      return { kind: "text", diff };
    },

    "git.commit": async (params): Promise<GitCommitResult> => {
      const repo = await resolve(params.repo);
      const { message } = params;
      if (typeof message !== "string" || message.trim() === "") {
        throw new GitFailure("bad_request", "message must not be empty");
      }
      if (Buffer.byteLength(message, "utf8") > GIT_MESSAGE_LIMIT_BYTES) {
        throw new GitFailure("bad_request", "message is too long");
      }
      return exclusively(repo, async () => {
        const staged = await run(repo, ["add", "-A"]);
        if (staged.code !== 0) check(staged);
        const output = check(staged, await run(repo, ["commit", "-F", "-"], message));
        return {
          commit: (await read(repo, ["rev-parse", "HEAD"])).trim(),
          output,
          repo: await describe(repo),
        };
      });
    },

    "git.push": async (params): Promise<GitPushResult> => {
      const repo = await resolve(params.repo);
      return exclusively(repo, async () => {
        const status = await statusOf(repo);
        let args = ["push"];
        let published = false;
        if (status.branch !== null && status.upstream === null) {
          const remotes = (await read(repo, ["remote"])).split("\n").filter(Boolean);
          const remote = remotes.includes("origin") ? "origin" : remotes[0];
          if (remote === undefined) {
            throw new GitFailure(
              "failed",
              `${basename(repo)} has no remote, so there is nowhere to publish ${status.branch} to.`,
            );
          }
          args = ["push", "--set-upstream", remote, status.branch];
          published = true;
        }
        if (options.networkDelayMs > 0) await sleep(options.networkDelayMs);
        const output = check(await run(repo, args));
        return { output, published, repo: await describe(repo) };
      });
    },

    "git.pull": async (params): Promise<GitPullResult> => {
      const repo = await resolve(params.repo);
      return exclusively(repo, async () => {
        if (options.networkDelayMs > 0) await sleep(options.networkDelayMs);
        const output = check(await run(repo, ["pull", "--no-edit"]));
        return { output, repo: await describe(repo) };
      });
    },

    "git.discard": async (params): Promise<GitDiscardResult> => {
      const repo = await resolve(params.repo);
      const path = params.path == null ? null : repoPath(params.path, "path");
      const oldPath = params.old_path == null ? null : repoPath(params.old_path, "old_path");
      return exclusively(repo, async () => {
        if (path === null) {
          if ((await run(repo, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) {
            throw new GitFailure(
              "failed",
              `${basename(repo)} has no commit yet, so there is nothing to go back to.`,
            );
          }
          check(await run(repo, ["reset", "--hard", "HEAD"]), await run(repo, ["clean", "-fd"]));
        } else {
          const entry = await entryFor(repo, path, oldPath);
          if (entry?.status === "untracked") {
            check(await run(repo, ["clean", "-f", "--", path]));
          } else if (entry !== null) {
            const paths = entry.old_path ? [entry.old_path, path] : [path];
            check(
              await run(repo, [
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                ...paths,
              ]),
            );
          }
        }
        return { repo: await describe(repo) };
      });
    },
  };
}
