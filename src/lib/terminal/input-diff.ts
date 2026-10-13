// Turns edits of the phone's hidden text field into terminal input. An on-screen keyboard does not
// report keys reliably: it rewrites the field (composition, autocorrect, swipe typing, dictation),
// so the field is compared before and after and the terminal gets the difference.

export type InputEdit = {
  /** How many characters to rub out first, counted in code points. */
  erase: number;
  insert: string;
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function diffInput(before: string, after: string): InputEdit {
  const limit = Math.min(before.length, after.length);
  let shared = 0;
  while (shared < limit && before.charCodeAt(shared) === after.charCodeAt(shared)) shared += 1;
  // Never split a surrogate pair: a changed emoji is erased and typed whole.
  if (shared > 0 && isHighSurrogate(before.charCodeAt(shared - 1))) shared -= 1;
  return { erase: [...before.slice(shared)].length, insert: after.slice(shared) };
}
