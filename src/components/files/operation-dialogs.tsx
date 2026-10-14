import type { FsCreateFileResult, FsRenameResult } from "@shared/protocol";
import { type FormEvent, useId, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { relay } from "@/lib/connection";
import { checkEntryName } from "@/lib/files/names";
import { describeOperationFailure } from "@/lib/files/operations";
import { joinPath, parentOf } from "@/lib/files/paths";
import type { PasteChoice, PasteItem } from "@/lib/files/paste-plan";
import { refreshListing, toFsError } from "@/lib/files/store";
import { tildify } from "@/lib/paths";
import { splitName } from "@shared/transfers";

export type NameTask =
  | { kind: "new-file" | "new-folder"; directory: string }
  | { kind: "rename"; path: string; name: string; isDirectory: boolean };

type NameDialogProps = {
  task: NameTask | null;
  /** The names in the directory now, none of which is free (except the entry's own). */
  siblings: readonly string[];
  onClose: () => void;
  /** Called with the new path once the Mac has done it. */
  onDone: (task: NameTask, path: string) => void;
};

const TITLES = { "new-file": "New file", "new-folder": "New folder", rename: "Rename" } as const;

/** Names a new file or folder, or an entry being renamed, and asks the Mac. */
export function NameDialog({ task, siblings, onClose, onDone }: NameDialogProps) {
  return (
    <Dialog open={task !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        {task ? (
          <NameForm
            key={task.kind === "rename" ? task.path : task.kind}
            task={task}
            siblings={siblings}
            onClose={onClose}
            onDone={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NameForm({ task, siblings, onClose, onDone }: NameDialogProps & { task: NameTask }) {
  const renaming = task.kind === "rename";
  const [name, setName] = useState(renaming ? task.name : "");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const noteId = useId();
  const directory = renaming ? (parentOf(task.path) ?? "/") : task.directory;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const check = checkEntryName(name, siblings, renaming ? task.name : null);
    if (!check.ok) {
      setProblem(check.reason);
      field.current?.focus();
      return;
    }
    if (renaming && check.name === task.name) {
      onClose();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      let path: string;
      if (task.kind === "rename") {
        path = (
          await relay.request<FsRenameResult>("fs.rename", { path: task.path, name: check.name })
        ).path;
      } else {
        path = joinPath(task.directory, check.name);
        if (task.kind === "new-folder") await relay.request("fs.mkdir", { path });
        else await relay.request<FsCreateFileResult>("fs.create_file", { path });
      }
      refreshListing(directory);
      onDone(task, path);
    } catch (error) {
      setBusy(false);
      // Something of that name may have appeared on the Mac since the list was read.
      if (toFsError(error).code === "conflict") refreshListing(directory);
      setProblem(
        toFsError(error).code === "conflict"
          ? `“${check.name}” is already here.`
          : describeOperationFailure(error),
      );
      field.current?.focus();
    }
  };

  const label =
    task.kind === "rename"
      ? `New name for this ${task.isDirectory ? "folder" : "file"}`
      : task.kind === "new-folder"
        ? "Name of the new folder"
        : "Name of the new file";

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{TITLES[task.kind]}</DialogTitle>
        <DialogDescription className="truncate font-mono text-xs" translate="no">
          In {tildify(directory)}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={problem !== null || undefined}>
          <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
          <Input
            ref={field}
            id={fieldId}
            name="entry-name"
            value={name}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            readOnly={busy}
            aria-invalid={problem !== null || undefined}
            aria-describedby={noteId}
            className="font-mono text-base text-foreground wide:text-sm"
            onFocus={(event) => {
              // Renaming starts with the part before the extension chosen, as on the Mac.
              if (!renaming) return;
              const stem = task.isDirectory ? name.length : splitName(name).stem.length;
              event.currentTarget.setSelectionRange(0, stem);
            }}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
          />
          {problem !== null ? (
            <FieldError id={noteId}>{problem}</FieldError>
          ) : (
            <FieldDescription id={noteId}>
              {renaming
                ? "Changing only the letter case is fine."
                : task.kind === "new-file"
                  ? "An empty file, which opens for editing."
                  : "Made on your Mac straight away."}
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="secondary" size="touch" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="touch" disabled={busy}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {renaming ? "Rename" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

const SHOWN_NAMES = 5;

function NameList({ items }: { items: readonly { name: string }[] }) {
  const shown = items.slice(0, SHOWN_NAMES);
  return (
    <ul className="flex flex-col gap-0.5 rounded-md bg-muted px-3 py-2 text-left font-mono text-xs leading-5 text-foreground">
      {shown.map((item, index) => (
        <li key={`${item.name}\n${index}`} className="truncate" translate="no">
          {item.name}
        </li>
      ))}
      {items.length > SHOWN_NAMES ? (
        <li className="font-sans text-muted-foreground">
          and {(items.length - SHOWN_NAMES).toLocaleString()} more
        </li>
      ) : null}
    </ul>
  );
}

type TrashDialogProps = {
  items: readonly PasteItem[] | null;
  onCancel: () => void;
  onConfirm: (items: readonly PasteItem[]) => void;
};

/** Asks before anything goes to the Trash, naming what goes. Cancel holds the focus. */
export function TrashDialog({ items, onCancel, onConfirm }: TrashDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const count = items?.length ?? 0;
  return (
    <AlertDialog open={items !== null} onOpenChange={(open) => (open ? null : onCancel())}>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {count === 1
              ? `Move “${items?.[0].name}” to the Trash?`
              : `Move ${count.toLocaleString()} items to the Trash?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            They go to the Trash on your Mac, where “Put Back” returns them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {items && count > 1 ? <NameList items={items} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} size="touch">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="touch"
            onClick={() => {
              if (items) onConfirm(items);
            }}
          >
            Move to Trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type PasteConflictDialogProps = {
  /** The items whose names are already in the destination. */
  conflicts: readonly PasteItem[] | null;
  /** How many items the paste holds in all. */
  total: number;
  onAnswer: (choice: PasteChoice | null) => void;
};

/** One question for every name in the way of a paste: keep both, replace, or leave those out. */
export function PasteConflictDialog({ conflicts, total, onAnswer }: PasteConflictDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const count = conflicts?.length ?? 0;
  return (
    <AlertDialog open={conflicts !== null} onOpenChange={(open) => (open ? null : onAnswer(null))}>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {count === 1
              ? `“${conflicts?.[0].name}” is already here`
              : `${count.toLocaleString()} names are already here`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {total > count
              ? `The other ${(total - count).toLocaleString()} ${total - count === 1 ? "item goes" : "items go"} in either way. `
              : ""}
            Replace only ever replaces a file with a file; a folder in the way stays and is
            reported.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {conflicts && count > 1 ? <NameList items={conflicts} /> : null}
        <AlertDialogFooter className="sm:flex-wrap">
          <AlertDialogCancel ref={cancelRef} size="touch" onClick={() => onAnswer(null)}>
            Cancel
          </AlertDialogCancel>
          <Button variant="secondary" size="touch" onClick={() => onAnswer("skip")}>
            Skip {count === 1 ? "it" : "these"}
          </Button>
          <Button variant="destructive" size="touch" onClick={() => onAnswer("replace")}>
            Replace
          </Button>
          <Button size="touch" onClick={() => onAnswer("rename")}>
            Keep both
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
