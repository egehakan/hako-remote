import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodeEditor, FindState } from "@/lib/files/editor";

/** Find in the open file: type, and step through the matches. */
export function FindBar({ editor, onClose }: { editor: CodeEditor; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState<FindState>({ total: 0, current: 0 });

  useEffect(() => {
    editor.openFind();
    input.current?.focus();
    return () => {
      editor.find("");
      editor.closeFind();
    };
  }, [editor]);

  const step = (direction: 1 | -1) => setFound(editor.findStep(text, direction));

  return (
    <div
      role="search"
      className="flex shrink-0 items-center gap-1 border-b bg-card py-1.5 pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))]"
    >
      <input
        ref={input}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        name="find"
        aria-label="Find in this file"
        placeholder="Find in this file…"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setFound(editor.findFirst(event.target.value));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-input/30 px-2.5 font-mono text-base outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 wide:text-sm"
      />
      <span
        role="status"
        className="w-[4.5rem] shrink-0 text-center font-mono text-[0.6875rem] text-muted-foreground tabular-nums"
      >
        {text === ""
          ? ""
          : found.total === 0
            ? "no match"
            : `${found.current || "–"} of ${found.total >= 9999 ? "9999+" : found.total}`}
      </span>
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label="Previous match"
        disabled={found.total === 0}
        onClick={() => step(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label="Next match"
        disabled={found.total === 0}
        onClick={() => step(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button variant="ghost" size="icon-lg" aria-label="Close find" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}
