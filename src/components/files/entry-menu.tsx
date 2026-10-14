import {
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  DownloadIcon,
  FileArchiveIcon,
  ListChecksIcon,
  PackageOpenIcon,
  PencilLineIcon,
  ScissorsIcon,
  Trash2Icon,
} from "lucide-react";
import { type ComponentType, type ReactNode, useId, useState } from "react";
import { SAVE_LABEL, useSaving } from "@/components/files/save-file";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { formatSize } from "@/lib/files/format";
import { downloadFolder, extractHere, useOpsSupport } from "@/lib/files/operations";
import { parentOf } from "@/lib/files/paths";
import { useConnection } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { saveToDevice } from "@/lib/transfers/actions";
import { useTransferSupport } from "@/lib/transfers/store";

export type MenuTarget = {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  /** True for the folder on show rather than an entry of its list. */
  here: boolean;
};

export type EntryMenuHandlers = {
  onCopy: (target: MenuTarget) => void;
  onCut: (target: MenuTarget) => void;
  onDuplicate: (target: MenuTarget) => void;
  onRename: (target: MenuTarget) => void;
  onTrash: (target: MenuTarget) => void;
  onSelect: () => void;
  /** Present while the clipboard holds something to paste here. */
  onPaste: (() => void) | null;
};

type EntryMenuProps = EntryMenuHandlers & {
  target: MenuTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function isZip(name: string): boolean {
  return /\.zip$/i.test(name);
}

/** What can be done with one entry of a folder's list, or with the folder on show. */
export function EntryMenu({ target, open, onOpenChange, ...handlers }: EntryMenuProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] max-w-lg gap-0 overflow-y-auto rounded-t-2xl border-x pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle className="truncate font-mono" translate="no">
            {target?.name ?? "File"}
          </SheetTitle>
          {target ? (
            <SheetDescription className="truncate font-mono text-xs leading-5" translate="no">
              {target.here ? "This folder" : tildify(parentOf(target.path) ?? "/")}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        {target ? (
          <MenuBody target={target} close={() => onOpenChange(false)} {...handlers} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function MenuBody({
  target,
  close,
  onCopy,
  onCut,
  onDuplicate,
  onRename,
  onTrash,
  onSelect,
  onPaste,
}: EntryMenuHandlers & { target: MenuTarget; close: () => void }) {
  const ops = useOpsSupport();
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const transfers = useTransferSupport();
  const saving = useSaving(target.isDirectory ? null : target.size);
  const [skipHeavy, setSkipHeavy] = useState(true);
  const switchId = useId();
  const opsReason = !online ? "Your Mac is offline." : ops === "no" ? NEEDS_NEWER_HAKO : null;
  const opsOff = opsReason !== null || ops !== "yes";
  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <div className="flex flex-col border-t">
      {target.isDirectory ? (
        <div className="flex flex-col border-b pb-1">
          <Action
            icon={FileArchiveIcon}
            label="Download as .zip"
            detail={
              opsReason ??
              (transfers.state === "no"
                ? NEEDS_NEWER_HAKO
                : `Zipped on your Mac, up to ${formatSize(transfers.limits.maxBytes)}`)
            }
            disabled={opsOff || transfers.state === "no"}
            onClick={run(() => void downloadFolder(target.path, skipHeavy))}
          />
          <label
            htmlFor={switchId}
            className="flex min-h-12 items-center gap-3.5 px-4 pb-2 pl-[3.375rem] text-[0.8125rem] leading-5 text-muted-foreground"
          >
            <span className="min-w-0 flex-1">
              Leave out heavy folders: .git, node_modules, virtual environments and build output
            </span>
            <Switch id={switchId} checked={skipHeavy} onCheckedChange={setSkipHeavy} />
          </label>
        </div>
      ) : (
        <>
          <Action
            icon={DownloadIcon}
            label={SAVE_LABEL}
            detail={saving.reason ?? formatSize(target.size)}
            disabled={!saving.possible}
            onClick={run(() => saveToDevice(target.path, target.name, target.size))}
          />
          {isZip(target.name) ? (
            <Action
              icon={PackageOpenIcon}
              label="Extract here"
              detail={opsReason ?? "Into a new folder beside it"}
              disabled={opsOff}
              onClick={run(() => void extractHere(target.path, parentOf(target.path) ?? "/"))}
            />
          ) : null}
        </>
      )}
      {target.here ? (
        <>
          {onPaste ? (
            <Action
              icon={ClipboardPasteIcon}
              label="Paste here"
              detail={opsReason}
              disabled={opsOff}
              onClick={run(onPaste)}
            />
          ) : null}
          <Action icon={ListChecksIcon} label="Select items" onClick={run(onSelect)} />
          <Action
            icon={CopyIcon}
            label="Copy this folder"
            detail={opsReason}
            disabled={opsOff}
            onClick={run(() => onCopy(target))}
          />
        </>
      ) : (
        <>
          <Action
            icon={CopyIcon}
            label="Copy"
            detail={opsReason}
            disabled={opsOff}
            onClick={run(() => onCopy(target))}
          />
          <Action
            icon={ScissorsIcon}
            label="Cut"
            disabled={opsOff}
            onClick={run(() => onCut(target))}
          />
          <Action
            icon={CopyPlusIcon}
            label="Duplicate"
            disabled={opsOff}
            onClick={run(() => onDuplicate(target))}
          />
          <Action
            icon={PencilLineIcon}
            label="Rename"
            disabled={opsOff}
            onClick={run(() => onRename(target))}
          />
          <Action
            icon={Trash2Icon}
            label="Move to Trash"
            destructive
            disabled={opsOff}
            onClick={run(() => onTrash(target))}
          />
          <Action icon={ListChecksIcon} label="Select" onClick={run(onSelect)} />
        </>
      )}
    </div>
  );
}

type ActionProps = {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  label: string;
  detail?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
};

function Action({ icon: Icon, label, detail, disabled, destructive, onClick }: ActionProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-13 w-full items-center gap-3.5 px-4 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:text-muted-foreground data-[destructive=true]:text-destructive data-[destructive=true]:disabled:text-muted-foreground"
      data-destructive={destructive === true}
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
