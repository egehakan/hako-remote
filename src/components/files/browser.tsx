import { isDirectory } from "@shared/files";
import type { Folder, FsEntry, FsRoot } from "@shared/protocol";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  EyeOffIcon,
  HouseIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareTerminalIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileKindIcon } from "@/components/files/file-icon";
import { FileMenu, type MenuFile } from "@/components/files/save-file";
import { FsProblem, ListSkeleton } from "@/components/files/states";
import { TransferTray } from "@/components/files/transfer-tray";
import { VirtualList } from "@/components/files/virtual-list";
import { FolderIcon } from "@/components/folder-icon";
import { MacOffline } from "@/components/mac-offline";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { formatCount, formatModified, formatModifiedFull, formatSize } from "@/lib/files/format";
import { inDisplayOrder } from "@/lib/files/order";
import { baseName, crumbsFor, isWithin, joinPath, parentOf, rootFor } from "@/lib/files/paths";
import { filesPrefs, useFilesPrefs, useListing, useRoots } from "@/lib/files/store";
import { useConnection, useWorkspace } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { navigate, routes } from "@/lib/route";
import { uploadFiles } from "@/lib/transfers/actions";
import { useTransferSupport } from "@/lib/transfers/store";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 48;

type FilesBrowserProps = {
  /** The directory on show, or null for the list of places to start from. */
  path: string | null;
  /** The file open beside the list, which its row marks. */
  selectedFile: string | null;
};

/** The left-hand side of Files: where to start, and then one directory at a time. */
export function FilesBrowser({ path, selectedFile }: FilesBrowserProps) {
  const { link, agent } = useConnection();
  const offline = link === "open" && agent?.online === false;
  if (path === null) return <RootsList offline={offline} />;
  return <DirectoryList key={path} path={path} selectedFile={selectedFile} offline={offline} />;
}

type BrowserHeaderProps = {
  title: string;
  /** Where the back arrow leads, or null at the very top. */
  up: { href: string; label: string } | null;
  /** True while a fresh list is on its way. */
  loading: boolean;
  /** False while there is nobody to ask. */
  canRefresh: boolean;
  onRefresh: () => void;
  actions?: ReactNode;
  children?: ReactNode;
};

