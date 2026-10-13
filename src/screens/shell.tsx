import type { Tab } from "@shared/protocol";
import { CircleAlertIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { BoxMark } from "@/components/box-mark";
import { CloseTabDialog } from "@/components/close-tab-dialog";
import { MacHeader } from "@/components/mac-header";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { type WorkspaceActions, WorkspaceActionsContext } from "@/components/workspace-actions";
import { WorkspaceList } from "@/components/workspace-list";
import { activateTab, closeTab, createTab } from "@/lib/actions";
import { describeFailure } from "@/lib/errors";
import { useConnection, useWorkspace } from "@/lib/hooks";
import { navigate, routes, useRoute } from "@/lib/route";
import { cn } from "@/lib/utils";
import { AccountScreen } from "@/screens/account";
import { TabDetail } from "@/screens/tab-detail";

const LOOSE = "loose";

type ShellProps = { email: string; onLoggedOut: () => void };

/** The signed-in app: the workspace list, and beside it (or over it, on a phone) one detail view. */
export function Shell({ email, onLoggedOut }: ShellProps) {
  const route = useRoute();
  const { link, agent } = useConnection();
  const { windows, error } = useWorkspace();
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [closing, setClosing] = useState<Tab | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);

  const online = link === "open" && agent?.online === true;
  const offline = link === "open" && agent?.online === false;
  const selectedTabId = route.name === "tab" ? route.tabId : null;

  const openTab = useCallback((tab: Tab) => {
    setNotice(null);
    activateTab(tab.id).catch((failure) => setNotice(describeFailure(failure)));
  }, []);

  const newTab = useCallback(async (folderId?: string) => {
    setNotice(null);
    setCreatingIn(folderId ?? LOOSE);
    try {
      navigate(routes.tab(await createTab(folderId)));
    } catch (failure) {
      setNotice(describeFailure(failure));
    } finally {
      setCreatingIn(null);
    }
  }, []);

  const askToClose = useCallback((tab: Tab) => {
    setClosing(tab);
    setCloseOpen(true);
  }, []);

  const confirmClose = useCallback(
    async (tab: Tab) => {
      setCloseOpen(false);
      setNotice(null);
      try {
        await closeTab(tab.id);
        if (selectedTabId === tab.id) navigate(routes.workspace, { replace: true });
      } catch (failure) {
        setNotice(describeFailure(failure));
      }
    },
    [selectedTabId],
  );

  const actions = useMemo<WorkspaceActions>(
    () => ({ canAct: online, creatingIn, openTab, newTab, askToClose }),
    [online, creatingIn, openTab, newTab, askToClose],
  );

  return (
    <WorkspaceActionsContext value={actions}>
      <div className="mx-auto h-dvh max-w-6xl md:grid md:grid-cols-[minmax(22rem,26rem)_1fr]">
        <div className={cn("flex h-dvh flex-col", route.name !== "workspace" && "max-md:hidden")}>
          <MacHeader />
          <main className="flex-1 overflow-y-auto overscroll-contain px-safe py-4">
            {notice || error ? (
              <Alert variant="destructive" className="mb-4">
                <CircleAlertIcon />
                <AlertDescription>
                  {notice ?? "Couldn’t load the workspace from your Mac."}
                </AlertDescription>
                {notice ? (
                  <AlertAction>
                    <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
                      Dismiss
                    </Button>
                  </AlertAction>
                ) : null}
              </Alert>
            ) : null}
            {offline ? (
              <MacOffline />
            ) : windows ? (
              <div
                className={cn("transition-opacity", !online && "opacity-45")}
                inert={!online}
                aria-busy={!online}
              >
                <WorkspaceList windows={windows} selectedTabId={selectedTabId} />
              </div>
            ) : (
              <WorkspaceSkeleton />
            )}
          </main>
          <footer className="shrink-0 border-t bg-background px-safe pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button
              size="touch"
              className="w-full"
              disabled={!online || creatingIn !== null}
              onClick={() => void newTab()}
            >
              {creatingIn === LOOSE ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              New tab
            </Button>
          </footer>
        </div>

        <div
          className={cn(
            "h-dvh overflow-y-auto overscroll-contain md:border-l",
            route.name === "workspace" && "max-md:hidden",
          )}
        >
          {route.name === "tab" ? (
            <TabDetail tabId={route.tabId} />
          ) : route.name === "account" ? (
            <AccountScreen email={email} onLoggedOut={onLoggedOut} />
          ) : (
            <NothingSelected />
          )}
        </div>
      </div>
      <CloseTabDialog
        tab={closing}
        open={closeOpen}
        onCancel={() => setCloseOpen(false)}
        onConfirm={(tab) => void confirmClose(tab)}
      />
    </WorkspaceActionsContext>
  );
}

function MacOffline() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia>
          <BoxMark state="dark" className="h-16" />
        </EmptyMedia>
        <EmptyTitle>Hako isn’t connected</EmptyTitle>
        <EmptyDescription>
          Your Mac is asleep, off the network, or Hako is closed. Open Hako on the Mac and this page
          picks it up by itself.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the workspace">
      <Skeleton className="h-36 rounded-lg" />
      <Skeleton className="h-24 rounded-lg" />
      <Skeleton className="h-14 rounded-lg" />
    </div>
  );
}

function NothingSelected() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>Pick a tab</EmptyTitle>
        <EmptyDescription>
          Choosing a tab brings it to the front on your Mac and shows its terminals here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
