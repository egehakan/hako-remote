import { ArrowRightToLineIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { KeyButton } from "@/components/terminal/key-button";
import type { CodeEditor } from "@/lib/files/editor";
import { cn } from "@/lib/utils";

const SYMBOLS = [
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "<",
  ">",
  "=",
  ";",
  ":",
  '"',
  "'",
  "`",
  "/",
  "\\",
  "|",
  "&",
  "_",
  "-",
  "+",
  "*",
  "#",
  "$",
  "!",
  "?",
  "@",
  "%",
  "^",
  "~",
];

type EditBarProps = {
  editor: CodeEditor;
  /** True while an on-screen keyboard covers the home indicator, so its inset is not needed. */
  keyboardOpen: boolean;
};

/** The keys code needs and a phone keyboard buries: Tab, undo, redo, and the common symbols. */
export function EditBar({ editor, keyboardOpen }: EditBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Editing keys"
      className={cn(
        "flex shrink-0 gap-1 overflow-x-auto border-t bg-background pt-1 pr-[max(0.25rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))] [scrollbar-width:none]",
        keyboardOpen ? "pb-1" : "pb-[max(0.25rem,env(safe-area-inset-bottom))]",
      )}
    >
      <KeyButton
        className="w-12 shrink-0"
        tone="accent"
        aria-label="Tab"
        onPress={() => editor.tab()}
      >
        <ArrowRightToLineIcon />
      </KeyButton>
      <KeyButton
        className="w-11 shrink-0"
        tone="accent"
        aria-label="Undo"
        repeat
        onPress={() => editor.undo()}
      >
        <Undo2Icon />
      </KeyButton>
      <KeyButton
        className="w-11 shrink-0"
        tone="accent"
        aria-label="Redo"
        repeat
        onPress={() => editor.redo()}
      >
        <Redo2Icon />
      </KeyButton>
      {SYMBOLS.map((symbol) => (
        <KeyButton
          key={symbol}
          className="w-9 shrink-0 text-[0.9375rem]"
          aria-label={`Type ${symbol}`}
          onPress={() => editor.insert(symbol)}
        >
          {symbol}
        </KeyButton>
      ))}
    </div>
  );
}
