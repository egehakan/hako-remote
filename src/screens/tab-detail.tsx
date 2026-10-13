import type { Pane } from "@shared/protocol";
import { FileTextIcon, SquareIcon } from "lucide-react";
import { useEffect } from "react";
import { DetailHeader } from "@/components/detail-header";
import { FolderIcon } from "@/components/folder-icon";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceActions } from "@/components/workspace-actions";
import { useWorkspace } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { navigate, routes } from "@/lib/route";
import { findTab, leadTerminal } from "@/lib/workspace";

/**
 * A tab by its id. A tab with a terminal opens that terminal; what is left to show here is a tab
 * without one, such as a file open on the Mac.
 */
export function TabDetail({ tabId }: { tabId: string }) {
  const { windows } = useWorkspace();
  const { canAct, askToClose } = useWorkspaceActions();
  const found = findTab(windows, tabId);
  const terminal = found ? leadTerminal(found.tab) : null;
  const sessionId = terminal?.session_id ?? null;

  useEffect(() => {
    if (sessionId !== null) navigate(routes.terminal(sessionId), { replace: true });
  }, [sessionId]);

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
        <div className="flex flex-col gap-3 p-4 wide:p-6" aria-busy="true">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </>
    );
  }
  if (sessionId !== null) return null;

  const { tab, folder } = found;
  return (
    <>
      <DetailHeader title={tab.title} />
      <div className="flex flex-col gap-6 px-safe py-5 wide:px-6">
        {folder ? (
          <div className="flex items-center gap-2.5">
            <FolderIcon folder={folder} />
            <div className="min-w-0">
              <p className="truncate text-sm leading-5 font-medium">{folder.name}</p>
              <p
                className="truncate font-mono text-xs leading-5 text-muted-foreground"
                translate="no"
              >
                {tildify(folder.directory)}
              </p>
            </div>
          </div>
        ) : null}

        <p className="text-sm leading-6 text-muted-foreground">
          This tab has no terminal. It is in front on your Mac now; what it holds is listed below.
        </p>

        <ul className="flex flex-col divide-y border-y">
          {tab.panes.map((pane) => (
            <PaneDetails key={pane.id} pane={pane} />
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

function PaneDetails({ pane }: { pane: Pane }) {
  const Icon = pane.kind === "file" ? FileTextIcon : SquareIcon;
  return (
    <li className="flex gap-3 py-3.5">
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <span className="sr-only">{KIND_LABELS[pane.kind]}:</span>
      <span className="min-w-0 font-mono text-sm leading-6 break-words" translate="no">
        {pane.title}
      </span>
    </li>
  );
}
