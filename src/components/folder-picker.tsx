import { isDirectory } from "@shared/files";
import type { Folder, FsEntry, FsRoot } from "@shared/protocol";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  FolderCheckIcon,
  FolderPlusIcon,
  HouseIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
} from "lucide-react";
import {
  type ComponentType,
  type FormEvent,
  memo,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StaleNotice } from "@/components/files/browser";
import { FileKindIcon } from "@/components/files/file-icon";
import { FsProblem, ListSkeleton } from "@/components/files/states";
import { VirtualList } from "@/components/files/virtual-list";
import { FolderIcon } from "@/components/folder-icon";
import { MacOffline } from "@/components/mac-offline";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { createFolder } from "@/lib/actions";
import { relay } from "@/lib/connection";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { checkDirectoryName } from "@/lib/files/new-directory";
import { inDisplayOrder } from "@/lib/files/order";
import { baseName, crumbsFor, isWithin, joinPath, parentOf } from "@/lib/files/paths";
import { type FsError, refreshListing, toFsError, useListing, useRoots } from "@/lib/files/store";
import { folderCreateUnsupported, useFolderSupport } from "@/lib/folder-support";
import { useConnection, useWide, useWorkspace } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { useVisibleViewport } from "@/lib/terminal/viewport";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 48;

// A placeholder is drawn in the muted colour, which on a sheet is the colour of the sheet itself.
const SURFACE = "flex flex-col gap-0 overflow-y-auto [--muted:var(--input)]";

type FolderPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the folder's id once the workspace lists it. */
  onAdded: (folderId: string) => void;
};

/** Where a folder is added from here: a sheet on a phone, a dialog where there is room for one. */
export function FolderPicker({ open, onOpenChange, onAdded }: FolderPickerProps) {
  const wide = useWide();
  if (wide) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn(SURFACE, "h-[min(42rem,calc(100dvh-4rem))] p-0 sm:max-w-xl")}>
          <Picker Title={DialogTitle} Description={DialogDescription} onAdded={onAdded} />
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn(
          SURFACE,
          "mx-auto max-w-lg overscroll-contain rounded-t-2xl border-x outline-none data-[side=bottom]:h-[min(46rem,calc(var(--vv-height)-2.5rem))]",
          // The sheet hangs from the bottom of the visible part of the page, not of the page, so
          // that the name of a new directory is typed above the keyboard.
          "top-[calc(var(--vv-pinned-top)+var(--vv-height))] [transform:translateY(-100%)] data-[side=bottom]:bottom-auto",
        )}
      >
        <Picker Title={SheetTitle} Description={SheetDescription} onAdded={onAdded} />
      </SheetContent>
    </Sheet>
  );
}

type Explained = { title: string; quote: string | null };

/** Why the Mac did not do it, with the Mac's own words wherever it gave any. */
function explain(error: FsError, doing: "add" | "make"): Explained {
  const quote = error.message || null;
  switch (error.code) {
    case "not_supported":
      return {
        title: `${NEEDS_NEWER_HAKO} The version running there can’t ${
          doing === "add" ? "add folders" : "make directories"
        } from here yet.`,
        quote: null,
      };
    case "agent_offline":
    case "disconnected":
      return { title: "Your Mac went offline before this finished.", quote: null };
    case "timeout":
      return { title: "Your Mac didn’t answer. Try again.", quote: null };
    case "permission_denied":
      return {
        title:
          doing === "add"
            ? "Your Mac won’t let Hako read this directory"
            : "Your Mac won’t let Hako make a directory here",
        quote,
      };
    case "not_found":
      return { title: "This directory isn’t there any more on your Mac", quote };
    case "not_a_directory":
      return { title: "That isn’t a directory on your Mac", quote };
    case "conflict":
      return { title: "Something of that name is already there", quote };
    case "bad_request":
    case "failed":
    case "is_a_directory":
    case "too_large":
    case "git_failed":
    case "busy":
      return {
        title:
          doing === "add"
            ? "Your Mac couldn’t add the folder"
            : "Your Mac couldn’t make the directory",
        quote,
      };
  }
}

