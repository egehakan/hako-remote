import type { GitMergeState, GitRepo } from "@shared/protocol";
import { ChevronRightIcon, GitMergeIcon } from "lucide-react";
import { useGitUi } from "@/components/git/git-ui";
import { StatusMark } from "@/components/git/file-status";
import { Button } from "@/components/ui/button";
import { joinPath } from "@/lib/files/paths";
import { plural } from "@/lib/git/repos";
import { useActivity } from "@/lib/git/store";
import { routes } from "@/lib/route";

type MergeBannerProps = { repo: GitRepo; merge: GitMergeState };

/**
 * A merge in progress: what is being merged, the files still in conflict, each of which opens in
 * Files to be resolved, and the way out.
 */
export function MergeBanner({ repo, merge }: MergeBannerProps) {
  const ui = useGitUi();
  const activity = useActivity(repo.path);
  const count = merge.conflicts.length;
  const what = merge.branch ?? "a branch";
  return (
    <section
      aria-label="Merge in progress"
      className="mx-auto mt-3 w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-amber/40 bg-card"
    >
      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
        <GitMergeIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-sm font-medium [overflow-wrap:anywhere]">
            Merging{" "}
            <span className="font-mono text-[0.8125rem]" translate="no">
              {what}
            </span>
            : {count === 0 ? "no conflicts left" : plural(count, "conflict")}
          </h2>
          <p className="text-[0.8125rem] leading-5 text-muted-foreground">
            {count === 0
              ? "Every conflict is resolved. Commit the merge to finish it."
              : "Open each file, keep the lines you want and delete the marker lines. Then commit the merge."}
          </p>
        </div>
      </div>
      {count > 0 ? (
        <ul className="divide-y border-t" aria-label="Files in conflict">
          {merge.conflicts.map((path) => {
            const cut = path.lastIndexOf("/");
            return (
              // A merge can stop at hundreds of files; the ones off screen are not laid out.
              <li
                key={path}
                className="[contain-intrinsic-size:auto_3rem] [content-visibility:auto]"
              >
                <a
                  href={routes.file(joinPath(repo.path, path))}
                  className="flex min-h-12 items-center gap-3 px-3 py-1.5 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                >
                  <StatusMark status="conflicted" />
                  <span className="flex min-w-0 flex-1 flex-col" translate="no">
                    <span className="truncate font-mono text-sm leading-5">
                      {path.slice(cut + 1)}
                    </span>
                    {cut === -1 ? null : (
                      <span className="truncate font-mono text-[0.6875rem] leading-4 text-faint">
                        {path.slice(0, cut)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[0.75rem] text-muted-foreground">Edit</span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-faint" />
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex justify-end border-t px-1.5 py-1.5">
        <Button
          variant="ghost"
          size="touch"
          className="text-destructive"
          disabled={!ui.canAct || activity?.state === "running"}
          onClick={() => ui.askAbortMerge(repo, merge.branch)}
        >
          Abort merge
        </Button>
      </div>
    </section>
  );
}
