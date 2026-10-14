import type { GitRepo } from "@shared/protocol";
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
import type { MergeTarget } from "@/lib/git/store";

export type Merging = { repo: GitRepo; target: MergeTarget };

type ConfirmMergeProps = {
  /** What is to be merged. It stays set while the dialog animates out. */
  merging: Merging | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (merging: Merging) => void;
};

/** Asks before merging a branch. Cancel holds the focus, so Return and Space merge nothing. */
export function ConfirmMergeDialog({ merging, open, onCancel, onConfirm }: ConfirmMergeProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const into = merging?.repo.branch ?? "the current branch";
  const from = merging?.target.branch ?? "";
  return (
    <AlertDialog
      open={open && merging !== null}
      onOpenChange={(next) => (next ? null : onCancel())}
    >
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Merge <BranchName name={from} /> into <BranchName name={into} />?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {merging?.repo.name}: git merges on your Mac, fast-forwarding when it can. If the two
            changed the same lines it stops at the conflicts, for you to resolve or abort.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} size="touch">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            size="touch"
            onClick={() => {
              if (merging) onConfirm(merging);
            }}
          >
            Merge
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type AbortMergeProps = {
  repo: GitRepo | null;
  /** The branch being merged, when git recorded it. */
  branch: string | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (repo: GitRepo) => void;
};

/** Asks before abandoning a merge in progress. Cancel holds the focus. */
export function AbortMergeDialog({ repo, branch, open, onCancel, onConfirm }: AbortMergeProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open && repo !== null} onOpenChange={(next) => (next ? null : onCancel())}>
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Abort merging {branch ? <BranchName name={branch} /> : "this branch"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {repo?.name} goes back to where it was before the merge. What you changed in the
            conflicted files to resolve them is lost.
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
              if (repo) onConfirm(repo);
            }}
          >
            Abort merge
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BranchName({ name }: { name: string }) {
  return (
    <span className="font-mono text-[0.95em] [overflow-wrap:anywhere]" translate="no">
      {name}
    </span>
  );
}