function Failure({ error, doing }: { error: FsError; doing: "add" | "make" }) {
  const { title, quote } = explain(error, doing);
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      {quote ? (
        <AlertDescription className="font-mono text-xs leading-5 [overflow-wrap:anywhere]">
          {quote}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

type PickerProps = {
  Title: ComponentType<{ children: ReactNode }>;
  Description: ComponentType<{ children: ReactNode }>;
  onAdded: (folderId: string) => void;
};

type Row = { entry: FsEntry; path: string };

function Picker({ Title, Description, onAdded }: PickerProps) {
  useVisibleViewport();
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const offline = link === "open" && agent?.online === false;
  const support = useFolderSupport();
  const roots = useRoots();
  const { windows } = useWorkspace();
  const home = roots.data?.home ?? null;
  // Null until a directory has been chosen, which is while the home directory is on show.
  const [chosen, setChosen] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [naming, setNaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<FsError | null>(null);
  const path = chosen ?? home;
  const listing = useListing(path);
  const entries = listing.data?.entries ?? null;

  const { folders, inFront } = useMemo(() => {
    const folders = new Map<string, Folder>();
    const inFront = new Set<string>();
    for (const window of windows ?? []) {
      for (const folder of window.folders) {
        if (!folders.has(folder.directory)) folders.set(folder.directory, folder);
        if (window.active) inFront.add(folder.directory);
      }
    }
    return { folders, inFront };
  }, [windows]);

  const { rows, hiddenCount } = useMemo(() => {
    const rows: Row[] = [];
    let hiddenCount = 0;
    if (entries === null || path === null) return { rows, hiddenCount };
    for (const entry of inDisplayOrder(entries.filter(isDirectory))) {
      if (entry.name.startsWith(".")) {
        hiddenCount++;
        if (!showHidden) continue;
      }
      rows.push({ entry, path: joinPath(path, entry.name) });
    }
    return { rows, hiddenCount };
  }, [entries, path, showHidden]);

  const go = useCallback((next: string) => {
    setChosen(next);
    setNaming(false);
    setFailure(null);
  }, []);

  const nameOf = (directory: string) => (directory === home ? "Home" : baseName(directory));
  const several = (windows?.length ?? 0) > 1;
  // The Mac adds nothing for a directory that is already a folder of the window in front.
  const already = path !== null && inFront.has(path);
  const unsupported = support === "no" || failure?.code === "not_supported";

  const add = async () => {
    if (path === null || adding) return;
    setAdding(true);
    setFailure(null);
    try {
      onAdded(await createFolder(path));
    } catch (error) {
      const failed = toFsError(error);
      if (failed.code === "not_supported") folderCreateUnsupported();
      setFailure(failed);
      setAdding(false);
    }
  };

  return (
    <>
      <header className="flex shrink-0 flex-col gap-1 px-4 pt-4 pr-12 pb-3">
        <Title>New folder</Title>
        <Description>
          Pick the directory on your Mac it points at.
          {several ? " It joins the window in front there." : ""}
        </Description>
      </header>

      {path === null ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t">
          {offline ? (
            <MacOffline />
          ) : roots.error ? (
            <FsProblem error={roots.error} what="directory">
              {roots.error.code === "not_supported" ? null : (
                <Button variant="secondary" size="touch" onClick={roots.reload}>
                  Try again
                </Button>
              )}
            </FsProblem>
          ) : (
            <ListSkeleton label="Loading the directories of your Mac" />
          )}
        </div>
      ) : (
        <>
          {naming ? null : (
            <Shortcuts roots={roots.data?.roots ?? []} folders={folders} current={path} onGo={go} />
          )}

          <DirectoryBar
            path={path}
            home={home}
            title={nameOf(path)}
            upLabel={(parent) => `Up to ${nameOf(parent)}`}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((shown) => !shown)}
            loading={listing.loading}
            canRefresh={online}
            onRefresh={listing.reload}
            onGo={go}
          />

          {entries === null || offline ? null : naming ? (
            <NewDirectoryForm
              parent={path}
              entries={entries}
              onCancel={() => setNaming(false)}
              onMade={go}
            />
          ) : (
            <button
              type="button"
              disabled={!online}
              onClick={() => setNaming(true)}
              className="flex h-12 w-full shrink-0 items-center gap-3 border-b px-4 text-left text-lid outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:opacity-50"
            >
              <span className="flex size-6 shrink-0 items-center justify-center">
                <FolderPlusIcon aria-hidden="true" className="size-5" />
              </span>
              <span className="text-[0.9375rem] font-medium">New directory</span>
            </button>
          )}

          {offline ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <MacOffline />
            </div>
          ) : entries !== null && listing.error?.code !== "not_supported" ? (
            <>
              {listing.error ? <StaleNotice /> : null}
              {rows.length > 0 ? (
                <VirtualList
                  items={rows}
                  rowHeight={ROW_HEIGHT}
                  itemKey={(row) => row.entry.name}
                  renderRow={(row) => (
                    <DirectoryRow
                      entry={row.entry}
                      path={row.path}
                      folder={folders.get(row.path) ?? null}
                      onOpen={go}
                    />
                  )}
                  scrollKey={`pick:${path}`}
                  resetKey={String(showHidden)}
                  label={`Directories in ${nameOf(path)}`}
                />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
                  {hiddenCount > 0 && !showHidden ? (
                    <>
                      <p>Only hidden directories in here.</p>
                      <Button
                        variant="secondary"
                        size="touch"
                        className="mt-4"
                        onClick={() => setShowHidden(true)}
                      >
                        Show hidden directories
                      </Button>
                    </>
                  ) : (
                    <p>No directories in here. It can still be the folder.</p>
                  )}
                </div>
              )}
            </>
          ) : listing.error ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <FsProblem error={listing.error} what="directory">
                {listing.error.code === "not_supported" ? null : (
                  <Button variant="secondary" size="touch" onClick={listing.reload}>
                    Try again
                  </Button>
                )}
                {home !== null && path !== home ? (
                  <Button variant="ghost" size="touch" onClick={() => go(home)}>
                    Go to Home
                  </Button>
                ) : null}
              </FsProblem>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              <ListSkeleton label="Loading this directory" />
            </div>
          )}

          {naming ? null : (
            <footer className="flex shrink-0 flex-col gap-2.5 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {failure ? <Failure error={failure} doing="add" /> : null}
              {already ? (
                <p className="text-[0.8125rem] leading-5 text-muted-foreground">
                  Already a folder in Hako, so nothing is added.
                </p>
              ) : null}
              <Button
                size="touch"
                className="h-14 w-full flex-col gap-0"
                disabled={!online || entries === null || adding || unsupported}
                onClick={() => void add()}
              >
                <span className="flex items-center gap-2">
                  {adding ? <Spinner /> : already ? <FolderCheckIcon /> : <FolderPlusIcon />}
                  {already ? "Show this folder" : "Use this folder"}
                </span>
                {/* Cut at its start when it is long: the end is what tells directories apart. */}
                <span
                  className="max-w-full truncate font-mono text-xs leading-4 font-normal opacity-80 [direction:rtl]"
                  translate="no"
                >
                  <span dir="ltr">{tildify(path)}</span>
                </span>
              </Button>
            </footer>
          )}
        </>
      )}
    </>
  );
}

