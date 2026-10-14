// A name typed for a new file or folder, or for renaming one, held to the protocol's name rule
// before the Mac is asked.

import { NAME_MAX_BYTES, nameBytes, nameProblem } from "../../../shared/files.ts";
import { sameNameKey } from "../../../shared/operations.ts";

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Decides whether what was typed can name an entry beside `siblings`. `current` is the entry's
 * own name when renaming, which may change its letter case. Spaces at either end are dropped.
 */
export function checkEntryName(
  typed: string,
  siblings: readonly string[],
  current: string | null = null,
): NameCheck {
  const name = typed.trim();
  switch (nameProblem(name)) {
    case "empty":
      return { ok: false, reason: "Give it a name." };
    case "reserved":
      return { ok: false, reason: `“${name}” is reserved.` };
    case "slash":
      return { ok: false, reason: "A name can’t contain “/”." };
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
  const key = sameNameKey(name);
  const own = current === null ? null : sameNameKey(current);
  if (key !== own && siblings.some((sibling) => sameNameKey(sibling) === key)) {
    return { ok: false, reason: `“${name}” is already here.` };
  }
  return { ok: true, name };
}
