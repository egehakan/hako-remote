import type { GitRepo } from "@shared/protocol";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloudUploadIcon,
  EllipsisIcon,
  GitCommitHorizontalIcon,
} from "lucide-react";
import { useGitUi } from "@/components/git/git-ui";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { isUnpublished } from "@/lib/git/repos";
import { useActivity } from "@/lib/git/store";
import { cn } from "@/lib/utils";

type RepoActionsProps = {
  repo: GitRepo;
  /** `row` is the strip under a repository in the list; `bar` is the foot of its own screen. */
  layout: "row" | "bar";
  className?: string;
};

/** True when a commit has something to record: changed files, or a merge waiting to be concluded. */
export function canCommit(repo: GitRepo): boolean {
  return repo.changed > 0 || repo.operation === "merge";
}

/** Commit, push and pull for one repository, each shown only when it has something to do. */
export function RepoActions({ repo, layout, className }: RepoActionsProps) {
  const ui = useGitUi();
  const activity = useActivity(repo.path);
  const running = activity?.state === "running" ? activity.kind : null;
  const blocked = !ui.canAct || running !== null;
  const unpublished = isUnpublished(repo);
  const bar = layout === "bar";
  const committable = canCommit(repo);
  const pushable = unpublished || repo.ahead > 0;
  const pullable = repo.upstream !== null;
  const size = bar ? "touch" : "default";
  const height = bar ? "" : "h-10 rounded-[0.625rem] px-3 text-[0.9375rem]";

  const commitButton = (
    <Button
      variant={bar && committable ? "default" : "secondary"}
      size={size}
      className={cn(height, bar && "min-w-0 flex-1")}
      disabled={blocked || !committable}
      onClick={() => ui.askCommit(repo)}
    >
      {running === "commit" ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <GitCommitHorizontalIcon data-icon="inline-start" />
      )}
      <span className="truncate">{committable ? "Commit…" : "Nothing to commit"}</span>
      {repo.changed > 0 ? (
        <span className="font-mono text-[0.8125rem] tabular-nums opacity-75">{repo.changed}</span>
      ) : null}
    </Button>
  );
  const pushButton = pushable ? (
    <Button
      variant="secondary"
      size={size}
      className={cn(height, bar && "min-w-0 flex-1")}
      disabled={blocked}
      onClick={() => ui.push(repo)}
    >
      {running === "push" ? (
        <Spinner data-icon="inline-start" />
      ) : unpublished ? (
        <CloudUploadIcon data-icon="inline-start" />
      ) : (
        <ArrowUpIcon data-icon="inline-start" />
      )}
      {unpublished ? "Publish" : "Push"}
      {!unpublished && repo.ahead > 0 ? (
        <span className="font-mono text-[0.8125rem] tabular-nums opacity-75">{repo.ahead}</span>
      ) : null}
    </Button>
  ) : null;
  const pullButton = pullable ? (
    <Button
      variant="secondary"
      size={size}
      className={cn(height, bar && "min-w-0 flex-1")}
      disabled={blocked}
      onClick={() => ui.pull(repo)}
    >
      {running === "pull" ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <ArrowDownIcon data-icon="inline-start" />
      )}
      Pull
      {repo.behind > 0 ? (
        <span className="font-mono text-[0.8125rem] tabular-nums opacity-75">{repo.behind}</span>
      ) : null}
    </Button>
  ) : null;

  if (!bar) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        {committable ? commitButton : null}
        {pushButton}
        {pullButton}
      </div>
    );
  }

  const more = (
    <Button
      variant="secondary"
      size="icon-touch"
      aria-label={`More for ${repo.name}`}
      onClick={() => ui.showMore(repo)}
    >
      <EllipsisIcon />
    </Button>
  );
  // Three labelled buttons and the rest do not fit across a phone, so with something to commit
  // the commit has a line of its own.
  const synced = pushButton === null && pullButton === null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {committable || synced ? (
        <div className="flex items-center gap-2">
          {commitButton}
          {more}
        </div>
      ) : null}
      {synced ? null : (
        <div className="flex items-center gap-2">
          {pushButton}
          {pullButton}
          {committable ? null : more}
        </div>
      )}
    </div>
  );
}
