import type { Tab } from "@shared/protocol";
import { CircleAlertIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CloseTabDialog } from "@/components/close-tab-dialog";
import { FolderPicker } from "@/components/folder-picker";
import { LoadBoundary } from "@/components/load-boundary";
import { MacHeader } from "@/components/mac-header";
import { MacOffline } from "@/components/mac-offline";
import { NotifyBanners } from "@/components/notify-banners";
import { PrimaryNav } from "@/components/primary-nav";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { type WorkspaceActions, WorkspaceActionsContext } from "@/components/workspace-actions";
import { WorkspaceList } from "@/components/workspace-list";
import { activateTab, closeTab, createTab } from "@/lib/actions";
import { describeFailure, NEEDS_NEWER_HAKO } from "@/lib/errors";
import { useFolderSupport } from "@/lib/folder-support";
import { useConnection, useWorkspace } from "@/lib/hooks";
import { arrivals, notifications } from "@/lib/notifications";
import { type Area, areaOf, navigate, routes, useRoute } from "@/lib/route";
import { cn } from "@/lib/utils";
import { findTab, listTerminals } from "@/lib/workspace";
import { AccountScreen } from "@/screens/account";
import { FilesArea } from "@/screens/files";
import { SourceControlArea } from "@/screens/source-control";
import { TabDetail } from "@/screens/tab-detail";

// The terminal brings xterm.js with it, which the login and the workspace list do not need.
const TerminalScreen = lazy(() => import("@/screens/terminal"));
const PreviewsArea = lazy(() => import("@/screens/previews"));

const LOOSE = "loose";
/** How long a folder that has just been added stays pointed out in the list. */
const ARRIVAL_SHOWN_MS = 2600;

type ShellProps = { email: string; onLoggedOut: () => void };

/**
 * The signed-in app: its areas, and in each a list with one detail view beside it (or over it, on a
 * phone).
 */
