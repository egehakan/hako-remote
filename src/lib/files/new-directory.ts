// The name of a directory made from here, held to the rule `fs.mkdir` holds it to, so that a name
// the Mac would refuse is refused before it is asked.

import { NAME_MAX_BYTES, nameBytes, nameProblem } from "../../../shared/files.ts";

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Decides whether what was typed can name a new directory beside `siblings`, the names already in
 * the directory it is made in. Spaces at either end are dropped: a phone's keyboard adds them, and
 * a name that ends in one is a trap.
 */
export function checkDirectoryName(typed: string, siblings: readonly string[] = []): NameCheck {
  const name = typed.trim();
  switch (nameProblem(name)) {
    case "empty":
      return { ok: false, reason: "Give the new directory a name." };
    case "reserved":
      return {
        ok: false,
        reason: `“${name}” already means ${name === "." ? "this directory" : "the directory above"}.`,
      };
    case "slash":
      return {
        ok: false,
        reason: "A name can’t contain “/”. Directories are made one at a time.",
      };
    case "nul":
      return { ok: false, reason: "A name can’t contain a NUL character." };
    case "too_long":
      return {
        ok: false,
        reason: `That name is ${nameBytes(name)} bytes long. A name can be ${NAME_MAX_BYTES} at most.`,
      };
    case null:
      break;
  }
  if (siblings.includes(name)) return { ok: false, reason: `“${name}” is already here.` };
  return { ok: true, name };
}