type ShortcutsProps = {
  roots: readonly FsRoot[];
  folders: ReadonlyMap<string, Folder>;
  current: string;
  onGo: (path: string) => void;
};

const SHORTCUT_ORDER: readonly FsRoot["source"][] = ["home", "folder", "terminal"];

/** The places Files starts from, as ways to get near where the new folder is. */
function Shortcuts({ roots, folders, current, onGo }: ShortcutsProps) {
  const ordered = SHORTCUT_ORDER.flatMap((source) =>
    roots.filter((root) => root.source === source),
  );
  if (ordered.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Jump to"
      className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none]"
    >
      {ordered.map((root) => {
        const folder = folders.get(root.path);
        return (
          <Button
            key={root.path}
            variant="secondary"
            className="h-10 shrink-0 gap-2 rounded-full px-3.5 aria-[current=true]:text-lid"
            aria-current={root.path === current ? "true" : undefined}
            onClick={() => onGo(root.path)}
          >
            {folder ? (
              <FolderIcon folder={folder} />
            ) : root.source === "home" ? (
              <HouseIcon aria-hidden="true" className="size-5" />
            ) : (
              <SquareTerminalIcon aria-hidden="true" className="size-5" />
            )}
            <span className="max-w-40 truncate">{root.name}</span>
          </Button>
        );
      })}
    </div>
  );
}

type DirectoryBarProps = {
  path: string;
  home: string | null;
  title: string;
  upLabel: (parent: string) => string;
  showHidden: boolean;
  onToggleHidden: () => void;
  loading: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  onGo: (path: string) => void;
};

