import {
  ChevronLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GitMergeIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useRef } from "react";
import { ActivityLine } from "@/components/git/activity-line";
import { BranchControl } from "@/components/git/branch-control";
import { FileRow } from "@/components/git/file-row";
import { LineCounts } from "@/components/git/file-status";
import { GraphSection } from "@/components/git/graph-section";
import { RepoActions } from "@/components/git/repo-actions";
import { SectionHeader } from "@/components/git/section-header";
import { FileListSkeleton, GitProblem } from "@/components/git/states";
import { MacOffline } from "@/components/mac-offline";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { baseName } from "@/lib/files/paths";
import { isUnpublished, plural } from "@/lib/git/repos";
import {
  gitPrefs,
  refreshRepo,
  useGitPrefs,
  useHistorySupport,
  useRepo,
  useRepoStatus,
} from "@/lib/git/store";
import { useConnection } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

type RepoDetailProps = {
  repoPath: string;
  /** The file whose diff is open beside the list, which its row marks. */
  selectedFile: string | null;
  /** The commit that is open beside the list, which its row in the graph marks. */
  selectedCommit: string | null;
};

/**
 * One repository: what changed in it, then its history as a graph, with commit, push and pull
 * under the thumb.
 */
export function RepoDetail({ repoPath, selectedFile, selectedCommit }: RepoDetailProps) {
  const { link, agent } = useConnection();
  const offline = link === "open" && agent?.online === false;
  const { data, error, loading, reload } = useRepoStatus(repoPath);
  const { changesOpen } = useGitPrefs();
  const support = useHistorySupport();
  const scroller = useRef<HTMLElement>(null);
  const listed = useRepo(repoPath);
  const repo = listed ?? data?.repo ?? null;
  const files = data?.files ?? null;
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files ?? []) {
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
    return { additions, deletions };
  }, [files]);
  const unsupported = error?.code === "not_supported";

  return (
    <>
      <header className="flex shrink-0 items-center gap-0.5 border-b pt-safe pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.125rem,env(safe-area-inset-left))]">
        <Button
          variant="ghost"
          size="icon-touch"
          className="size-11"
          aria-label="Back to the repositories"
          nativeButton={false}
          render={<a href={routes.git} />}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex min-h-[3.25rem] min-w-0 flex-1 flex-col justify-center px-1.5 py-1.5">
          <h1
            className="truncate text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]"
            translate="no"
          >
            {repo?.name ?? baseName(repoPath)}
          </h1>
          <p className="flex min-w-0 items-center gap-x-2 font-mono text-[0.6875rem] leading-4 text-muted-foreground">
            {repo ? (
              <>
                <BranchControl repo={repo} />
                {repo.ahead > 0 ? (
                  <span className="shrink-0 text-foreground">↑{repo.ahead}</span>
                ) : null}
                {repo.behind > 0 ? (
                  <span className="shrink-0 text-foreground">↓{repo.behind}</span>
                ) : null}
                {isUnpublished(repo) ? <span className="shrink-0">not published</span> : null}
              </>
            ) : (
              <span className="truncate" translate="no">
                {tildify(repoPath)}
              </span>
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-touch"
          className="size-11"
          aria-label="Refresh"
          disabled={loading || offline}
          onClick={() => refreshRepo(repoPath)}
        >
          <RefreshCwIcon className={cn(loading && "motion-safe:animate-spin")} />
        </Button>
      </header>

      <main ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {offline ? (
          <MacOffline />
        ) : files && repo && !unsupported ? (
          <div>
            {error ? (
              <Alert className="mx-auto mt-3 w-[calc(100%-2rem)]">
                <CircleAlertIcon />
                <AlertDescription>
                  Couldn’t refresh from your Mac. These are the changes as they were last read.
                </AlertDescription>
              </Alert>
            ) : null}
            {repo.operation !== null ? (
              <Alert className="mx-auto mt-3 w-[calc(100%-2rem)]">
                <GitMergeIcon />
                <AlertTitle>A {repo.operation} is in progress</AlertTitle>
                <AlertDescription>
                  {repo.operation === "merge"
                    ? "Commit to conclude it, with the files as they are now, or discard all changes to abandon it."
                    : `Finish or abandon the ${repo.operation} in a terminal on your Mac; a commit from here would not conclude it.`}
                </AlertDescription>
              </Alert>
            ) : null}
            <section aria-label="Changes">
              <SectionHeader
                open={changesOpen}
                onToggle={() => gitPrefs.set({ changesOpen: !changesOpen })}
                label={
                  files.length === 0
                    ? "No changed files"
                    : `${plural(files.length, "changed file")}${
                        data?.truncated ? ", and more that are not listed" : ""
                      }`
                }
                aside={
                  files.length > 0 ? (
                    <LineCounts
                      additions={totals.additions}
                      deletions={totals.deletions}
                      binary={false}
                    />
                  ) : null
                }
              />
              {!changesOpen ? null : files.length === 0 && support !== "no" ? (
                // With a graph below, a clean working tree is said in a line and no more.
                <p className="px-safe pt-0.5 pb-4 text-[0.8125rem] leading-5 text-muted-foreground">
                  Nothing to commit: the working tree of {repo.name} matches its last commit.
                </p>
              ) : files.length === 0 ? (
                <Empty className="py-14">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CircleCheckIcon />
                    </EmptyMedia>
                    <EmptyTitle>Nothing to commit</EmptyTitle>
                    <EmptyDescription>
                      The working tree of {repo.name} matches its last commit
                      {repo.ahead > 0
                        ? `, and ${plural(repo.ahead, "commit")} ${repo.ahead === 1 ? "waits" : "wait"} to be pushed`
                        : ""}
                      {repo.behind > 0
                        ? `${repo.ahead > 0 ? ";" : ","} ${plural(repo.behind, "commit")} can be pulled`
                        : ""}
                      .
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="divide-y border-y">
                  {files.map((file) => (
                    <FileRow
                      key={file.path}
                      href={routes.diff(repo.path, file.path)}
                      file={file}
                      selected={file.path === selectedFile}
                    />
                  ))}
                </ul>
              )}
            </section>
            <GraphSection repo={repo} scroller={scroller} selectedCommit={selectedCommit} />
          </div>
        ) : error ? (
          <GitProblem error={error} what="repository">
            {unsupported ? null : (
              <Button variant="secondary" size="touch" onClick={reload}>
                Try again
              </Button>
            )}
            <Button
              variant="ghost"
              size="touch"
              nativeButton={false}
              render={<a href={routes.git} />}
            >
              All repositories
            </Button>
          </GitProblem>
        ) : (
          <FileListSkeleton />
        )}
      </main>

      {repo && !offline && !unsupported ? (
        <footer className="shrink-0 border-t bg-background px-safe pt-2 pb-2.5 wide:pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <ActivityLine repo={repo} className="mb-1" />
          <RepoActions repo={repo} layout="bar" />
        </footer>
      ) : null}
    </>
  );
}
