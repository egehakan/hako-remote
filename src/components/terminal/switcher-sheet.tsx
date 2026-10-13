import { AgentBadge } from "@/components/agent-badge";
import { FolderIcon } from "@/components/folder-icon";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { tildify } from "@/lib/paths";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";
import type { TerminalLocation } from "@/lib/workspace";

type SwitcherSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  terminals: TerminalLocation[];
  currentSessionId: string;
  onChoose: (terminal: TerminalLocation) => void;
  /** Closes the tab the current terminal is in, after the usual confirmation. */
  onCloseTab: (() => void) | null;
};

/** Every terminal on the Mac in one short list, to move between them without the workspace list. */
export function SwitcherSheet({
  open,
  onOpenChange,
  terminals,
  currentSessionId,
  onChoose,
  onCloseTab,
}: SwitcherSheetProps) {
  const windows = [...new Set(terminals.map((terminal) => terminal.window))];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[min(34rem,85dvh)] max-w-lg gap-0 rounded-t-2xl border-x"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>Terminals</SheetTitle>
          <SheetDescription>
            Everything open on your Mac. Swiping the title bar steps through them.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {windows.map((window, index) => (
            <section key={window.id} aria-label={`Window ${index + 1}`}>
              {windows.length > 1 ? (
                <h3 className="px-4 pt-3 pb-1 text-[0.8125rem] text-muted-foreground">
                  Window {index + 1}
                </h3>
              ) : null}
              <ul className="divide-y">
                {terminals
                  .filter((terminal) => terminal.window === window)
                  .map((terminal) => {
                    const current = terminal.sessionId === currentSessionId;
                    const severalPanes =
                      terminal.tab.panes.filter((pane) => pane.kind === "terminal").length > 1;
                    return (
                      <li key={terminal.sessionId} className="relative">
                        {current ? (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 left-0 w-[3px] bg-amber"
                          />
                        ) : null}
                        <a
                          href={routes.terminal(terminal.sessionId)}
                          aria-current={current ? "page" : undefined}
                          className={cn(
                            "flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent",
                            current && "bg-accent",
                          )}
                          onClick={(event) => {
                            // A plain tap switches in place; a modified click opens a new tab.
                            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                            event.preventDefault();
                            onChoose(terminal);
                          }}
                        >
                          {terminal.folder ? (
                            <FolderIcon folder={terminal.folder} />
                          ) : (
                            <span aria-hidden="true" className="size-6 shrink-0" />
                          )}
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-[0.9375rem] leading-5 font-medium">
                                {terminal.tab.title}
                              </span>
                              {terminal.pane.agent ? (
                                <AgentBadge agent={terminal.pane.agent} />
                              ) : null}
                            </span>
                            <span
                              className="truncate font-mono text-xs leading-5 text-muted-foreground"
                              translate="no"
                            >
                              {severalPanes ? `${terminal.pane.title}  ` : ""}
                              {terminal.pane.cwd ? tildify(terminal.pane.cwd) : ""}
                            </span>
                          </span>
                        </a>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
          {onCloseTab ? (
            <div className="border-t p-4">
              <Button variant="destructive" size="touch" className="w-full" onClick={onCloseTab}>
                Close this tab
              </Button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
