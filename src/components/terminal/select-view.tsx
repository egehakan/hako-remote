import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type SelectViewProps = {
  /** The terminal's history and screen as plain text. */
  text: string;
  onClose: () => void;
};

async function copy(text: string, fallback: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard access (an insecure page, or the browser said no): copy a selection instead.
    if (!fallback) return false;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(fallback);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.execCommand("copy");
  }
}

/**
 * The terminal's text as ordinary selectable text, laid over the terminal. A terminal drawn cell
 * by cell cannot be selected with a finger; plain text can, with the system's own handles and Copy.
 */
export function SelectView({ text, onClose }: SelectViewProps) {
  const body = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Start at the newest output, where the terminal was, with the keyboard's focus on the text.
    const element = body.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    element.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <section
      aria-label="Terminal text"
      className="absolute inset-0 z-20 flex flex-col bg-well"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b bg-background py-1.5 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))]">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Select text</h2>
        <Button
          variant="secondary"
          className="h-10 px-3 text-sm"
          onClick={() => void copy(text, body.current).then(setCopied)}
        >
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy all"}</span>
        </Button>
        <Button className="h-10 px-4 text-sm" onClick={onClose}>
          Done
        </Button>
      </div>
      <pre
        ref={body}
        translate="no"
        className="min-h-0 flex-1 overflow-auto overscroll-contain py-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] font-mono text-xs leading-5 whitespace-pre text-foreground outline-none select-text [-webkit-user-select:text] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        // Lets a hardware keyboard scroll the text and select all of it.
        tabIndex={0}
      >
        {text === "" ? "Nothing on this terminal yet." : text}
      </pre>
    </section>
  );
}
