import type { GitRepo } from "@shared/protocol";
import { ChevronsUpDownIcon, GitBranchIcon, GitMergeIcon } from "lucide-react";
import { useGitUi } from "@/components/git/git-ui";
import { Spinner } from "@/components/ui/spinner";
import { branchLabel } from "@/lib/git/repos";
import { useActivity, useHistorySupport } from "@/lib/git/store";
import { cn } from "@/lib/utils";

/**
 * The branch a repository is on, or the commit a detached HEAD is at. Where the Hako on the Mac can
 * switch branches it is the control that opens the list of them; otherwise it only says the name.
 */
export function BranchControl({ repo, className }: { repo: GitRepo; className?: string }) {
  const ui = useGitUi();
  const support = useHistorySupport();
  const activity = useActivity(repo.path);
  const switching = activity?.state === "running" && activity.kind === "switch";
  const Icon = repo.operation !== null ? GitMergeIcon : GitBranchIcon;
  const name = branchLabel(repo);
  const mark = switching ? (
    <Spinner aria-hidden="true" className="size-3 shrink-0" />
  ) : (
    <Icon
      aria-hidden="true"
      className={cn("size-3 shrink-0", repo.operation !== null && "text-destructive")}
    />
  );

  if (support !== "yes") {
    return (
      <span className={cn("flex min-w-0 items-center gap-1", className)} translate="no">
        {mark}
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`Switch branch. ${repo.name} is ${repo.branch === null ? "" : "on "}${name}`}
      disabled={!ui.canAct}
      onClick={() => ui.pickBranch(repo)}
      translate="no"
      className={cn(
        // Larger than it looks, so that a thumb finds it in a line of small type.
        "relative z-10 -my-2 -ml-2 flex min-w-0 items-center gap-1 rounded-md py-2 pr-1.5 pl-2 text-left outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none",
        className,
      )}
    >
      {mark}
      <span className="truncate">{name}</span>
      <ChevronsUpDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
    </button>
  );
}
