// Types and constants for docs/protocol.md. Shared by the relay, the web client and the mock agent.

export const PROTOCOL_VERSION = 1;

export const PING_INTERVAL_MS = 25_000;
export const IDLE_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 20_000;
/** The shortest and the longest time a request may ask the relay to wait for its answer. */
export const REQUEST_TIMEOUT_MIN_MS = 1_000;
export const REQUEST_TIMEOUT_MAX_MS = 600_000;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const CLOSE_REPLACED = 4001;
export const CLOSE_SESSION_ENDED = 4401;

export type ErrorCode =
  | "agent_offline"
  | "timeout"
  | "bad_request"
  | "not_found"
  | "not_supported"
  | "failed"
  // The file methods' own.
  | "not_a_directory"
  | "is_a_directory"
  | "permission_denied"
  | "conflict"
  | "too_large"
  // Source control's own.
  | "git_failed"
  | "busy";

export type RpcError = { code: ErrorCode; message: string };

export type RequestFrame = {
  t: "req";
  id: string;
  method: string;
  params?: unknown;
  /** How long the relay waits for the answer, when the default is too short. Client to relay only. */
  timeout_ms?: number;
};
export type ResponseFrame =
  | { t: "res"; id: string; ok: true; result: unknown }
  | { t: "res"; id: string; ok: false; error: RpcError };
export type NotificationFrame = { t: "ntf"; method: string; params?: unknown };
export type EventFrame = { t: "evt"; event: string; data: unknown };
export type PingFrame = { t: "ping" };
export type PongFrame = { t: "pong" };

export type Frame =
  RequestFrame | ResponseFrame | NotificationFrame | EventFrame | PingFrame | PongFrame;

export type AgentStatus = {
  online: boolean;
  name?: string;
  version?: string;
  hostname?: string;
};

export type AppInfo = { name: string; version: string; hostname: string; protocol: number };

export type AgentState = {
  name: string;
  status: "working" | "waiting" | "done" | "failed";
  message: string | null;
};

export type Pane = {
  id: string;
  kind: "terminal" | "file" | "other";
  title: string;
  focused: boolean;
  session_id: string | null;
  cwd: string | null;
  agent: AgentState | null;
};

export type Tab = {
  id: string;
  title: string;
  active: boolean;
  folder_id: string | null;
  panes: Pane[];
};

export type Folder = {
  id: string;
  name: string;
  directory: string;
  color: string | null;
  icon: string | null;
};

export type Window = { id: string; active: boolean; folders: Folder[]; tabs: Tab[] };

export type Workspace = { windows: Window[] };

export type TabCreateParams = { window_id?: string; folder_id?: string; directory?: string };
export type TabCreateResult = { tab_id: string; session_id: string };

export type TermSubscribeResult = { cols: number; rows: number; seq: number; snapshot: string };

export type TerminalTheme = {
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
    ansi: string[];
  };
  font_family: string;
  font_size: number;
};

export type FsRoot = { path: string; name: string; source: "folder" | "terminal" | "home" };

export type FsEntry = {
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  /** What a symlink points to, or null when it points nowhere. Null for every other kind. */
  target: "dir" | "file" | "other" | null;
  size: number;
  mtime: number;
};

export type FsRootsResult = { home: string; roots: FsRoot[] };
export type FsListResult = { entries: FsEntry[]; truncated: boolean };

export type FsReadResult =
  | { kind: "text"; content: string; mtime: number; size: number }
  | { kind: "image"; mime: string; data: string; mtime: number; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too_large"; size: number; limit: number };

export type FsWriteParams = { path: string; content: string; expected_mtime: number | null };
export type FsWriteResult = { mtime: number; size: number };

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export type GitRepo = {
  /** The root of the working tree, which is how every other method names the repository. */
  path: string;
  name: string;
  /** The folder directory the repository belongs to. */
  root: string;
  is_worktree: boolean;
  /** For a linked worktree, the working tree of the repository it belongs to. */
  main_path: string | null;
  /** Null when HEAD is detached. */
  branch: string | null;
  /** The full id of the commit HEAD is at, or null before the first commit. */
  head: string | null;
  /** The branch this one tracks, such as `origin/main`, or null when it tracks none. */
  upstream: string | null;
  ahead: number;
  behind: number;
  changed: number;
  operation: GitOperation | null;
};

export type GitFileState =
  "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export type GitFile = {
  /** Relative to the repository's `path`. */
  path: string;
  /** Where a renamed file was before; null for every other status. */
  old_path: string | null;
  status: GitFileState;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type GitReposResult = { repos: GitRepo[] };
export type GitStatusResult = { repo: GitRepo; files: GitFile[]; truncated: boolean };

export type GitDiffParams = { repo: string; path: string; old_path?: string | null };
export type GitDiffResult =
  | { kind: "text"; diff: string }
  | { kind: "binary"; old_size: number | null; new_size: number | null }
  | { kind: "too_large"; limit: number };

export type GitCommitResult = { commit: string; output: string; repo: GitRepo };
export type GitPushResult = { output: string; published: boolean; repo: GitRepo };
export type GitPullResult = { output: string; repo: GitRepo };
export type GitDiscardResult = { repo: GitRepo };

/** `repo` is null when more than one repository, or the set of repositories, may have changed. */
export type GitChangedEvent = { repo: string | null };