export function Shell({ email, onLoggedOut }: ShellProps) {
  const route = useRoute();
  const { link, agent } = useConnection();
  const { windows, error, loadedAt } = useWorkspace();
  const arrival = useSyncExternalStore(arrivals.subscribe, arrivals.getSnapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [closing, setClosing] = useState<Tab | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [arrivedFolderId, setArrivedFolderId] = useState<string | null>(null);
  const folderSupport = useFolderSupport();
  const folderNoteId = useId();

  const online = link === "open" && agent?.online === true;
  const offline = link === "open" && agent?.online === false;
  const area = areaOf(route);
  const openSessionId = route.name === "terminal" ? route.sessionId : null;
  // Read during render on purpose: the links of the navigation are built from it.
  const resume = useRef<Partial<Record<Area, string>>>({});
  resume.current[area] = window.location.hash;
  const selectedTabId = useMemo(() => {
    if (route.name === "tab") return route.tabId;
    if (openSessionId === null) return null;
    const open = listTerminals(windows).find((terminal) => terminal.sessionId === openSessionId);
    return open?.tab.id ?? null;
  }, [route, openSessionId, windows]);

  const openTab = useCallback((tab: Tab) => {
    setNotice(null);
    activateTab(tab.id).catch((failure) => setNotice(describeFailure(failure)));
  }, []);

  const newTab = useCallback(async (folderId?: string) => {
    setNotice(null);
    setCreatingIn(folderId ?? LOOSE);
    try {
      // Straight into the new terminal: that is what it was opened for.
      navigate(routes.terminal((await createTab(folderId)).session_id));
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

  const dismissNotice = useCallback(() => setNotice(null), []);

  const folderAdded = useCallback((folderId: string) => {
    setPickerOpen(false);
    setArrivedFolderId(folderId);
  }, []);

  const arrivedFolder = useMemo(() => {
    if (arrivedFolderId === null) return null;
    for (const window of windows ?? []) {
      const folder = window.folders.find((candidate) => candidate.id === arrivedFolderId);
      if (folder) return folder;
    }
    return null;
  }, [arrivedFolderId, windows]);
  const arrivedShown = arrivedFolder !== null;
  // Counted from the moment the folder is in the list, which is when there is something to see.
  useEffect(() => {
    if (!arrivedShown) return;
    const timer = setTimeout(() => setArrivedFolderId(null), ARRIVAL_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [arrivedShown]);

  // A tapped notification opens its terminal. Once the Mac has listed its workspace again, a
  // terminal that is no longer there gives way to what its tab still holds, or to the workspace.
  useEffect(() => {
    if (arrival === null || !online || windows === null || loadedAt < arrival.at) return;
    arrivals.clear();
    if (openSessionId !== arrival.sessionId) return;
    if (listTerminals(windows).some((terminal) => terminal.sessionId === arrival.sessionId)) return;
    const tab = arrival.tabId === null ? null : findTab(windows, arrival.tabId);
    if (tab) {
      navigate(routes.tab(tab.tab.id), { replace: true });
    } else {
      navigate(routes.workspace, { replace: true });
      setNotice("The terminal that notification was about isn’t open any more.");
    }
  }, [arrival, online, windows, loadedAt, openSessionId]);

  // Looking at a terminal answers its notification, so the one on the device can go.
  useEffect(() => {
    if (openSessionId !== null) void notifications.clearFor(openSessionId);
  }, [openSessionId]);

  const actions = useMemo<WorkspaceActions>(
    () => ({
      canAct: online,
      creatingIn,
      openTab,
      newTab,
      askToClose,
      arrivedFolderId,
      notice,
      dismissNotice,
    }),
    [online, creatingIn, openTab, newTab, askToClose, arrivedFolderId, notice, dismissNotice],
  );

  return (
    <WorkspaceActionsContext value={actions}>
      <div className="h-full narrow:flex narrow:flex-col wide:grid wide:grid-cols-[auto_minmax(18rem,24rem)_minmax(0,1fr)] wide:grid-rows-[minmax(0,1fr)]">
        <PrimaryNav
          area={area}
          resume={resume.current}
          hiddenOnPhone={
            route.name === "terminal" ||
            route.name === "preview" ||
            route.name === "browse" ||
            route.name === "file" ||
            route.name === "diff" ||
            route.name === "commitFile"
          }
        />
        {area === "terminals" ? (
          <>
            <div
              className={cn(
                "flex min-h-0 flex-col narrow:flex-1",
                route.name !== "workspace" && "narrow:hidden",
              )}
            >
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
                        <Button variant="ghost" size="sm" onClick={dismissNotice}>
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
              <footer className="flex shrink-0 flex-col gap-2 border-t bg-background px-safe py-3 wide:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                <div className="flex gap-2">
                  <Button
                    size="touch"
                    className="min-w-0 flex-1"
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
                  <Button
                    variant="secondary"
                    size="touch"
                    disabled={!online || folderSupport === "no"}
                    aria-describedby={online && folderSupport === "no" ? folderNoteId : undefined}
                    onClick={() => setPickerOpen(true)}
                  >
                    <FolderPlusIcon data-icon="inline-start" />
                    New folder
                  </Button>
                </div>
                {online && folderSupport === "no" ? (
                  <p id={folderNoteId} className="text-[0.75rem] leading-4 text-muted-foreground">
                    New folder needs a newer Hako. {NEEDS_NEWER_HAKO}
                  </p>
                ) : null}
              </footer>
            </div>

            <div
              className={cn(
                "wide:border-l",
                // On a phone the terminal follows the visible part of the page, above the keyboard.
                openSessionId === null
                  ? "min-h-0 overflow-y-auto overscroll-contain narrow:flex-1"
                  : "visible-pane h-(--vv-height) overflow-hidden",
                route.name === "workspace" && "narrow:hidden",
              )}
            >
              {route.name === "terminal" ? (
                <LoadBoundary>
                  <Suspense fallback={<TerminalLoading />}>
                    <TerminalScreen key={route.sessionId} sessionId={route.sessionId} />
                  </Suspense>
                </LoadBoundary>
              ) : route.name === "tab" ? (
                <TabDetail tabId={route.tabId} />
              ) : (
                <NothingSelected />
              )}
            </div>
          </>
        ) : route.name === "files" || route.name === "dir" || route.name === "file" ? (
          <FilesArea route={route} />
        ) : route.name === "git" ||
          route.name === "repo" ||
          route.name === "diff" ||
          route.name === "commit" ||
          route.name === "commitFile" ? (
          <SourceControlArea route={route} />
        ) : route.name === "previews" || route.name === "preview" || route.name === "browse" ? (
          <LoadBoundary>
            <Suspense fallback={<TerminalLoading />}>
              <PreviewsArea route={route} />
            </Suspense>
          </LoadBoundary>
        ) : (
          <div className="min-h-0 overflow-y-auto overscroll-contain narrow:flex-1 wide:col-span-2 wide:border-l">
            <AccountScreen email={email} onLoggedOut={onLoggedOut} />
          </div>
        )}
      </div>
      <NotifyBanners />
      <FolderPicker open={pickerOpen} onOpenChange={setPickerOpen} onAdded={folderAdded} />
      <p role="status" className="sr-only">
        {arrivedFolder ? `Folder ${arrivedFolder.name} is in the list.` : ""}
      </p>
      <CloseTabDialog
        tab={closing}
        open={closeOpen}
        onCancel={() => setCloseOpen(false)}
        onConfirm={(tab) => void confirmClose(tab)}
      />
    </WorkspaceActionsContext>
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

function TerminalLoading() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true" aria-label="Loading…">
      <Spinner />
    </div>
  );
}

function NothingSelected() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>Pick a tab</EmptyTitle>
        <EmptyDescription>
          Choosing a tab brings it to the front on your Mac and opens its terminal here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