function BrowserHeader({
  title,
  up,
  loading,
  canRefresh,
  onRefresh,
  actions,
  children,
}: BrowserHeaderProps) {
  return (
    <header className="shrink-0 border-b pt-safe">
      <div
        className={cn(
          "flex items-center gap-0.5 pr-[max(0.375rem,env(safe-area-inset-right))]",
          up
            ? "pl-[max(0.125rem,env(safe-area-inset-left))]"
            : "pl-[max(1rem,env(safe-area-inset-left))]",
        )}
      >
        {up ? (
          <Button
            variant="ghost"
            size="icon-touch"
            className="size-11"
            aria-label={up.label}
            nativeButton={false}
            render={<a href={up.href} />}
          >
            <ChevronLeftIcon />
          </Button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate py-3.5 text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
          {title}
        </h1>
        {actions}
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
      {children}
    </header>
  );
}

const SOURCE_TITLES: Record<FsRoot["source"], string> = {
  folder: "Folders",
  terminal: "Where your terminals are",
  home: "Your Mac",
};

function RootsList({ offline }: { offline: boolean }) {
  const { data, error, loading, reload } = useRoots();
  const { windows } = useWorkspace();
  const { last } = useFilesPrefs();
  const folders = useMemo(() => {
    const byDirectory = new Map<string, Folder>();
    for (const window of windows ?? []) {
      for (const folder of window.folders) byDirectory.set(folder.directory, folder);
    }
    return byDirectory;
  }, [windows]);

  const groups = (["folder", "home", "terminal"] as const)
    .map((source) => ({
      source,
      roots: (data?.roots ?? []).filter((root) => root.source === source),
    }))
    .filter((group) => group.roots.length > 0);

  return (
    <>
      <BrowserHeader
        title="Files"
        up={null}
        loading={loading}
        canRefresh={!offline}
        onRefresh={reload}
      />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
        {offline ? (
          <MacOffline />
        ) : data && error?.code !== "not_supported" ? (
          <>
            {error ? <StaleNotice /> : null}
            {groups.map((group) => (
              <section key={group.source} aria-label={SOURCE_TITLES[group.source]}>
                <h2 className="px-safe pt-5 pb-1.5 text-[0.8125rem] text-muted-foreground">
                  {SOURCE_TITLES[group.source]}
                </h2>
                <ul className="divide-y border-y">
                  {group.roots.map((root) => {
                    const remembered = last[root.path];
                    const start =
                      remembered && isWithin(root.path, remembered) ? remembered : root.path;
                    const folder = folders.get(root.path);
                    return (
                      <li key={root.path}>
                        <a
                          href={routes.dir(start)}
                          className="flex min-h-14 items-center gap-3 px-safe py-2 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                        >
                          {folder ? (
                            <FolderIcon folder={folder} />
                          ) : root.source === "home" ? (
                            <HouseIcon
                              aria-hidden="true"
                              className="size-6 text-muted-foreground"
                            />
                          ) : (
                            <SquareTerminalIcon
                              aria-hidden="true"
                              className="size-6 text-muted-foreground"
                            />
                          )}
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-[0.9375rem] leading-5 font-medium">
                              {root.name}
                            </span>
                            <span
                              className="truncate font-mono text-xs leading-5 text-muted-foreground"
                              translate="no"
                            >
                              {start === root.path
                                ? tildify(root.path)
                                : `./${start.slice(root.path === "/" ? 1 : root.path.length + 1)}`}
                            </span>
                          </span>
                          <ChevronRightIcon aria-hidden="true" className="size-4 text-faint" />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </>
        ) : error ? (
          <FsProblem error={error} what="folder">
            {error.code === "not_supported" ? null : (
              <Button variant="secondary" size="touch" onClick={reload}>
                Try again
              </Button>
            )}
          </FsProblem>
        ) : (
          <ListSkeleton label="Loading your folders" />
        )}
      </main>
      <TransferTray />
    </>
  );
}

export function StaleNotice() {
  return (
    <Alert className="mx-auto mt-3 w-[calc(100%-2rem)]">
      <CircleAlertIcon />
      <AlertDescription>
        Couldn’t refresh from your Mac. This is the list as it was last read.
      </AlertDescription>
    </Alert>
  );
}

type Row = { entry: FsEntry; path: string };

type DirectoryListProps = { path: string; selectedFile: string | null; offline: boolean };

function DirectoryList({ path, selectedFile, offline }: DirectoryListProps) {
  const roots = useRoots();
  const { data, error, loading, reload } = useListing(path);
  const { showHidden } = useFilesPrefs();
  const [filter, setFilter] = useState("");
  const needle = useDeferredValue(filter).trim().toLowerCase();
  const support = useTransferSupport();
  const picker = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuFile | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback((file: MenuFile) => {
    setMenu(file);
    setMenuOpen(true);
  }, []);

  const root = rootFor(path, roots.data?.roots ?? []);
  const rootPath = root?.path ?? null;
  const loaded = data !== null;
  useEffect(() => {
    if (loaded && rootPath !== null) filesPrefs.remember(rootPath, path);
  }, [loaded, rootPath, path]);

  // A link may have guessed wrong about what is at the end of a path.
  const isFile = error?.code === "not_a_directory";
  useEffect(() => {
    if (isFile) navigate(routes.file(path), { replace: true });
  }, [isFile, path]);

  const rows = useMemo(
    () =>
      inDisplayOrder(data?.entries ?? []).map((entry): Row => ({
        entry,
        path: joinPath(path, entry.name),
      })),
    [data, path],
  );

  const { visible, hiddenCount } = useMemo(() => {
    let hiddenCount = 0;
    const visible = rows.filter(({ entry }) => {
      if (entry.name.startsWith(".")) {
        hiddenCount++;
        if (!showHidden) return false;
      }
      return needle === "" || entry.name.toLowerCase().includes(needle);
    });
    return { visible, hiddenCount };
  }, [rows, showHidden, needle]);

  const parent = parentOf(path);
  const atRoot = rootPath === path;
  const up =
    atRoot || parent === null
      ? { href: routes.files, label: "Back to the list of folders" }
      : { href: routes.dir(parent), label: `Up to ${baseName(parent)}` };
  // Until the roots are known the way here would be spelt out from `/`, only to shrink a moment
  // later.
  const rootsPending = roots.data === null && roots.error === null;
  const crumbs = rootsPending ? [{ name: baseName(path), path }] : crumbsFor(path, root);
  const total = showHidden ? rows.length : rows.length - hiddenCount;

  return (
    <>
      <BrowserHeader
        title={atRoot && root ? root.name : baseName(path)}
        up={up}
        loading={loading}
        canRefresh={!offline}
        onRefresh={reload}
        actions={
          <Button
            variant="ghost"
            size="icon-touch"
            className={cn("size-11", showHidden && "text-lid")}
            aria-label="Show hidden files"
            aria-pressed={showHidden}
            onClick={() => filesPrefs.set({ showHidden: !showHidden })}
          >
            {showHidden ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
        }
      >
        <nav
          aria-label="Path"
          className="flex overflow-x-auto px-safe pb-2 font-mono text-xs leading-5 whitespace-nowrap text-muted-foreground [scrollbar-width:none]"
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
                  <a
                    href={routes.dir(crumb.path)}
                    className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/70"
                  >
                    {crumb.name}
                  </a>
                )}
              </span>
            );
          })}
        </nav>
        <div className="relative px-safe pb-2.5">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-3 left-[calc(max(1rem,env(safe-area-inset-left))+0.75rem)] size-4 text-faint"
          />
          <input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            name="filter"
            aria-label="Filter this folder"
            placeholder="Filter this folder…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="h-10 w-full rounded-lg border border-input bg-input/30 pr-10 pl-9 font-mono text-base outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 wide:text-sm"
          />
          {filter !== "" ? (
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-1 right-[calc(max(1rem,env(safe-area-inset-right))+0.25rem)]"
              aria-label="Clear the filter"
              onClick={() => setFilter("")}
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
      </BrowserHeader>

      {offline ? (
        <>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <MacOffline />
          </main>
          {/* What was on its way waits here, and says so. */}
          <TransferTray />
        </>
      ) : data && error?.code !== "not_supported" ? (
        <>
          {error && !isFile ? <StaleNotice /> : null}
          {visible.length > 0 ? (
            <VirtualList
              items={visible}
              rowHeight={ROW_HEIGHT}
              itemKey={(row) => row.entry.name}
              renderRow={(row) => (
                <EntryRow
                  entry={row.entry}
                  path={row.path}
                  selected={row.path === selectedFile}
                  onMenu={openMenu}
                />
              )}
              scrollKey={path}
              resetKey={`${needle}\n${showHidden}`}
              label={`Contents of ${baseName(path)}`}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-safe py-10 text-center text-sm leading-6 text-muted-foreground">
              {needle !== "" ? (
                <p>Nothing here matches “{filter.trim()}”.</p>
              ) : hiddenCount > 0 ? (
                <>
                  <p>Only hidden files here.</p>
                  <Button
                    variant="secondary"
                    size="touch"
                    className="mt-4"
                    onClick={() => filesPrefs.set({ showHidden: true })}
                  >
                    Show hidden files
                  </Button>
                </>
              ) : (
                <p>This folder is empty.</p>
              )}
            </div>
          )}
          <TransferTray />
          <footer className="flex shrink-0 items-center gap-3 border-t py-1.5 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p role="status" className="font-mono text-[0.6875rem] leading-4 text-faint">
                {needle !== ""
                  ? `${formatCount(visible.length)} of ${formatCount(total)}`
                  : `${formatCount(total)} ${total === 1 ? "item" : "items"}`}
                {!showHidden && hiddenCount > 0 ? `, ${formatCount(hiddenCount)} hidden` : ""}
                {data.truncated ? ". Your Mac sent only the first 20,000." : ""}
              </p>
              {support.state === "no" ? (
                <p className="text-[0.75rem] leading-4 text-muted-foreground">
                  {NEEDS_NEWER_HAKO} The version running there can’t take or hand over files yet.
                </p>
              ) : null}
            </div>
            <Button
              variant="secondary"
              className="h-10 px-3.5"
              disabled={support.state === "no"}
              onClick={() => picker.current?.click()}
            >
              <UploadIcon data-icon="inline-start" />
              Upload
            </Button>
            {/* No `accept`: an iPhone then offers its photo library, its camera and its files. */}
            <input
              ref={picker}
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
              onChange={(event) => {
                uploadFiles(path, Array.from(event.target.files ?? []));
                // Emptied so that picking the same file again is a change too.
                event.target.value = "";
              }}
            />
          </footer>
          <FileMenu file={menu} open={menuOpen} onOpenChange={setMenuOpen} />
        </>
      ) : error && !isFile ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <FsProblem error={error} what="folder">
            {error.code === "not_supported" ? null : (
              <Button variant="secondary" size="touch" onClick={reload}>
                Try again
              </Button>
            )}
            {root && !atRoot ? (
              <Button
                variant="ghost"
                size="touch"
                nativeButton={false}
                render={<a href={routes.dir(root.path)} />}
              >
                Go to {root.name}
              </Button>
            ) : null}
          </FsProblem>
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-hidden">
          <ListSkeleton label="Loading this folder" />
        </main>
      )}
    </>
  );
}

type EntryRowProps = {
  entry: FsEntry;
  path: string;
  selected: boolean;
  onMenu: (file: MenuFile) => void;
};

const EntryRow = memo(function EntryRow({ entry, path, selected, onMenu }: EntryRowProps) {
  const directory = isDirectory(entry);
  const openable = directory || entry.kind === "file" || entry.target === "file";
  const hidden = entry.name.startsWith(".");
  const note =
    entry.kind === "symlink" && entry.target === null
      ? "broken link"
      : entry.kind === "symlink"
        ? "link"
        : entry.kind === "other"
          ? "not a file"
          : null;

  const contents = (
    <>
      <FileKindIcon entry={entry} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-sm",
          (hidden || !openable) && "text-muted-foreground",
          selected && "text-lid",
        )}
        translate="no"
      >
        {entry.name}
      </span>
      {note ? <span className="shrink-0 text-[0.6875rem] text-faint">{note}</span> : null}
      <span
        className="flex shrink-0 items-center gap-3 font-mono text-[0.6875rem] text-faint tabular-nums"
        title={formatModifiedFull(entry.mtime)}
      >
        {directory || !openable ? null : <span>{formatSize(entry.size)}</span>}
        <span className="min-w-[3.25rem] text-right whitespace-nowrap">
          {formatModified(entry.mtime)}
        </span>
      </span>
      {directory ? (
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-faint" />
      ) : null}
    </>
  );

  const layout = "flex h-12 items-center gap-3 px-safe";
  if (!openable) {
    return (
      <div className={cn(layout, "opacity-70")} aria-disabled="true">
        {contents}
      </div>
    );
  }
  const link =
    "outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset";
  if (directory) {
    return (
      <a href={routes.dir(path)} className={cn(layout, link)}>
        {contents}
      </a>
    );
  }
  // A file's row ends in its menu, which stands where a folder's row has its chevron.
  return (
    <div className={cn("flex h-12 items-stretch", selected && "bg-accent")}>
      <a
        href={routes.file(path)}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 pl-[max(1rem,env(safe-area-inset-left))]",
          link,
        )}
      >
        {contents}
      </a>
      <button
        type="button"
        aria-label={`More for ${entry.name}`}
        aria-haspopup="dialog"
        className="flex w-[calc(2.75rem+max(0px,env(safe-area-inset-right)-0.75rem))] shrink-0 items-center justify-center pr-[max(0px,env(safe-area-inset-right)-0.75rem)] text-faint outline-none hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        onClick={() => onMenu({ path, name: entry.name, size: entry.size })}
      >
        <EllipsisVerticalIcon aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
});
