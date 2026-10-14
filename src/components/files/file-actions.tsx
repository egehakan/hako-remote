import { firstFreeName } from "@shared/operations";
import { isDirectory } from "@shared/files";
import type { FsEntry } from "@shared/protocol";
import {
  ClipboardCopyIcon,
  ClipboardPasteIcon,
  CopyIcon,
  CornerDownRightIcon,
  CopyPlusIcon,
  EllipsisIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderUpIcon,
  ImageUpIcon,
  PackageIcon,
  PencilLineIcon,
  ScissorsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  COPY_PATH_LABEL,
  COPY_RELATIVE_PATH_LABEL,
  usePathCopy,
} from "@/components/files/copy-path";
import type { MenuTarget } from "@/components/files/entry-menu";
import type { NameTask } from "@/components/files/operation-dialogs";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { type FolderPick, readFolderPick, uploadFolder } from "@/lib/files/folder-upload";
import {
  type Clipboard,
  fileClipboard,
  moveToTrash,
  namesIn,
  paste,
  useClipboard,
  useOpsSupport,
} from "@/lib/files/operations";
import { baseName, joinPath } from "@/lib/files/paths";
import { type PasteChoice, type PasteItem, planPaste } from "@/lib/files/paste-plan";
import { useConnection } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { IOS } from "@/lib/platform";
import { navigate, routes } from "@/lib/route";
import { uploadFiles } from "@/lib/transfers/actions";
import { useTransferSupport } from "@/lib/transfers/store";
import { cn } from "@/lib/utils";

// Loaded just after the list, so the first screen does not wait for menus nobody has opened yet.
const EntryMenu = lazy(() =>
  import("@/components/files/entry-menu").then((module) => ({ default: module.EntryMenu })),
);
const NameDialog = lazy(() =>
  import("@/components/files/operation-dialogs").then((module) => ({
    default: module.NameDialog,
  })),
);
const TrashDialog = lazy(() =>
  import("@/components/files/operation-dialogs").then((module) => ({
    default: module.TrashDialog,
  })),
);
const PasteConflictDialog = lazy(() =>
  import("@/components/files/operation-dialogs").then((module) => ({
    default: module.PasteConflictDialog,
  })),
);

type FileActionsInput = {
  /** The directory on show. */
  path: string;
  /** Everything in it, hidden entries included. */
  entries: readonly FsEntry[];
  /** The names on screen, in their order, which select-all and a shift-click range go by. */
  visibleNames: readonly string[];
};

type PendingPaste = { clipboard: Clipboard; existing: string[]; conflicts: PasteItem[] };

/**
 * Selection, the clipboard and every change to a folder's entries, with the sheets and dialogs
 * they need and, on a keyboard, their shortcuts.
 */
