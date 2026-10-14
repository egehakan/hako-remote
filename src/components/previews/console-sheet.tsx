import type { PreviewConsoleLevel } from "@shared/previews";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type ConsoleEntry = {
  id: number;
  level: PreviewConsoleLevel;
  message: string;
  source: string | null;
  line: number | null;
  at: number;
};

function where(entry: ConsoleEntry): string | null {
  if (!entry.source) return null;
  let name = entry.source;
  try {
    const url = new URL(entry.source);
    name = `${url.pathname}${url.search}`;
  } catch {
    // Not an address: shown as it came.
  }
  return entry.line ? `${name}:${entry.line}` : name;
}

type ConsoleSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: ConsoleEntry[];
  /** False while no page has spoken: the page may block the script that listens. */
  scriptPresent: boolean;
  onClear: () => void;
};

/** What the page logged as an error or a warning, and what it threw, newest last. */
export function ConsoleSheet({
  open,
  onOpenChange,
  entries,
  scriptPresent,
  onClear,
}: ConsoleSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[80dvh] max-w-2xl gap-0 rounded-t-2xl border-x pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>Console</SheetTitle>
          <SheetDescription>
            {scriptPresent
              ? "Errors and warnings the page logged, and errors it did not catch. At most 50 each time the page loads."
              : "Nothing has been heard from this page. A page whose own security policy forbids added scripts cannot report here."}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto border-y">
          {entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No errors or warnings.
            </p>
          ) : (
            <ol className="divide-y">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className={cn(
                    "border-l-2 px-4 py-2.5",
                    entry.level === "error" ? "border-destructive" : "border-amber",
                  )}
                >
                  <p className="flex items-baseline gap-2 text-[0.75rem]">
                    <span
                      className={cn(
                        "font-medium",
                        entry.level === "error" ? "text-destructive" : "text-amber",
                      )}
                    >
                      {entry.level === "error" ? "Error" : "Warning"}
                    </span>
                    <span className="text-faint">{new Date(entry.at).toLocaleTimeString()}</span>
                  </p>
                  <pre className="mt-1 font-mono text-[0.8125rem] leading-5 break-words whitespace-pre-wrap">
                    {entry.message}
                  </pre>
                  {where(entry) ? (
                    <p className="mt-1 truncate font-mono text-[0.75rem] text-muted-foreground">
                      {where(entry)}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="flex justify-end px-4 pt-3">
          <Button variant="secondary" disabled={entries.length === 0} onClick={onClear}>
            Clear
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
