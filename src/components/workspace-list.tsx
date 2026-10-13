import type { Folder, Tab, Window } from "@shared/protocol";
import { PlusIcon, XIcon } from "lucide-react";
import { AgentBadge } from "@/components/agent-badge";
import { FolderIcon } from "@/components/folder-icon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspaceActions } from "@/components/workspace-actions";
import { relativeTo, tildify } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { tabAgent } from "@/lib/workspace";

type WorkspaceListProps = {
  windows: Window[];
  /** The tab open in the detail view, if any. */
  selectedTabId: string | null;
};

export function WorkspaceList({ windows, selectedTabId }: WorkspaceListProps) {
  const several = windows.length > 1;
  return (
    <div className="flex flex-col gap-8">
      {windows.map((window, index) => (
        <section key={window.id} className="flex flex-col gap-3" aria-label={`Window ${index + 1}`}>
          {several ? (
            <h2 className="flex items-baseline gap-2 px-1 text-sm font-semibold">
              Window {index + 1}
              {window.active ? (
                <span className="font-normal text-muted-foreground">in front</span>
              ) : null}
            </h2>
          ) : null}
          <WindowContents window={window} selectedTabId={selectedTabId} />
        </section>
      ))}
    </div>
  );
}

function WindowContents({ window, selectedTabId }: { window: Window; selectedTabId: string | null }) {
  const loose = window.tabs.filter(
    (tab) => tab.folder_id === null || !window.folders.some((folder) => folder.id === tab.folder_id),
  );
  if (window.folders.length === 0 && loose.length === 0) {
    return <p className="px-1 text-sm text-muted-foreground">No tabs open in this window.</p>;
  }
  return (
    <>
      {window.folders.map((folder) => (
        <FolderBox
          key={folder.id}
          folder={folder}
          tabs={window.tabs.filter((tab) => tab.folder_id === folder.id)}
          windowActive={window.active}
          selectedTabId={selectedTabId}
        />
      ))}
      {loose.length > 0 ? (
        <div>
          {window.folders.length > 0 ? (
            <h3 className="px-1 pb-1 text-[0.8125rem] text-muted-foreground">Outside folders</h3>
          ) : null}
          <ul className="divide-y border-y">
            {loose.map((tab) => (
              <TabRow
                key={tab.id}
                tab={tab}
                directory={null}
                front={window.active && tab.active}
                selected={tab.id === selectedTabId}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

type FolderBoxProps = {
  folder: Folder;
  tabs: Tab[];
  windowActive: boolean;
  selectedTabId: string | null;
};

/** A folder drawn as a box: a lid in the folder's colour, and its tabs inside. */
function FolderBox({ folder, tabs, windowActive, selectedTabId }: FolderBoxProps) {
  const { canAct, creatingIn, newTab } = useWorkspaceActions();
  const creating = creatingIn === folder.id;
  return (
    <section
      aria-label={`Folder ${folder.name}`}
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div
        aria-hidden="true"
        className="h-[3px] bg-input"
        style={folder.color ? { backgroundColor: folder.color } : undefined}
      />
      <header className="flex items-center gap-3 py-1.5 pr-1.5 pl-3">
        <FolderIcon folder={folder} />
        <div className="min-w-0 flex-1 py-1">
          <h3 className="truncate text-[0.9375rem] leading-5 font-semibold">{folder.name}</h3>
          <p className="truncate font-mono text-xs leading-5 text-muted-foreground" translate="no">
            {tildify(folder.directory)}
          </p>
        </div>
        <Button
          variant="secondary"
          size="icon-touch"
          aria-label={`New terminal in ${folder.name}`}
          disabled={!canAct || creating}
          onClick={() => newTab(folder.id)}
        >
          {creating ? <Spinner /> : <PlusIcon />}
        </Button>
      </header>
      {tabs.length > 0 ? (
        <ul className="divide-y border-t">
          {tabs.map((tab) => (
            <TabRow
              key={tab.id}
              tab={tab}
              directory={folder.directory}
              front={windowActive && tab.active}
              selected={tab.id === selectedTabId}
            />
          ))}
        </ul>
      ) : (
        <p className="border-t px-3 py-3 text-sm text-muted-foreground">
          Nothing open here. The plus opens a terminal in this folder.
        </p>
      )}
    </section>
  );
}

type TabRowProps = {
  tab: Tab;
  /** The directory of the folder the tab sits in, which working directories are shown relative to. */
  directory: string | null;
  /** True for the tab that is in front on the Mac right now. */
  front: boolean;
  selected: boolean;
};

function TabRow({ tab, directory, front, selected }: TabRowProps) {
  const { canAct, openTab, askToClose } = useWorkspaceActions();
  const agent = tabAgent(tab);
  const terminals = tab.panes.filter((pane) => pane.kind === "terminal");
  const lead = terminals.find((pane) => pane.focused) ?? terminals[0];
  const cwd = lead?.cwd ? (directory ? relativeTo(directory, lead.cwd) : tildify(lead.cwd)) : null;
  const others = tab.panes.length - 1;

  return (
    <li className={cn("relative flex items-stretch", selected && "bg-accent")}>
      {tab.active ? (
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-0 left-0 w-[3px]", front ? "bg-amber" : "bg-input")}
        />
      ) : null}
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        className="flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-0.5 py-2.5 pr-1 pl-4 text-left outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        onClick={() => openTab(tab)}
      >
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-[0.9375rem] leading-5 font-medium", front && "text-lid")}>
            {tab.title}
          </span>
          {front ? <span className="sr-only">(in front on your Mac)</span> : null}
          {agent ? <AgentBadge agent={agent} /> : null}
        </span>
        {cwd || others > 0 ? (
          <span className="truncate font-mono text-xs leading-5 text-muted-foreground" translate="no">
            {cwd}
            {others > 0 ? (
              <span>
                {cwd ? "  " : ""}+{others} {others === 1 ? "pane" : "panes"}
              </span>
            ) : null}
          </span>
        ) : null}
        {agent?.message ? (
          <span className="truncate text-[0.8125rem] leading-5 text-muted-foreground">
            {agent.message}
          </span>
        ) : null}
      </button>
      <Button
        variant="ghost"
        size="icon-touch"
        className="my-1 mr-1 self-center text-muted-foreground"
        aria-label={`Close tab ${tab.title}`}
        disabled={!canAct}
        onClick={() => askToClose(tab)}
      >
        <XIcon />
      </Button>
    </li>
  );
}
