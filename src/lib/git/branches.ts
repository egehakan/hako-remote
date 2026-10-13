// Branches as the picker lists them, and the name a new one may have.

import type { GitBranch } from "../../../shared/protocol.ts";

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

const FORBIDDEN = /[ ~^:?*[\\]/;

function hasControlCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Decides whether what was typed can name a new branch, by the rules of
 * `git check-ref-format --branch`, so that a name git would refuse is refused before it is sent.
 * `taken` are the names of the local branches there already are.
 */
export function checkBranchName(typed: string, taken: readonly string[] = []): NameCheck {
  const name = typed.trim();
  const no = (reason: string): NameCheck => ({ ok: false, reason });
  if (name === "") return no("Give the new branch a name.");
  if (/\s/.test(name)) return no("A branch name can’t contain spaces. Use “-” or “/” instead.");
  if (hasControlCharacter(name)) return no("A branch name can’t contain control characters.");
  const forbidden = FORBIDDEN.exec(name);
  if (forbidden) return no(`A branch name can’t contain “${forbidden[0]}”.`);
  if (name.startsWith("-")) return no("A branch name can’t start with “-”.");
  if (name === "@" || name === "HEAD") return no(`“${name}” already means the current commit.`);
  if (name.includes("@{")) return no("A branch name can’t contain “@{”.");
  if (name.includes("..")) return no("A branch name can’t contain two dots in a row.");
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return no("“/” separates the parts of a name, so it can’t start or end one, or be doubled.");
  }
  if (name.endsWith(".")) return no("A branch name can’t end with a dot.");
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return no("No part of a branch name can start with a dot.");
    if (part.endsWith(".lock")) return no("No part of a branch name can end with “.lock”.");
  }
  if (new TextEncoder().encode(name).length > 200) return no("That name is too long.");
  if (taken.includes(name)) return no(`There is a branch called “${name}” already.`);
  // Git keeps a branch as a file named after it, so one name can't be a directory of another.
  const clash = taken.find((other) => name.startsWith(`${other}/`) || other.startsWith(`${name}/`));
  if (clash)
    return no(`Git can’t keep both “${clash}” and “${name}”: one would sit inside the other.`);
  return { ok: true, name };
}

/** The local name `git switch --track` gives a remote branch: `origin/feature/x` becomes `feature/x`. */
export function localNameOf(remoteBranch: string): string {
  const cut = remoteBranch.indexOf("/");
  return cut === -1 ? remoteBranch : remoteBranch.slice(cut + 1);
}

export type BranchGroups = { local: GitBranch[]; remote: GitBranch[] };

/** The branches that match what was typed, in the order the Mac listed them, by kind. */
export function filterBranches(branches: readonly GitBranch[], needle: string): BranchGroups {
  const wanted = needle.trim().toLowerCase();
  const groups: BranchGroups = { local: [], remote: [] };
  for (const branch of branches) {
    if (wanted !== "" && !branch.name.toLowerCase().includes(wanted)) continue;
    groups[branch.kind].push(branch);
  }
  return groups;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const DATE_YEAR = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** How long ago a commit was made, as briefly as a narrow row needs it: `3 h ago`, `12 Mar`. */
export function timeAgo(time: number, now = Date.now()): string {
  const age = now - time;
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 2 * DAY) return "yesterday";
  if (age < 14 * DAY) return `${Math.floor(age / DAY)} days ago`;
  if (age < 8 * 7 * DAY) return `${Math.floor(age / (7 * DAY))} weeks ago`;
  const then = new Date(time);
  return then.getFullYear() === new Date(now).getFullYear()
    ? DATE.format(then)
    : DATE_YEAR.format(then);
}
