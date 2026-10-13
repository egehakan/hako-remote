import type { GitFile, GitRepo } from "@shared/protocol";
import { useRef } from "react";
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
import { plural, summarizeFiles } from "@/lib/git/repos";
import { useRepoStatus } from "@/lib/git/store";

type Target = { repo: GitRepo; file: GitFile | null };

type DiscardDialogProps = {
  target: Target | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (target: Target) => void;
};

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** What discarding one file does to it, which depends on what happened to the file. */
function fileConsequence(file: GitFile): string {
  const name = fileName(file.path);
  switch (file.status) {
    case "untracked":
      return `${name} was never committed, so discarding deletes it from your Mac.`;
    case "added":
      return `${name} is new and was never committed, so discarding deletes it from your Mac.`;
    case "deleted":
      return `${name} comes back as it was in the last commit.`;
    case "renamed":
      return `${name} goes back to ${file.old_path ?? "its old name"}, and what was changed in it is lost.`;
    case "conflicted":
      return `${name} goes back to the version of the last commit on this branch. The conflict markers, and the other side’s changes to it, are lost.`;
    case "modified":
      return `Every change to ${name} since the last commit is lost.`;
  }
}

/**
 * Asks before changes are thrown away, and says what exactly will be lost. Cancel holds the focus,
 * so Return and Space keep everything.
 */
export function DiscardDialog({ target, open, onCancel, onConfirm }: DiscardDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const everything = target !== null && target.file === null;
  const status = useRepoStatus(open && everything ? target.repo.path : null);
  const files = status.data?.files ?? null;
  // A file that was added but never committed is deleted by a discard just as an untracked one is.
  const fresh =
    files?.filter((file) => file.status === "untracked" || file.status === "added").length ?? null;
  const repo = target?.repo ?? null;
  const file = target?.file ?? null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {file !== null
              ? `Discard changes to ${fileName(file.path)}?`
              : `Discard all changes in ${repo?.name ?? "this repository"}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {file !== null ? (
              <>{fileConsequence(file)} </>
            ) : repo !== null ? (
              <>
                {plural(repo.changed, "file")} on your Mac {repo.changed === 1 ? "goes" : "go"} back
                to the last commit
                {files && files.length > 0 ? ` (${summarizeFiles(files)})` : ""}.{" "}
                {fresh === null
                  ? "Files that were never committed are deleted. "
                  : fresh > 0
                    ? `That includes ${plural(fresh, "file")} that ${fresh === 1 ? "was" : "were"} never committed (untracked or newly added): ${fresh === 1 ? "it is" : "they are"} deleted from your Mac. `
                    : ""}
                {repo.operation !== null ? `The ${repo.operation} in progress is abandoned. ` : ""}
              </>
            ) : null}
            <strong className="font-medium text-foreground">This cannot be undone.</strong>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} size="touch">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="touch"
            onClick={() => {
              if (target !== null) onConfirm(target);
            }}
          >
            {file !== null
              ? "Discard this file"
              : repo !== null && repo.changed > 0
                ? `Discard ${plural(repo.changed, "file")}`
                : "Discard all changes"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
