import { FOLDER_NAME_MAX, type Folder, TAB_TITLE_MAX, type Tab } from "@shared/protocol";
import { FolderOpenIcon, PencilLineIcon, XIcon } from "lucide-react";
import { type ComponentType, type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspaceActions } from "@/components/workspace-actions";
import { renameFolder, renameTab } from "@/lib/actions";
import { RpcFailure } from "@/lib/connection";
import { describeFailure, NEEDS_NEWER_HAKO } from "@/lib/errors";
import { tildify } from "@/lib/paths";
import { renameSupport, useRenameSupport } from "@/lib/probe";
import { navigate, routes } from "@/lib/route";

/** What a menu or the rename dialog is about. It stays set while the sheet slides away. */
export type MenuTarget = { kind: "tab"; tab: Tab } | { kind: "folder"; folder: Folder };

type ItemMenuProps = {
  target: MenuTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (target: MenuTarget) => void;
};

/** What can be done with a tab or a folder from the list, beyond opening it. */
export function ItemMenu({ target, open, onOpenChange, onRename }: ItemMenuProps) {
  const { canAct, askToClose } = useWorkspaceActions();
  const support = useRenameSupport();
  const close = () => onOpenChange(false);
  const renameDetail = !canAct
    ? "Your Mac is offline."
    : support === "no"
      ? NEEDS_NEWER_HAKO
      : target?.kind === "folder"
        ? "Only the name shown here and on your Mac; the directory keeps its name."
        : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] max-w-lg gap-0 overflow-y-auto rounded-t-2xl border-x pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle className="truncate">
            {target?.kind === "tab" ? target.tab.title : (target?.folder.name ?? "Folder")}
          </SheetTitle>
          <SheetDescription className="truncate font-mono text-xs leading-5" translate="no">
            {target?.kind === "folder" ? tildify(target.folder.directory) : "Tab"}
          </SheetDescription>
        </SheetHeader>
        {target ? (
          <div className="flex flex-col border-t">
            <MenuAction
              icon={PencilLineIcon}
              label="Rename"
              detail={renameDetail}
              disabled={!canAct || support === "no"}
              onClick={() => {
                close();
                onRename(target);
              }}
            />
            {target.kind === "folder" ? (
              <MenuAction
                icon={FolderOpenIcon}
                label="Show in Files"
                onClick={() => {
                  close();
                  navigate(routes.dir(target.folder.directory));
                }}
              />
            ) : (
              <MenuAction
                icon={XIcon}
                label="Close tab"
                destructive
                disabled={!canAct}
                onClick={() => {
                  close();
                  askToClose(target.tab);
                }}
              />
            )}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

type MenuActionProps = {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  label: string;
  detail?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
};

function MenuAction({
  icon: Icon,
  label,
  detail,
  disabled,
  destructive,
  onClick,
}: MenuActionProps) {
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

type RenameDialogProps = {
  target: MenuTarget | null;
  onClose: () => void;
};

/** A new title for a tab or a new name for a folder, or the one the Mac would give it. */
export function RenameDialog({ target, onClose }: RenameDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        {target ? (
          <RenameForm
            key={target.kind === "tab" ? target.tab.id : target.folder.id}
            target={target}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ target, onClose }: { target: MenuTarget; onClose: () => void }) {
  const tab = target.kind === "tab";
  const current = tab ? target.tab.title : target.folder.name;
  const max = tab ? TAB_TITLE_MAX : FOLDER_NAME_MAX;
  const [value, setValue] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const noteId = useId();

  const send = async (name: string | null) => {
    setBusy(name === null ? "reset" : "save");
    setProblem(null);
    try {
      if (target.kind === "tab") await renameTab(target.tab.id, name);
      else await renameFolder(target.folder.id, name);
      onClose();
    } catch (error) {
      if (error instanceof RpcFailure && error.code === "not_supported") {
        renameSupport.unsupported();
      }
      setBusy(null);
      setProblem(
        error instanceof RpcFailure && error.code === "not_found"
          ? `This ${tab ? "tab" : "folder"} is no longer open on your Mac.`
          : describeFailure(error),
      );
      field.current?.focus();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = value.trim();
    if (trimmed === "") {
      setProblem(`A ${tab ? "title" : "name"} needs at least one character.`);
      field.current?.focus();
      return;
    }
    if ([...trimmed].length > max) {
      setProblem(`At most ${max} characters.`);
      field.current?.focus();
      return;
    }
    if (trimmed === current) {
      onClose();
      return;
    }
    void send(trimmed);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{tab ? "Rename tab" : "Rename folder"}</DialogTitle>
        <DialogDescription className="truncate">
          {tab ? (
            "As the tab is called on your Mac too."
          ) : (
            <span className="font-mono text-xs" translate="no">
              {tildify(target.folder.directory)}
            </span>
          )}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={problem !== null || undefined}>
          <FieldLabel htmlFor={fieldId}>{tab ? "Title" : "Name"}</FieldLabel>
          <Input
            ref={field}
            id={fieldId}
            name={tab ? "tab-title" : "folder-name"}
            value={value}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            readOnly={busy !== null}
            aria-invalid={problem !== null || undefined}
            aria-describedby={noteId}
            className="text-base text-foreground wide:text-sm"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setValue(event.target.value);
              setProblem(null);
            }}
          />
          {problem !== null ? (
            <FieldError id={noteId}>{problem}</FieldError>
          ) : (
            <FieldDescription id={noteId}>
              {tab
                ? "The terminal in it goes by this name here."
                : "The directory on your Mac keeps its own name."}
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <Button
        type="button"
        variant="ghost"
        size="touch"
        className="self-start px-2 text-muted-foreground"
        disabled={busy !== null}
        onClick={() => void send(null)}
      >
        {busy === "reset" ? <Spinner data-icon="inline-start" /> : null}
        {tab ? "Use automatic title" : "Use default name"}
      </Button>
      <DialogFooter>
        <Button type="button" variant="secondary" size="touch" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="touch" disabled={busy !== null}>
          {busy === "save" ? <Spinner data-icon="inline-start" /> : null}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
