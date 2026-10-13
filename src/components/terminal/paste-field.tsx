import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

type PasteFieldProps = {
  onPaste: (text: string) => void;
  onClose: () => void;
};

/**
 * The way to paste when the browser will not hand over the clipboard: a field to paste into with
 * the system's own Paste, whose text goes straight to the terminal.
 */
export function PasteField({ onPaste, onClose }: PasteFieldProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);

  const submit = () => {
    const text = field.current?.value ?? "";
    if (text !== "") onPaste(text);
    onClose();
  };

  return (
    <div className="flex items-end gap-1.5 px-1 pt-1.5">
      <textarea
        ref={field}
        aria-label="Paste here"
        name="paste"
        autoComplete="off"
        placeholder="Paste here…"
        rows={1}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-10 min-w-0 flex-1 resize-none rounded-md border border-input bg-well px-2.5 py-2 font-mono text-[16px] leading-6 outline-none placeholder:text-faint focus-visible:border-ring"
        onPaste={(event) => {
          event.preventDefault();
          onPaste(event.clipboardData.getData("text/plain"));
          onClose();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      />
      <Button variant="secondary" className="h-10 px-3 text-sm" onClick={submit}>
        Paste
      </Button>
      <Button variant="ghost" className="size-10" aria-label="Cancel pasting" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}
