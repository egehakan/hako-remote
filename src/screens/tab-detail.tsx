import type { Pane } from "@shared/protocol";
import { FileTextIcon, SquareIcon, SquareTerminalIcon } from "lucide-react";
import { AgentBadge } from "@/components/agent-badge";
import { DetailHeader } from "@/components/detail-header";
import { FolderIcon } from "@/components/folder-icon";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceActions } from "@/components/workspace-actions";
import { useWorkspace } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { routes } from "@/lib/route";
import { findTab } from "@/lib/workspace";

/** One tab on the Mac: where it lives and what runs in it. The live terminal will be drawn here. */
export function TabDetail({ tabId }: { tabId: string }) {
  const { windows } = useWorkspace();
  const { canAct, askToClose } = useWorkspaceActions();
  const found = findTab(windows, tabId);

  if (!found) {
    return windows ? (
      <>
        <DetailHeader title="Tab closed" />
        <Empty className="py-20">
          <EmptyHeader>
            <EmptyTitle>This tab isn’t open any more</EmptyTitle>
            <EmptyDescription>It was closed on your Mac or from another device.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="secondary"
              size="touch"
              nativeButton={false}
              render={<a href={routes.workspace} />}
            >
              Back to the workspace
            </Button>
          </EmptyContent>
        </Empty>
      </>
    ) : (
      <>
        <DetailHeader title="Tab" />
        <div className="flex flex-col gap-3 p-4 md:p-6" aria-busy="true">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </>
    );
  }

  const { tab, folder } = found;
  return (
    <>
      <DetailHeader title={tab.title} />
      <div className="flex flex-col gap-6 px-safe py-5 md:px-6">
        {folder ? (
          <div className="flex items-center gap-2.5">
            <FolderIcon folder={folder} />
            <div className="min-w-0">
              <p className="truncate text-sm leading-5 font-medium">{folder.name}</p>
              <p className="truncate font-mono text-xs leading-5 text-muted-foreground" translate="no">
                {tildify(folder.directory)}
              </p>
            </div>
          </div>
        ) : null}

        <section
          aria-label="Terminal"
          className="rounded-lg border border-dashed bg-well px-4 py-8 font-mono text-[0.8125rem] leading-6"
        >
          <p className="text-foreground">
            <span className="text-amber" aria-hidden="true">
              ${" "}
            </span>
            The live terminal arrives in the next version.
          </p>
          <p className="text-muted-foreground">
            Opening this tab brought it to the front on your Mac. What runs in it is listed below.
          </p>
        </section>

        <ul className="flex flex-col divide-y border-y">
          {tab.panes.map((pane) => (
            <PaneDetails key={pane.id} pane={pane} showFocus={tab.panes.length > 1} />
          ))}
        </ul>

        <Button
          variant="destructive"
          size="touch"
          className="self-start"
          disabled={!canAct}
          onClick={() => askToClose(tab)}
        >
          Close tab
        </Button>
      </div>
    </>
  );
}

const KIND_LABELS: Record<Pane["kind"], string> = {
  terminal: "Terminal",
  file: "File",
  other: "Pane",
};

function PaneDetails({ pane, showFocus }: { pane: Pane; showFocus: boolean }) {
  const Icon =
    pane.kind === "terminal" ? SquareTerminalIcon : pane.kind === "file" ? FileTextIcon : SquareIcon;
  return (
    <li className="flex gap-3 py-3.5">
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="sr-only">{KIND_LABELS[pane.kind]}:</span>
          <span className="min-w-0 font-mono text-sm leading-6 break-words" translate="no">
            {pane.title}
          </span>
          {showFocus && pane.focused ? <span className="text-xs text-muted-foreground">focused</span> : null}
          {pane.agent ? <AgentBadge agent={pane.agent} /> : null}
        </div>
        {pane.cwd ? (
          <p className="font-mono text-xs leading-5 break-all text-muted-foreground" translate="no">
            {tildify(pane.cwd)}
          </p>
        ) : null}
        {pane.agent ? (
          <p className="text-sm leading-5 text-muted-foreground">
            <span className="text-foreground">{pane.agent.name}</span>
            {pane.agent.message ? `: ${pane.agent.message}` : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}
