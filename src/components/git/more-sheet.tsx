import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloudUploadIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useGitUi } from "@/components/git/git-ui";
import { canCommit } from "@/components/git/repo-actions";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { branchLabel, isUnpublished, plural } from "@/lib/git/repos";
import { useActivity, useHistorySupport, useRepo } from "@/lib/git/store";
import { tildify } from "@/lib/paths";
import { navigate, routes } from "@/lib/route";
import { cn } from "@/lib/utils";

type MoreSheetProps = {
  repoPath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ItemProps = {
  icon: ComponentType<{ className?: string }>;
  label: string;
  detail?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

function Item({ icon: Icon, label, detail, destructive, disabled, onSelect }: ItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex min-h-14 w-full items-center gap-3.5 px-4 py-2 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:opacity-45",
        destructive && "text-destructive",
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-base font-medium">{label}</span>
        {detail ? (
          <span
            className={cn(
              "text-[0.8125rem] leading-5",
              destructive ? "text-destructive/80" : "text-muted-foreground",
            )}
          >
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** Everything that can be done to one repository, the rare and the dangerous included. */
export function MoreSheet({ repoPath, open, onOpenChange }: MoreSheetProps) {
  const ui = useGitUi();
  const repo = useRepo(repoPath);
  const activity = useActivity(repoPath);
  const blocked = !ui.canAct || activity?.state === "running";
  const close = () => onOpenChange(false);
  const unpublished = repo !== null && isUnpublished(repo);
  const support = useHistorySupport();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-lg gap-0 rounded-t-2xl border-x pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>{repo?.name ?? "Repository"}</SheetTitle>
          {repo ? (
            <SheetDescription className="truncate font-mono text-xs leading-5" translate="no">
              {branchLabel(repo)} in {tildify(repo.path)}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        {repo ? (
          <div className="flex flex-col divide-y border-t">
            <Item
              icon={GitCommitHorizontalIcon}
              label="Commit…"
              detail={
                repo.changed > 0
                  ? `All ${plural(repo.changed, "changed file")}`
                  : repo.operation === "merge"
                    ? "Concludes the merge"
                    : "Nothing to commit"
              }
              disabled={blocked || !canCommit(repo)}
              onSelect={() => {
                close();
                ui.askCommit(repo);
              }}
            />
            <Item
              icon={unpublished ? CloudUploadIcon : ArrowUpIcon}
              label={unpublished ? "Publish branch" : "Push"}
              detail={
                repo.branch === null
                  ? "HEAD is detached: there is no branch to push"
                  : unpublished
                    ? `${repo.branch} is not on a remote yet`
                    : repo.ahead > 0
                      ? `${plural(repo.ahead, "commit")} to ${repo.upstream}`
                      : `Nothing new for ${repo.upstream}`
              }
              disabled={blocked || repo.branch === null}
              onSelect={() => {
                close();
                ui.push(repo);
              }}
            />
            <Item
              icon={ArrowDownIcon}
              label="Pull"
              detail={
                repo.upstream === null
                  ? "This branch follows no branch on a remote"
                  : repo.behind > 0
                    ? `${plural(repo.behind, "commit")} from ${repo.upstream}`
                    : `From ${repo.upstream}`
              }
              disabled={blocked || repo.upstream === null}
              onSelect={() => {
                close();
                ui.pull(repo);
              }}
            />
            <Item
              icon={GitBranchIcon}
              label="Switch branch…"
              detail={
                support === "no"
                  ? `Needs a newer Hako. ${NEEDS_NEWER_HAKO}`
                  : repo.branch === null
                    ? "HEAD is detached: pick a branch, or make one here"
                    : "Another branch, or a new one from here"
              }
              disabled={blocked || support === "no"}
              onSelect={() => {
                close();
                ui.pickBranch(repo);
              }}
            />
            <Item
              icon={FolderOpenIcon}
              label="Open in Files"
              onSelect={() => {
                close();
                navigate(routes.dir(repo.path));
              }}
            />
            <Item
              icon={Trash2Icon}
              label="Discard all changes…"
              detail={
                repo.changed > 0 || repo.operation !== null
                  ? "Asks first. Cannot be undone."
                  : "Nothing to discard"
              }
              destructive
              disabled={blocked || (repo.changed === 0 && repo.operation === null)}
              onSelect={() => {
                close();
                ui.askDiscard(repo, null);
              }}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