/** Where the picker is: the directory's name, the way up, and the path to tap back along. */
function DirectoryBar({
  path,
  home,
  title,
  upLabel,
  showHidden,
  onToggleHidden,
  loading,
  canRefresh,
  onRefresh,
  onGo,
}: DirectoryBarProps) {
  const parent = parentOf(path);
  const crumbs = crumbsFor(
    path,
    home !== null && home !== "/" && isWithin(home, path) ? { path: home, name: "~" } : null,
  );
  const trail = useRef<HTMLElement>(null);
  // A long path keeps its end in view, which is where the picker is.
  useLayoutEffect(() => {
    const element = trail.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [path]);

  return (
    <div className="shrink-0 border-y">
      <div className="flex items-center gap-0.5 pr-1.5 pl-0.5">
        <Button
          variant="ghost"
          size="icon-touch"
          className="size-11"
          aria-label={parent === null ? "Nothing is above this" : upLabel(parent)}
          disabled={parent === null}
          onClick={() => {
            if (parent !== null) onGo(parent);
          }}
        >
          <ChevronLeftIcon />
        </Button>
        <h3 className="min-w-0 flex-1 truncate text-[0.9375rem] leading-6 font-semibold">
          {title}
        </h3>
        <Button
          variant="ghost"
          size="icon-touch"
          className={cn("size-11", showHidden && "text-lid")}
          aria-label="Show hidden directories"
          aria-pressed={showHidden}
          onClick={onToggleHidden}
        >
          {showHidden ? <EyeIcon /> : <EyeOffIcon />}
        </Button>
        <Button
          variant="ghost"
          size="icon-touch"
          className="size-11"
          aria-label="Refresh"
          disabled={loading || !canRefresh}
          onClick={onRefresh}
        >
          <RefreshCwIcon className={cn(loading && "motion-safe:animate-spin")} />
        </Button>
      </div>
      <nav
        ref={trail}
        aria-label="Path"
        className="flex overflow-x-auto px-4 pb-2 font-mono text-xs leading-5 whitespace-nowrap text-muted-foreground [scrollbar-width:none]"
        translate="no"
      >
        {crumbs.map((crumb, index) => {
          const here = index === crumbs.length - 1;
          return (
            <span key={crumb.path} className="flex shrink-0 items-center">
              {index > 0 && crumbs[index - 1].name !== "/" ? (
                <span className="px-1 text-faint">/</span>
              ) : null}
              {here ? (
                <span aria-current="page" className="text-foreground">
                  {crumb.name}
                </span>
              ) : (
                <button
                  type="button"
                  className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/70"
                  onClick={() => onGo(crumb.path)}
                >
                  {crumb.name}
                </button>
              )}
            </span>
          );
        })}
      </nav>
    </div>
  );
}

type DirectoryRowProps = {
  entry: FsEntry;
  path: string;
  /** The folder of the workspace that points at this directory, if one does. */
  folder: Folder | null;
  onOpen: (path: string) => void;
};

const DirectoryRow = memo(function DirectoryRow({
  entry,
  path,
  folder,
  onOpen,
}: DirectoryRowProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      className="flex h-12 w-full items-center gap-3 px-4 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        {folder ? <FolderIcon folder={folder} /> : <FileKindIcon entry={entry} />}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-sm",
          entry.name.startsWith(".") && "text-muted-foreground",
        )}
        translate="no"
      >
        {entry.name}
      </span>
      {entry.kind === "symlink" ? (
        <span className="shrink-0 text-[0.6875rem] text-faint">link</span>
      ) : null}
      {folder ? <Badge variant="secondary">Folder</Badge> : null}
      <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-faint" />
    </button>
  );
});

type NewDirectoryFormProps = {
  /** The directory the new one is made in. */
  parent: string;
  /** What is in it already, files included: none of their names is free. */
  entries: readonly FsEntry[];
  onCancel: () => void;
  /** Called with the new directory's path once the Mac has made it. */
  onMade: (path: string) => void;
};

function NewDirectoryForm({ parent, entries, onCancel, onMade }: NewDirectoryFormProps) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FsError | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const noteId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const check = checkDirectoryName(
      name,
      entries.map((entry) => entry.name),
    );
    if (!check.ok) {
      setProblem(check.reason);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    const made = joinPath(parent, check.name);
    try {
      await relay.request("fs.mkdir", { path: made });
    } catch (error) {
      const failed = toFsError(error);
      if (failed.code === "conflict") {
        // It appeared on the Mac after this list was read.
        setProblem(`“${check.name}” is already here.`);
        refreshListing(parent);
      } else {
        setFailure(failed);
      }
      setBusy(false);
      return;
    }
    refreshListing(parent);
    onMade(made);
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex shrink-0 flex-col gap-3 border-b px-4 py-3"
    >
      <FieldGroup>
        <Field data-invalid={problem !== null || undefined}>
          <FieldLabel htmlFor={fieldId}>Name of the new directory</FieldLabel>
          <Input
            ref={field}
            id={fieldId}
            name="directory-name"
            value={name}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            // Not disabled while the Mac is asked, which would put a phone's keyboard away.
            readOnly={busy}
            aria-invalid={problem !== null || undefined}
            aria-describedby={noteId}
            className="font-mono text-foreground"
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape leaves the name, not the whole picker.
              event.stopPropagation();
              onCancel();
            }}
          />
          {problem !== null ? (
            <FieldError id={noteId}>{problem}</FieldError>
          ) : (
            <FieldDescription id={noteId} className="truncate" translate="no">
              It is made in {tildify(parent)}
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
      {failure ? <Failure error={failure} doing="make" /> : null}
      <div className="flex gap-2">
        <Button type="button" variant="secondary" size="touch" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="touch" className="min-w-0 flex-1" disabled={busy}>
          {busy ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <FolderPlusIcon data-icon="inline-start" />
          )}
          Create directory
        </Button>
      </div>
    </form>
  );
}