export function useFileActions({ path, entries, visibleNames }: FileActionsInput) {
  const ops = useOpsSupport();
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const canChange = online && ops === "yes";
  const clipboard = useClipboard();

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nameTask, setNameTask] = useState<NameTask | null>(null);
  const [trashItems, setTrashItems] = useState<PasteItem[] | null>(null);
  const [pending, setPending] = useState<PendingPaste | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderClash, setFolderClash] = useState<{ pick: FolderPick; free: string } | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const zipPicker = useRef<HTMLInputElement>(null);

  const byName = useMemo(() => new Map(entries.map((entry) => [entry.name, entry])), [entries]);
  const names = useMemo(() => entries.map((entry) => entry.name), [entries]);

  const itemOf = useCallback(
    (name: string): PasteItem | null => {
      const entry = byName.get(name);
      return entry ? { path: joinPath(path, name), name, isDirectory: isDirectory(entry) } : null;
    },
    [byName, path],
  );
  const itemsOf = useCallback(
    (chosen: Iterable<string>) =>
      [...chosen].map(itemOf).filter((item): item is PasteItem => item !== null),
    [itemOf],
  );

  // A selection belongs to one folder, and forgets names that have gone from it.
  useEffect(() => {
    setSelected((before) => {
      const kept = [...before].filter((name) => byName.has(name));
      return kept.length === before.size ? before : new Set(kept);
    });
  }, [byName]);

  const exit = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const toggle = useCallback(
    (name: string, range = false) => {
      setSelecting(true);
      setSelected((before) => {
        const next = new Set(before);
        if (range && anchor.current !== null) {
          const from = visibleNames.indexOf(anchor.current);
          const to = visibleNames.indexOf(name);
          if (from !== -1 && to !== -1) {
            for (const between of visibleNames.slice(Math.min(from, to), Math.max(from, to) + 1)) {
              next.add(between);
            }
            return next;
          }
        }
        if (next.has(name)) next.delete(name);
        else next.add(name);
        anchor.current = name;
        return next;
      });
    },
    [visibleNames],
  );

  const selectAll = useCallback(() => {
    setSelecting(true);
    setSelected(new Set(visibleNames));
  }, [visibleNames]);

  const copy = useCallback(
    (items: PasteItem[], mode: Clipboard["mode"]) => {
      if (items.length === 0) return;
      fileClipboard.set({ mode, items, from: path });
      exit();
    },
    [path, exit],
  );

  const duplicate = useCallback(
    (items: PasteItem[]) => {
      if (items.length === 0) return;
      exit();
      void paste("copy", items, path, names, null, { duplicate: true });
    },
    [path, names, exit],
  );

  const rename = useCallback((item: PasteItem | null) => {
    if (item) setNameTask({ kind: "rename", ...item });
  }, []);

  const pasteHere = useCallback(async () => {
    const current = fileClipboard.get();
    if (!current) return;
    let existing: string[];
    try {
      existing = await namesIn(path);
    } catch {
      existing = names;
    }
    const plan = planPaste({
      mode: current.mode,
      items: current.items,
      destination: path,
      existing,
      choice: null,
    });
    if (plan.needsChoice) {
      setPending({ clipboard: current, existing, conflicts: plan.conflicts });
      return;
    }
    fileClipboard.set(null);
    void paste(current.mode, current.items, path, existing, null);
  }, [path, names]);

  const answerPaste = (choice: PasteChoice | null) => {
    const asked = pending;
    setPending(null);
    if (!asked || choice === null) return;
    fileClipboard.set(null);
    void paste(asked.clipboard.mode, asked.clipboard.items, path, asked.existing, choice);
  };

  const openMenu = useCallback((target: MenuTarget) => {
    setMenu(target);
    setMenuOpen(true);
  }, []);

  const pickFolder = async (files: File[]) => {
    const pick = readFolderPick(files);
    if (!pick) return;
    let existing: string[];
    try {
      existing = await namesIn(path);
    } catch {
      existing = names;
    }
    const free = firstFreeName(pick.name, true, existing);
    if (free === pick.name) void uploadFolder(path, pick, pick.name);
    else setFolderClash({ pick, free });
  };

  // Shortcuts on a keyboard, while nothing else has the keys.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']") ||
      menuOpen ||
      nameTask ||
      trashItems ||
      pending ||
      newOpen ||
      uploadOpen
    ) {
      return;
    }
    const focused =
      (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-entry]")?.dataset
        .entry ?? null;
    const chosen = selected.size > 0 ? [...selected] : focused !== null ? [focused] : [];
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const act = (run: () => void) => {
      event.preventDefault();
      run();
    };
    if (key === "escape" && selecting) return act(exit);
    if (modifier && key === "a") return act(selectAll);
    if (!canChange) return;
    if (modifier && (key === "c" || key === "x")) {
      // Text chosen on the page is copied as text, as anywhere else.
      if (window.getSelection()?.isCollapsed === false || chosen.length === 0) return;
      return act(() => copy(itemsOf(chosen), key === "c" ? "copy" : "move"));
    }
    if (modifier && key === "v" && fileClipboard.get()) return act(() => void pasteHere());
    if ((key === "delete" || key === "backspace") && chosen.length > 0) {
      return act(() => setTrashItems(itemsOf(chosen)));
    }
    const onLink = document.activeElement?.closest("a, button") != null;
    if ((key === "f2" || (key === "enter" && selecting && !onLink)) && chosen.length === 1) {
      return act(() => rename(itemOf(chosen[0])));
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const handlers = {
    onCopy: (target: MenuTarget) => copy([targetItem(target)], "copy"),
    onCut: (target: MenuTarget) => copy([targetItem(target)], "move"),
    onDuplicate: (target: MenuTarget) => duplicate([targetItem(target)]),
    onRename: (target: MenuTarget) => rename(targetItem(target)),
    onTrash: (target: MenuTarget) => setTrashItems([targetItem(target)]),
    onSelect: () => {
      setSelecting(true);
      if (menu && !menu.here) setSelected(new Set([menu.name]));
    },
    onPaste: clipboard ? () => void pasteHere() : null,
  };

  const selectedItems = itemsOf(selected);

  const dialogs = (
    <Suspense fallback={null}>
      <EntryMenu target={menu} open={menuOpen} onOpenChange={setMenuOpen} {...handlers} />
      <NameDialog
        task={nameTask}
        siblings={names}
        onClose={() => setNameTask(null)}
        onDone={(task, made) => {
          setNameTask(null);
          exit();
          if (task.kind === "new-file") navigate(routes.file(made));
        }}
      />
      <TrashDialog
        items={trashItems}
        onCancel={() => setTrashItems(null)}
        onConfirm={(items) => {
          setTrashItems(null);
          exit();
          void moveToTrash(items);
        }}
      />
      <PasteConflictDialog
        conflicts={pending?.conflicts ?? null}
        total={pending?.clipboard.items.length ?? 0}
        onAnswer={answerPaste}
      />
      <FolderClashDialog
        clash={folderClash}
        onCancel={() => setFolderClash(null)}
        onKeepBoth={(clash) => {
          setFolderClash(null);
          void uploadFolder(path, clash.pick, clash.free);
        }}
      />
      <NewSheet
        open={newOpen}
        onOpenChange={setNewOpen}
        offline={!online}
        fileReason={ops === "no" ? NEEDS_NEWER_HAKO : null}
        onChoose={(kind) => {
          setNewOpen(false);
          setNameTask({ kind, directory: path });
        }}
      />
      <UploadSheet
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        directory={path}
        onFiles={() => filePicker.current?.click()}
        onFolder={() => folderPicker.current?.click()}
        onZip={() => zipPicker.current?.click()}
      />
      {/* No `accept`: an iPhone then offers its photo library, its camera and its files. */}
      <input
        ref={filePicker}
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
      <input
        ref={folderPicker}
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => {
          void pickFolder(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <input
        ref={zipPicker}
        type="file"
        accept=".zip,application/zip"
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onChange={(event) => {
          uploadFiles(path, Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </Suspense>
  );

  return {
    selecting,
    selected,
    toggle,
    exit,
    selectAll,
    openMenu,
    canChange,
    clipboard,
    pasteHere,
    openNew: () => setNewOpen(true),
    openUpload: () => setUploadOpen(true),
    dialogs,
    selectionBar: selecting ? (
      <>
        {selectedItems.length === 1 ? <PathBar path={selectedItems[0].path} /> : null}
        <SelectionBar
          count={selected.size}
          enabled={canChange}
          onCopy={() => copy(selectedItems, "copy")}
          onCut={() => copy(selectedItems, "move")}
          onDuplicate={() => duplicate(selectedItems)}
          onRename={() => rename(selectedItems[0] ?? null)}
          onTrash={() => setTrashItems(selectedItems)}
          onMore={() => {
            const only = selectedItems[0];
            const entry = only ? byName.get(only.name) : undefined;
            if (only && entry) {
              openMenu({ ...only, size: entry.size, here: false });
            }
          }}
        />
      </>
    ) : null,
  };
}

function targetItem(target: MenuTarget): PasteItem {
  return { path: target.path, name: target.name, isDirectory: target.isDirectory };
}

/** Copies the path of the one item selected. */
function PathBar({ path }: { path: string }) {
  const { copyPath, copyRelativePath } = usePathCopy();
  return (
    <div className="grid shrink-0 grid-cols-2 border-t bg-card pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <button
        type="button"
        onClick={() => copyPath(path)}
        className="flex min-h-11 items-center justify-center gap-2 px-2 text-[0.8125rem] leading-5 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <ClipboardCopyIcon className="size-4 shrink-0" aria-hidden="true" />
        {COPY_PATH_LABEL}
      </button>
      <button
        type="button"
        onClick={() => copyRelativePath(path)}
        className="flex min-h-11 items-center justify-center gap-2 border-l px-2 text-[0.8125rem] leading-5 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <CornerDownRightIcon className="size-4 shrink-0" aria-hidden="true" />
        {COPY_RELATIVE_PATH_LABEL}
      </button>
    </div>
  );
}

type SelectionBarProps = {
  count: number;
  enabled: boolean;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onTrash: () => void;
  onMore: () => void;
};

/** The actions for what is selected, at the bottom where a thumb reaches them. */
function SelectionBar({
  count,
  enabled,
  onCopy,
  onCut,
  onDuplicate,
  onRename,
  onTrash,
  onMore,
}: SelectionBarProps) {
  const none = !enabled || count === 0;
  return (
    <nav
      aria-label="Actions for the selected items"
      className="grid shrink-0 grid-cols-6 border-t bg-card pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
    >
      <BarButton icon={CopyIcon} label="Copy" disabled={none} onClick={onCopy} />
      <BarButton icon={ScissorsIcon} label="Cut" disabled={none} onClick={onCut} />
      <BarButton icon={CopyPlusIcon} label="Duplicate" disabled={none} onClick={onDuplicate} />
      <BarButton
        icon={PencilLineIcon}
        label="Rename"
        disabled={!enabled || count !== 1}
        onClick={onRename}
      />
      <BarButton icon={Trash2Icon} label="Trash" destructive disabled={none} onClick={onTrash} />
      <BarButton icon={EllipsisIcon} label="More" disabled={count !== 1} onClick={onMore} />
    </nav>
  );
}

type BarButtonProps = {
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  label: string;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
};

function BarButton({ icon: Icon, label, disabled, destructive, onClick }: BarButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-14 flex-col items-center justify-center gap-1 px-0.5 text-[0.6875rem] leading-4 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:text-faint",
        destructive && "text-destructive",
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
      {label}
    </button>
  );
}

type ClipboardBarProps = {
  clipboard: Clipboard;
  directory: string;
  enabled: boolean;
  onPaste: () => void;
};

/** What the clipboard holds, while it holds something, with the way to paste it here. */
export function ClipboardBar({ clipboard, directory, enabled, onPaste }: ClipboardBarProps) {
  const count = clipboard.items.length;
  const what = count === 1 ? `“${clipboard.items[0].name}”` : `${count.toLocaleString()} items`;
  const already = clipboard.mode === "move" && clipboard.from === directory;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-t bg-card py-1 pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]"
    >
      <ClipboardPasteIcon aria-hidden="true" className="size-4 shrink-0 text-lid" />
      <p className="min-w-0 flex-1 truncate text-[0.8125rem] leading-5">
        {clipboard.mode === "copy" ? "Copied" : "Cut"} {what}
        <span className="text-muted-foreground" translate="no">
          {" "}
          from {baseName(clipboard.from)}
        </span>
      </p>
      <Button className="h-9 px-3" disabled={!enabled || already} onClick={onPaste}>
        {already ? "Already here" : "Paste here"}
      </Button>
      <Button
        variant="ghost"
        size="icon-touch"
        className="size-10 text-muted-foreground"
        aria-label="Clear the clipboard"
        onClick={() => fileClipboard.set(null)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

type SheetOptionProps = {
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  label: string;
  detail?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
};

function SheetOption({ icon: Icon, label, detail, disabled, onClick }: SheetOptionProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-14 w-full items-center gap-3.5 px-4 py-2 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:text-muted-foreground"
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-base font-medium">{label}</span>
        {detail ? (
          <span className="text-[0.8125rem] leading-5 text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </button>
  );
}

const SHEET =
  "mx-auto max-w-lg gap-0 rounded-t-2xl border-x pb-[max(0.5rem,env(safe-area-inset-bottom))]";

type NewSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offline: boolean;
  /** Why an empty file can't be made, which a Hako without round 1 can't do. */
  fileReason: string | null;
  onChoose: (kind: "new-file" | "new-folder") => void;
};

function NewSheet({ open, onOpenChange, offline, fileReason, onChoose }: NewSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className={SHEET}>
        <SheetHeader className="pr-12">
          <SheetTitle>New</SheetTitle>
          <SheetDescription>
            {offline ? "Your Mac is offline." : "Made in this folder on your Mac."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col border-t">
          <SheetOption
            icon={FolderPlusIcon}
            label="Folder"
            disabled={offline}
            onClick={() => onChoose("new-folder")}
          />
          <SheetOption
            icon={FilePlusIcon}
            label="Empty file"
            detail={fileReason ?? "Opens once it is made"}
            disabled={offline || fileReason !== null}
            onClick={() => onChoose("new-file")}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

type UploadSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string;
  onFiles: () => void;
  onFolder: () => void;
  onZip: () => void;
};

function UploadSheet({
  open,
  onOpenChange,
  directory,
  onFiles,
  onFolder,
  onZip,
}: UploadSheetProps) {
  const transfers = useTransferSupport();
  const ops = useOpsSupport();
  const blocked = transfers.state === "no" ? NEEDS_NEWER_HAKO : null;
  // The picker opens from the same tap, which a phone requires, and the sheet closes behind it.
  const pick = (open: () => void) => () => {
    open();
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className={SHEET}>
        <SheetHeader className="pr-12">
          <SheetTitle>Upload</SheetTitle>
          <SheetDescription className="truncate font-mono text-xs" translate="no">
            Into {tildify(directory)}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col border-t">
          <SheetOption
            icon={ImageUpIcon}
            label={IOS ? "Photos and files" : "Files"}
            detail={blocked ?? "Several at a time, exactly as they are"}
            disabled={blocked !== null}
            onClick={pick(onFiles)}
          />
          {IOS ? (
            <>
              <SheetOption
                icon={PackageIcon}
                label="A folder, as a .zip"
                detail={
                  blocked ??
                  (ops === "no"
                    ? `${NEEDS_NEWER_HAKO} It unpacks the zip.`
                    : "Then use “Extract here” on the zip.")
                }
                disabled={blocked !== null}
                onClick={pick(onZip)}
              />
              <p className="px-4 pt-1 pb-3 text-[0.8125rem] leading-5 text-muted-foreground">
                Safari on iPhone can’t pick a folder. In the Files app, press and hold the folder,
                choose Compress, and upload the .zip it makes.
              </p>
            </>
          ) : (
            <SheetOption
              icon={FolderUpIcon}
              label="A folder"
              detail={blocked ?? "Its folders are made on your Mac, then its files follow"}
              disabled={blocked !== null}
              onClick={pick(onFolder)}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type FolderClash = { pick: FolderPick; free: string };

function FolderClashDialog({
  clash,
  onCancel,
  onKeepBoth,
}: {
  clash: FolderClash | null;
  onCancel: () => void;
  onKeepBoth: (clash: FolderClash) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={clash !== null} onOpenChange={(open) => (open ? null : onCancel())}>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>“{clash?.pick.name}” is already here</AlertDialogTitle>
          <AlertDialogDescription>
            Upload it beside the one that is there, as “{clash?.free}”? Nothing in the folder that
            is there changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} size="touch">
            Cancel
          </AlertDialogCancel>
          <Button size="touch" onClick={() => clash && onKeepBoth(clash)}>
            Keep both
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
