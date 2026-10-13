import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import type { TerminalController } from "@/lib/terminal/controller";
import { diffInput } from "@/lib/terminal/input-diff";

export type DirectInputHandle = { focus: () => void; blur: () => void };

type DirectInputProps = {
  ref: Ref<DirectInputHandle>;
  controller: TerminalController;
  onFocusChange: (focused: boolean) => void;
};

/**
 * What the field holds between keystrokes. An empty field tells nothing when Backspace is pressed
 * on a keyboard that does not report keys, so there is always one character to delete.
 */
const SENTINEL = " ";

/**
 * The text field an on-screen keyboard types into. It is invisible and sits just above the key bar,
 * so the browser has no reason to scroll the page to it. Keys the keyboard reports are sent as keys;
 * everything else is read from what happened to the field's text (see `input-diff.ts`), which holds
 * whether the keyboard composes, corrects, swipes or dictates. Autocorrect, capitalisation and
 * suggestions are off: a shell wants exactly what was typed.
 */
export function DirectInput({ ref, controller, onFocusChange }: DirectInputProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const last = useRef(SENTINEL);
  const composing = useRef(false);

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus({ preventScroll: true }),
    blur: () => field.current?.blur(),
  }));

  const settle = () => {
    const element = field.current;
    if (!element) return;
    element.value = SENTINEL;
    element.setSelectionRange(SENTINEL.length, SENTINEL.length);
    last.current = SENTINEL;
  };

  const flush = () => {
    const element = field.current;
    if (!element) return;
    const edit = diffInput(last.current, element.value);
    last.current = element.value;
    controller.erase(edit.erase);
    controller.type(edit.insert);
    // While a word is being composed the keyboard owns the field; clearing it would break the word.
    if (!composing.current) settle();
  };

  useEffect(settle, []);

  return (
    <textarea
      ref={field}
      aria-label="Terminal input"
      name="terminal-input"
      rows={1}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="enter"
      data-gramm="false"
      // Not in React's types yet: turns off Safari's inline predictions.
      {...{ writingsuggestions: "false" }}
      // 16px keeps iOS from zooming the page in when the field takes focus.
      className="pointer-events-none absolute bottom-full left-2 h-6 w-6 resize-none overflow-hidden border-0 bg-transparent p-0 text-[16px] text-transparent caret-transparent opacity-0 outline-none"
      onFocus={() => {
        settle();
        onFocusChange(true);
      }}
      onBlur={() => {
        composing.current = false;
        onFocusChange(false);
      }}
      onKeyDown={(event) => {
        if (controller.keyEvent(event.nativeEvent)) event.preventDefault();
      }}
      onInput={flush}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        // Browsers disagree on whether the last input event comes before or after this one, so the
        // field is read once both have had their turn.
        window.setTimeout(() => {
          composing.current = false;
          flush();
        }, 0);
      }}
      onPaste={(event) => {
        event.preventDefault();
        controller.paste(event.clipboardData.getData("text/plain"));
      }}
    />
  );
}
