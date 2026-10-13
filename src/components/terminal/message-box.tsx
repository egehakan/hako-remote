import { SendHorizontalIcon } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TerminalController } from "@/lib/terminal/controller";

export type MessageBoxHandle = { focus: () => void; blur: () => void };

type MessageBoxProps = {
  ref: Ref<MessageBoxHandle>;
  controller: TerminalController;
  sessionId: string;
  enabled: boolean;
  onFocusChange: (focused: boolean) => void;
};

/** Unsent text per terminal, so switching terminals or modes does not lose a half-written prompt. */
const drafts = new Map<string, string>();

const MAX_HEIGHT_PX = 144;

/**
 * A place to write a longer message in comfort, with the keyboard's autocorrect and dictation, and
 * send it to the terminal in one go. "Send" presses Enter after the text; "Insert" does not.
 */
export function MessageBox({
  ref,
  controller,
  sessionId,
  enabled,
  onFocusChange,
}: MessageBoxProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(sessionId) ?? "");

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus({ preventScroll: true }),
    blur: () => field.current?.blur(),
  }));

  useEffect(() => {
    drafts.set(sessionId, text);
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [sessionId, text]);

  const send = (enter: boolean) => {
    if (!enabled) return;
    controller.message(text, enter);
    setText("");
  };

  return (
    <div className="flex items-end gap-1.5 px-1 pt-1.5">
      <textarea
        ref={field}
        aria-label="Message for the terminal"
        name="message"
        autoComplete="off"
        placeholder="Write a message…"
        rows={1}
        value={text}
        enterKeyHint="enter"
        className="min-h-10 min-w-0 flex-1 resize-none rounded-md border border-input bg-well px-2.5 py-2 font-mono text-[16px] leading-6 outline-none placeholder:text-faint focus-visible:border-ring"
        onChange={(event) => setText(event.target.value)}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onKeyDown={(event) => {
          // On a hardware keyboard Enter is a new line, as in any message field, and Cmd or Ctrl
          // with Enter sends.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send(true);
          }
        }}
      />
      <Button
        variant="secondary"
        className="h-10 px-3 text-sm"
        disabled={!enabled || text === ""}
        title="Write the text without pressing Enter"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => send(false)}
      >
        Insert
      </Button>
      <Button
        className="h-10 px-3 text-sm"
        disabled={!enabled}
        title="Write the text and press Enter"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => send(true)}
      >
        Send
        <SendHorizontalIcon data-icon="inline-end" />
      </Button>
    </div>
  );
}
