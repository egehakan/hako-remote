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
  GIT_BODY_LIMIT_BYTES,
  GIT_BRANCH_LIMIT,
  GIT_COMMAND_LIMIT_MS,
  GIT_DIFF_LIMIT_BYTES,
  GIT_LOG_DEFAULT_LIMIT,
  GIT_LOG_MAX_LIMIT,
  GIT_MESSAGE_LIMIT_BYTES,
  GIT_OUTPUT_LIMIT_BYTES,
  GIT_STATUS_LIMIT,
  GIT_SUBJECT_LIMIT,
  isCommitId,
  isValidRepoPath,
  type ParsedStatus,
  parseNumstat,
  parseStatus,
  type StatusEntry,
} from "../shared/git.ts";
import type {
  ErrorCode,
  GitBranch,
  GitBranchesResult,
  GitCommit,
  GitCommitResult,
  GitDiffResult,
  GitDiscardResult,
  GitFile,
  GitFileState,
  GitLogResult,
  GitOperation,
  GitRef,
  GitShowResult,
  GitSwitchResult,
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

/** How many commits the notes have: enough to page through, and to see that a long list stays quick. */
const JOURNAL_COMMITS = 2_400;
const JOURNAL_SIDE_REF = "refs/heads/review-in-progress";

/**
 * A long history for `git fast-import`: one entry of a journal every few hours, and now and then a
 * side line of two commits that is merged back.
 */
function journalHistory(now: number): string {
  const lines: string[] = [];
  const person = "Mock Owner <owner@hako.invalid>";
  let mark = 0;
  const commit = (
    ref: string,
    message: string,
    time: number,
    parents: number[],
    file: string,
    text: string,
  ): number => {
    mark += 1;
    lines.push(
      `commit ${ref}`,
      `mark :${mark}`,
      `author ${person} ${time} +0000`,
      `committer ${person} ${time} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
    );
    if (parents.length > 0) lines.push(`from :${parents[0]}`);
    for (const parent of parents.slice(1)) lines.push(`merge :${parent}`);
    lines.push(`M 100644 inline ${file}`, `data ${Buffer.byteLength(text)}`, text);
    return mark;
  };
  const main = "refs/heads/main";
  const step = 5 * 3600;
  let time = now - (JOURNAL_COMMITS + 40) * step;
  let tip = 0;
  for (let entry = 1; mark < JOURNAL_COMMITS; entry++) {
    time += step;
    if (tip !== 0 && entry % 37 === 5) {
      const draft = commit(
        JOURNAL_SIDE_REF,
        `Draft the review of entry ${entry}`,
        time - 7200,
        [tip],
        "reviews/draft.md",
        `Entry ${entry}, first pass.\n`,
      );
      const done = commit(
        JOURNAL_SIDE_REF,
        `Finish the review of entry ${entry}`,
        time - 3600,
        [draft],
        "reviews/draft.md",
        `Entry ${entry}, done.\n`,
      );
      tip = commit(
        main,
        `Merge the review of entry ${entry}`,
        time,
        [tip, done],
        "journal/today.md",
        `Entry ${entry}, with its review.\n`,
      );
    } else {
      tip = commit(
        main,
        `Journal: entry ${entry}`,
        time,
        tip === 0 ? [] : [tip],
        "journal/today.md",
        `Entry ${entry}.\n`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
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
  const DAY = 86_400;
  const now = Math.floor(Date.now() / 1000);
  /** When the commits made from here on say they were made; null is the moment they are made. */
  let stamp: string | null = null;
  const at = (daysAgo: number) => {
    stamp = `${now - Math.round(daysAgo * DAY)} +0000`;
  };
  const git = (cwd: string, ...args: string[]): string => {
    const dated =
      stamp === null ? env : { ...env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
    const result = spawnSync("git", args, { cwd, env: dated, encoding: "utf8" });
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
  at(21);
  commitAll(hako, "Start the terminal");
  write(join(hako, "app/src/remote/protocol.rs"), PROTOCOL_RS);
  write(join(hako, "docs/remote.md"), REMOTE_MD);
  at(12);
  commitAll(hako, "Add the remote protocol");
  // A branch that changes a file the working tree has changed too, so git refuses to switch to
  // it, and one that does not, which the changes are carried over to.
  git(hako, "switch", "-q", "-c", "protocol-v2");
  write(
    join(hako, "app/src/remote/protocol.rs"),
    PROTOCOL_RS.replace("PROTOCOL_VERSION: u32 = 1", "PROTOCOL_VERSION: u32 = 2"),
  );
  at(5);
  commitAll(hako, "Number the protocol 2");
  git(hako, "switch", "-q", "-c", "spike/key-bar", "main");
  write(
    join(hako, "notes/key-bar.md"),
    "# A key bar\n\nEsc, Tab, Ctrl and the arrows, in reach.\n",
  );
  at(3);
  commitAll(hako, "Sketch a key bar");
  git(hako, "switch", "-q", "main");
  stamp = null;

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

  // A repository that has no commit yet.
  const sketch = join(remote, "fixtures/sketch");
  init(sketch);
  write(join(sketch, "idea.txt"), "A graph of the commits, as an editor draws it.\n");

  // Notes: nothing to commit, and nowhere to push.
  const notes = join(home, "Notes");
  init(notes);
  const journal = spawnSync("git", ["fast-import", "--quiet"], {
    cwd: notes,
    env,
    input: journalHistory(now),
  });
  if (journal.status !== 0) throw new Error(`git fast-import failed: ${journal.stderr}`);
  git(notes, "update-ref", "-d", JOURNAL_SIDE_REF);
  git(notes, "reset", "-q", "--hard", "main");
  commitAll(notes, "Start the notes");

  // egehakan.com: a remote that has moved on, a commit that is not pushed, and the two in conflict.
  const site = join(code, "egehakan.com");
  const bare = join(home, REMOTES, "egehakan.com.git");
  const teammate = join(home, REMOTES, "teammate");
  init(site);
  git(site, "config", "pull.rebase", "false");
  at(34);
  commitAll(site, "Publish the site");
  write(join(site, "reset.css"), "* {\n  box-sizing: border-box;\n  margin: 0;\n}\n");
  at(30);
  commitAll(site, "Add a stylesheet reset");
  // A branch that was merged back, so the history has two lines that part and meet.
  git(site, "switch", "-q", "-c", "feature/dark-mode");
  write(join(site, "dark.css"), ":root {\n  --paper: #0c0d11;\n  --ink: #ece6da;\n}\n");
  at(27);
  commitAll(site, "Add dark colours");
  write(
    join(site, "dark.css"),
    "@media (prefers-color-scheme: dark) {\n  :root {\n    --paper: #0c0d11;\n    --ink: #ece6da;\n  }\n}\n",
  );
  at(26);
  commitAll(site, "Follow the system's colour scheme");
  git(site, "switch", "-q", "main");
  mkdirSync(join(site, "css"));
  git(site, "mv", "reset.css", "css/reset.css");
  write(
    join(site, "css/reset.css"),
    "* {\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n}\n",
  );
  at(25);
  commitAll(site, "Move the reset beside the other styles");
  at(22);
  git(
    site,
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'feature/dark-mode'\n\nDark colours, chosen by the system setting.\nThe light ones stay the default.",
    "feature/dark-mode",
  );
  git(site, "tag", "v1.0.0");
  git(site, "branch", "release/1.0");
  write(join(site, "footer.html"), "<footer>\n  <p>Made in a terminal.</p>\n</footer>\n");
  at(15);
  commitAll(site, "Add a footer");
  mkdirSync(dirname(bare), { recursive: true });
  git(dirname(bare), "init", "-q", "--bare", "-b", "main", bare);
  git(site, "remote", "add", "origin", bare);
  git(site, "push", "-q", "-u", "origin", "main");
  git(site, "push", "-q", "-u", "origin", "feature/dark-mode");
  git(site, "push", "-q", "-u", "origin", "release/1.0");
  git(site, "worktree", "add", "-q", "-b", "redesign", join(code, "egehakan.com-redesign"));

  // A branch with a commit its remote has not got, and one that is on no remote at all.
  git(site, "switch", "-q", "feature/dark-mode");
  write(
    join(site, "dark.css"),
    readFileSync(join(site, "dark.css"), "utf8").replace("#0c0d11", "#12100c"),
  );
  at(12);
  commitAll(site, "Try a warmer black");
  git(site, "switch", "-q", "-c", "fix/title-typo", "main");
  write(join(site, "footer.html"), "<footer>\n  <p>Made in a terminal, on a Mac.</p>\n</footer>\n");
  at(11);
  commitAll(site, "Say where it was made");
  git(site, "switch", "-q", "main");

  git(dirname(bare), "clone", "-q", bare, teammate);
  identify(teammate, "Teammate", "teammate@hako.invalid");
  // A branch that exists on the remote only.
  git(teammate, "switch", "-q", "-c", "feature/contact-form");
  write(
    join(teammate, "contact.html"),
    '<!doctype html>\n<title>Contact</title>\n<form action="/contact" method="post">\n  <input name="email" type="email" />\n</form>\n',
  );
  at(9);
  commitAll(teammate, "Add a contact form");
  write(
    join(teammate, "contact.html"),
    '<!doctype html>\n<title>Contact</title>\n<form action="/contact" method="post">\n  <label>Email <input name="email" type="email" /></label>\n</form>\n',
  );
  at(8);
  commitAll(teammate, "Label the field");
  git(teammate, "push", "-q", "origin", "feature/contact-form");
  git(teammate, "switch", "-q", "main");
  const page = readFileSync(join(site, "index.html"), "utf8");
  write(
    join(teammate, "index.html"),
    page.replace("<title>Hako</title>", "<title>Ege Hakan Karaağaç</title>"),
  );
  at(3);
  commitAll(teammate, "Put the full name in the title");
  git(teammate, "push", "-q", "origin", "HEAD:main");
  write(
    join(site, "footer.html"),
    '<footer>\n  <p>Made in a terminal.</p>\n  <a href="https://github.com/egehakan">Source</a>\n</footer>\n',
  );
  at(2);
  commitAll(site, "Link to the source");
  write(
    join(site, "index.html"),
    page.replace("<title>Hako</title>", "<title>egehakan.com</title>"),
  );
  at(1);
  commitAll(site, "Use the address as the title");
  git(site, "fetch", "-q", "origin");

  // The linked worktree: a branch that has never been pushed, with work in progress.
  const redesign = join(code, "egehakan.com-redesign");
  write(join(redesign, "header.html"), "<header>\n  <h1>egehakan.com</h1>\n</header>\n");
  at(6);
  commitAll(redesign, "Sketch the new header");
  stamp = null;
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
  /** False leaves out branches, switching and history, as a desktop app from before them would. */
  history: boolean;
  /** Makes a switch of branch take this much longer, as a checkout of a huge tree would. */
  switchDelayMs: number;
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

  const DIFF_OPTIONS = [
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

  /** The hash a revision names, or null when it names nothing. */
  async function hashOf(repo: string, revision: string): Promise<string | null> {
    const result = await run(repo, ["rev-parse", "--verify", "-q", `${revision}^{commit}`]);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
  }

  async function currentBranch(repo: string): Promise<string | null> {
    const result = await run(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
    return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
  }

  /** A path as the mock names its repositories, for one that git spelled its own way. */
  function knownPath(path: string): string {
    for (const candidate of known.keys()) {
      try {
        if (realpathSync(candidate) === realpathSync(path)) return candidate;
      } catch {
        // A working tree that has been deleted.
      }
    }
    return path;
  }

  const REF_ORDER: Record<GitRef["kind"], number> = { head: 0, local: 1, remote: 2, tag: 3 };

  /** The branches and tags by the commit each points at, without `origin/HEAD` and the stash. */
  async function refsByCommit(
    repo: string,
    head: string | null,
    current: string | null,
  ): Promise<Map<string, GitRef[]>> {
    const refs = new Map<string, GitRef[]>();
    const add = (commit: string, ref: GitRef) => {
      const list = refs.get(commit);
      if (list) list.push(ref);
      else refs.set(commit, [ref]);
    };
    if (head !== null && current === null) add(head, { name: "HEAD", kind: "head" });
    const listing = await read(repo, [
      "for-each-ref",
      "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    for (const line of listing.split("\n")) {
      const [object, peeled, name, symref] = line.split("\0");
      if (!name || symref) continue;
      const commit = peeled || object;
      if (name.startsWith("refs/heads/")) {
        const branch = name.slice(11);
        add(commit, { name: branch, kind: branch === current ? "head" : "local" });
      } else if (name.startsWith("refs/remotes/")) {
        add(commit, { name: name.slice(13), kind: "remote" });
      } else {
        add(commit, { name: name.slice(10), kind: "tag" });
      }
    }
    for (const list of refs.values()) {
      list.sort((a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind] || (a.name < b.name ? -1 : 1));
    }
    return refs;
  }

  type Sides = { local: Set<string>; remote: Set<string> };

  /** The commits only HEAD has and the commits only its upstream has. */
  async function sidesOf(
    repo: string,
    head: string | null,
    upstream: string | null,
  ): Promise<Sides> {
    const sides: Sides = { local: new Set(), remote: new Set() };
    if (upstream === null) return sides;
    // Before the first commit here, everything the upstream has is still to be pulled.
    if (head === null) {
      for (const id of (await read(repo, ["rev-list", upstream])).split("\n")) sides.remote.add(id);
      return sides;
    }
    const only = async (range: string) =>
      (await read(repo, ["rev-list", range])).split("\n").filter(Boolean);
    for (const id of await only(`${upstream}..${head}`)) sides.local.add(id);
    for (const id of await only(`${head}..${upstream}`)) sides.remote.add(id);
    return sides;
  }

  const COMMIT_FORMAT = "%H%x1f%P%x1f%aN%x1f%at%x1f%s";

  function cut(text: string, limit: number): string {
    const characters = Array.from(text);
    return characters.length > limit ? characters.slice(0, limit).join("") : text;
  }

  function toCommit(record: string, refs: Map<string, GitRef[]>, sides: Sides): GitCommit {
    const [id, parents, author, time, subject] = record.split("\x1f");
    return {
      id,
      parents: parents === "" ? [] : parents.split(" "),
      subject: cut(subject ?? "", GIT_SUBJECT_LIMIT),
      author,
      time: Number(time) * 1000,
      refs: refs.get(id) ?? [],
      side: sides.local.has(id) ? "local" : sides.remote.has(id) ? "remote" : "both",
    };
  }

  /** What every commit of a repository is described against: where HEAD and its upstream are. */
  async function standing(repo: string) {
    const head = await hashOf(repo, "HEAD");
    const current = await currentBranch(repo);
    const upstream = current === null ? null : await hashOf(repo, "@{upstream}");
    return {
      head,
      upstream,
      refs: await refsByCommit(repo, head, current),
      sides: await sidesOf(repo, head, upstream),
    };
  }

  /** A commit named by a request: its full hash, and what it is compared with. */
  async function commitNamed(repo: string, value: unknown): Promise<{ id: string; base: string }> {
    if (!isCommitId(value)) {
      throw new GitFailure("bad_request", "commit must be a hash of 4 to 64 hexadecimal digits");
    }
    const id = await hashOf(repo, value);
    if (id === null) throw new GitFailure("not_found", `No commit ${value} in this repository`);
    return { id, base: (await hashOf(repo, `${id}^1`)) ?? EMPTY_TREE };
  }

  const NAME_STATES: Record<string, GitFileState> = {
    A: "added",
    C: "added",
    D: "deleted",
    M: "modified",
    T: "modified",
    R: "renamed",
  };

  /** One file's change in a commit, in the shapes of `git.diff`. */
  async function diffInCommit(
    repo: string,
    commit: unknown,
    path: string,
    oldPath: string | null,
  ): Promise<GitDiffResult> {
    const { id, base } = await commitNamed(repo, commit);
    const has = async (tree: string, file: string) =>
      (await run(repo, ["cat-file", "-e", `${tree}:${file}`])).code === 0;
    const from = oldPath ?? path;
    const before = base !== EMPTY_TREE && (await has(base, from));
    if (!before && !(await has(id, path))) {
      throw new GitFailure("not_found", `Nothing at ${path} in commit ${id.slice(0, 7)}`);
    }
    const paths = oldPath === null ? [path] : [oldPath, path];
    const result = await run(repo, [...DIFF_OPTIONS, "-M", base, id, "--", ...paths]);
    if (result.code !== 0) throw new GitFailure("git_failed", tail(result.output));
    if (result.stdout.length > GIT_DIFF_LIMIT_BYTES) {
      return { kind: "too_large", limit: GIT_DIFF_LIMIT_BYTES };
    }
    const diff = result.stdout.toString("utf8");
    const firstHunk = diff.search(/^@@ /m);
    if (/^Binary files .* differ$/m.test(firstHunk === -1 ? diff : diff.slice(0, firstHunk))) {
      const size = async (tree: string, file: string) => {
        const measured = await run(repo, ["cat-file", "-s", `${tree}:${file}`]);
        return measured.code === 0 ? Number(measured.stdout.toString("utf8").trim()) : null;
      };
      return {
        kind: "binary",
        old_size: before ? await size(base, from) : null,
        new_size: await size(id, path),
      };
    }
    return { kind: "text", diff };
  }

  const history: Record<string, Method> = {
    "git.branches": async (params): Promise<GitBranchesResult> => {
      const repo = await resolve(params.repo);
      const current = await currentBranch(repo);
      const listing = await read(repo, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(symref)%00%(contents:subject)%1e",
        "refs/heads",
        "refs/remotes",
      ]);
      const local: GitBranch[] = [];
      const remote: GitBranch[] = [];
      for (const record of listing.split("\x1e")) {
        const [ref, tip, time, upstream, track, worktree, symref, subject] = record
          .replace(/^\n/, "")
          .split("\0");
        if (!ref || symref) continue;
        const shared = { tip, time: Number(time) * 1000, subject: cut(subject, GIT_SUBJECT_LIMIT) };
        if (ref.startsWith("refs/remotes/")) {
          remote.push({
            name: ref.slice(13),
            kind: "remote",
            ...shared,
            upstream: null,
            ahead: null,
            behind: null,
            worktree: null,
          });
          continue;
        }
        // An upstream that is configured but gone is as good as none.
        const tracking = upstream !== "" && track !== "gone";
        const elsewhere = worktree === "" ? null : knownPath(worktree);
        local.push({
          name: ref.slice(11),
          kind: "local",
          ...shared,
          upstream: tracking ? upstream : null,
          ahead: tracking ? Number(/ahead (\d+)/.exec(track)?.[1] ?? 0) : null,
          behind: tracking ? Number(/behind (\d+)/.exec(track)?.[1] ?? 0) : null,
          worktree: elsewhere === repo ? null : elsewhere,
        });
      }
      const newest = (a: GitBranch, b: GitBranch) =>
        b.time - a.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const tracked = new Set(local.map((branch) => branch.upstream));
      const branches = [
        ...local.sort(newest),
        ...remote.filter((branch) => !tracked.has(branch.name)).sort(newest),
      ];
      return {
        current,
        detached: current === null,
        head: await hashOf(repo, "HEAD"),
        branches: branches.slice(0, GIT_BRANCH_LIMIT),
        truncated: branches.length > GIT_BRANCH_LIMIT,
      };
    },

    "git.switch": async (params): Promise<GitSwitchResult> => {
      const repo = await resolve(params.repo);
      const { branch, kind } = params;
      if (kind !== "local" && kind !== "remote" && kind !== "new") {
        throw new GitFailure("bad_request", "kind must be local, remote or new");
      }
      if (typeof branch !== "string" || branch === "") {
        throw new GitFailure("bad_request", "branch must be the name of a branch");
      }
      // Git prints the name it understood, which differs for shorthand such as `@{-1}`.
      const checked = await run(repo, ["check-ref-format", "--branch", branch]);
      if (checked.code !== 0 || checked.stdout.toString("utf8").trim() !== branch) {
        throw new GitFailure("bad_request", `${JSON.stringify(branch)} is not a branch name`);
      }
      const args =
        kind === "local"
          ? ["switch", branch]
          : kind === "remote"
            ? ["switch", "--track", branch]
            : ["switch", "-c", branch];
      return exclusively(repo, async () => {
        if (options.switchDelayMs > 0) await sleep(options.switchDelayMs);
        check(await run(repo, args));
        return { current: await currentBranch(repo), head: await hashOf(repo, "HEAD") };
      });
    },

    "git.log": async (params): Promise<GitLogResult> => {
      const repo = await resolve(params.repo);
      const limit = params.limit ?? GIT_LOG_DEFAULT_LIMIT;
      const skip = params.skip ?? 0;
      if (
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > GIT_LOG_MAX_LIMIT
      ) {
        throw new GitFailure(
          "bad_request",
          `limit must be a whole number from 1 to ${GIT_LOG_MAX_LIMIT}`,
        );
      }
      if (!Number.isInteger(skip) || (skip as number) < 0) {
        throw new GitFailure("bad_request", "skip must be a whole number, 0 or more");
      }
      const { head, upstream, refs, sides } = await standing(repo);
      if (head === null && upstream === null) {
        return { commits: [], has_more: false, head: null, upstream: null };
      }
      const records = (
        await read(repo, [
          "log",
          "--topo-order",
          "-z",
          `--format=${COMMIT_FORMAT}`,
          `--skip=${skip}`,
          "-n",
          String((limit as number) + 1),
          ...[head, upstream].filter((tip) => tip !== null),
        ])
      )
        .split("\0")
        .filter(Boolean);
      return {
        commits: records.slice(0, limit as number).map((record) => toCommit(record, refs, sides)),
        has_more: records.length > (limit as number),
        head,
        upstream,
      };
    },

    "git.show": async (params): Promise<GitShowResult> => {
      const repo = await resolve(params.repo);
      const { id, base } = await commitNamed(repo, params.commit);
      const { refs, sides } = await standing(repo);
      const record = await read(repo, ["log", "-1", `--format=${COMMIT_FORMAT}`, id]);
      const body = Buffer.from((await read(repo, ["log", "-1", "--format=%b", id])).trim(), "utf8");
      const counts = parseNumstat(await read(repo, ["diff", "--numstat", "-M", "-z", base, id]));
      const names = (await read(repo, ["diff", "--name-status", "-M", "-z", base, id])).split("\0");
      const files: GitFile[] = [];
      for (let index = 0; index + 1 < names.length; index++) {
        const status = NAME_STATES[names[index][0]] ?? "modified";
        const renamed = names[index][0] === "R" || names[index][0] === "C";
        const oldPath = renamed ? names[++index] : null;
        const path = names[++index];
        const count = counts.get(path);
        files.push({
          path,
          old_path: status === "renamed" ? oldPath : null,
          status,
          additions: count ? count.additions : 0,
          deletions: count ? count.deletions : 0,
          binary: count?.binary ?? false,
        });
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return {
        commit: toCommit(record.replace(/\n$/, ""), refs, sides),
        body: body.subarray(0, GIT_BODY_LIMIT_BYTES).toString("utf8"),
        files: files.slice(0, GIT_STATUS_LIMIT),
        truncated: files.length > GIT_STATUS_LIMIT,
      };
    },
  };

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
    ...(options.history ? history : {}),

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
      if (options.history && params.commit != null) {
        return diffInCommit(repo, params.commit, path, oldPath);
      }
      const entry = await entryFor(repo, path, oldPath);
      if (statSync(join(repo, path), { throwIfNoEntry: false })?.isDirectory()) {
        throw new GitFailure("failed", `${path} is a directory, which has no diff of its own.`);
      }
      const head = (await run(repo, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
      const shared = DIFF_OPTIONS;
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
