import type { GitFile, GitRepo } from "@shared/protocol";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitMergeIcon,
  RefreshCwIcon,
} from "lucide-react";
import { memo, useMemo } from "react";
import { ActivityLine } from "@/components/git/activity-line";
import { LineCounts, StatusMark } from "@/components/git/file-status";
import { RepoActions } from "@/components/git/repo-actions";
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
import { branchLabel, isUnpublished, plural } from "@/lib/git/repos";
import { useRepo, useRepoStatus } from "@/lib/git/store";
import { useConnection } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

type RepoDetailProps = {
  repoPath: string;
  /** The file whose diff is open beside the list, which its row marks. */
  selectedFile: string | null;
};

/** One repository: what changed in it, and commit, push and pull under the thumb. */
export function RepoDetail({ repoPath, selectedFile }: RepoDetailProps) {
  const { link, agent } = useConnection();
  const offline = link === "open" && agent?.online === false;
  const { data, error, loading, reload } = useRepoStatus(repoPath);
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
                <span className="flex min-w-0 items-center gap-1" translate="no">
                  <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{branchLabel(repo)}</span>
                </span>
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
          onClick={reload}
        >
          <RefreshCwIcon className={cn(loading && "motion-safe:animate-spin")} />
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {offline ? (
          <MacOffline />
        ) : files && repo && !unsupported ? (
          <>
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
            {files.length === 0 ? (
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
              <>
                <p className="flex items-center gap-3 px-safe pt-4 pb-1.5 text-[0.8125rem] text-muted-foreground">
                  <span className="flex-1">
                    {plural(files.length, "changed file")}
                    {data?.truncated ? ", and more that are not listed" : ""}
                  </span>
                  <LineCounts
                    additions={totals.additions}
                    deletions={totals.deletions}
                    binary={false}
                  />
                </p>
                <ul className="divide-y border-y">
                  {files.map((file) => (
                    <FileRow
                      key={file.path}
                      repo={repo}
                      file={file}
                      selected={file.path === selectedFile}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
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

type FileRowProps = { repo: GitRepo; file: GitFile; selected: boolean };

const FileRow = memo(function FileRow({ repo, file, selected }: FileRowProps) {
  const cut = file.path.lastIndexOf("/");
  const name = file.path.slice(cut + 1);
  const directory = cut === -1 ? "" : file.path.slice(0, cut);
  const from =
    file.old_path === null
      ? null
      : file.old_path.slice(0, file.old_path.lastIndexOf("/") + 1) === file.path.slice(0, cut + 1)
        ? file.old_path.slice(file.old_path.lastIndexOf("/") + 1)
        : file.old_path;
  return (
    // A repository can have two thousand changed files; the ones off screen are not laid out.
    <li className="[contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]">
      <a
        href={routes.diff(repo.path, file.path)}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex min-h-[3.25rem] items-center gap-3 px-safe py-1.5 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
          selected && "bg-accent",
        )}
      >
        <StatusMark status={file.status} />
        <span className="flex min-w-0 flex-1 flex-col" translate="no">
          <span
            className={cn(
              "truncate font-mono text-sm leading-5",
              file.status === "deleted" && "text-muted-foreground line-through decoration-faint",
              selected && "text-lid",
            )}
          >
            {name}
          </span>
          {directory !== "" || from !== null ? (
            <span className="truncate font-mono text-[0.6875rem] leading-4 text-faint">
              {from !== null ? `was ${from}` : directory}
              {from !== null && directory !== "" ? ` · ${directory}` : ""}
            </span>
          ) : null}
        </span>
        <LineCounts
          additions={file.additions}
          deletions={file.deletions}
          binary={file.binary}
          className="shrink-0"
        />
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-faint" />
      </a>
    </li>
  );
});
