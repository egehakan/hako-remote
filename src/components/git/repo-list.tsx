import type { Folder, GitRepo } from "@shared/protocol";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { memo, useDeferredValue, useMemo, useState } from "react";
import { ActivityLine } from "@/components/git/activity-line";
import { useGitUi } from "@/components/git/git-ui";
import { RepoActions } from "@/components/git/repo-actions";
import { GitProblem, RepoListSkeleton } from "@/components/git/states";
import { FolderIcon } from "@/components/folder-icon";
import { MacOffline } from "@/components/mac-offline";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { baseName } from "@/lib/files/paths";
import { branchLabel, groupRepos, hasWork, isUnpublished, plural } from "@/lib/git/repos";
import { useActivity, useRepos } from "@/lib/git/store";
import { useConnection, useWorkspace } from "@/lib/hooks";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

/** Every repository and worktree in the folders of the Mac, those with something to do first. */
export function RepoList({ selected }: { selected: string | null }) {
  const { link, agent } = useConnection();
  const offline = link === "open" && agent?.online === false;
  const { data, error, loading, reload } = useRepos();
  const { windows } = useWorkspace();
  const [filter, setFilter] = useState("");
  const needle = useDeferredValue(filter);

  const folders = useMemo(() => {
    const byDirectory = new Map<string, Folder>();
    for (const window of windows ?? []) {
      for (const folder of window.folders) byDirectory.set(folder.directory, folder);
    }
    return byDirectory;
  }, [windows]);
  const folderNames = useMemo(
    () => new Map([...folders].map(([directory, folder]) => [directory, folder.name])),
    [folders],
  );

  const repos = data?.repos ?? null;
  const groups = useMemo(
    () => groupRepos(repos ?? [], needle, folderNames),
    [repos, needle, folderNames],
  );
  const total = repos?.length ?? 0;
  const matching = groups.reduce((sum, group) => sum + group.repos.length, 0);
  const withChanges = repos?.filter(hasWork).length ?? 0;
  const unsupported = error?.code === "not_supported";

  return (
    <>
      <header className="shrink-0 border-b pt-safe">
        <div className="flex items-center gap-0.5 pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
          <h1 className="min-w-0 flex-1 truncate py-3.5 text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
            Source control
          </h1>
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
        </div>
        {total > 0 && !unsupported ? (
          <div className="relative px-safe pb-2.5">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-3 left-[calc(max(1rem,env(safe-area-inset-left))+0.75rem)] size-4 text-faint"
            />
            <input
              type="text"
              inputMode="search"
              enterKeyHint="search"
              name="filter"
              aria-label="Filter repositories"
              placeholder="Filter by name, branch or folder…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="h-10 w-full rounded-lg border border-input bg-input/30 pr-10 pl-9 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 wide:text-sm"
            />
            {filter !== "" ? (
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1 right-[calc(max(1rem,env(safe-area-inset-right))+0.25rem)]"
                aria-label="Clear the filter"
                onClick={() => setFilter("")}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {offline ? (
          <MacOffline />
        ) : repos && !unsupported ? (
          <>
            {error ? (
              <Alert className="mx-auto mt-3 w-[calc(100%-2rem)]">
                <CircleAlertIcon />
                <AlertDescription>
                  Couldn’t refresh from your Mac. This is the list as it was last read.
                </AlertDescription>
              </Alert>
            ) : null}
            {total === 0 ? (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderGit2Icon />
                  </EmptyMedia>
                  <EmptyTitle>No repositories in your folders</EmptyTitle>
                  <EmptyDescription>
                    Hako looks for git repositories and worktrees in the directories of the folders
                    in its sidebar. Add a folder there and its repositories appear here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : matching === 0 ? (
              <p className="px-safe py-10 text-center text-sm leading-6 text-muted-foreground">
                No repository matches “{filter.trim()}”.
              </p>
            ) : (
              groups.map((group) => (
                <section key={group.id} aria-label={group.title} className="pb-1">
                  <h2 className="px-safe pt-5 pb-1.5 text-[0.8125rem] text-muted-foreground">
                    {group.title}
                  </h2>
                  <ul className="divide-y border-y">
                    {group.repos.map((repo) => (
                      <RepoRow
                        key={repo.path}
                        repo={repo}
                        folder={folders.get(repo.root) ?? null}
                        quiet={group.id === "quiet"}
                        selected={repo.path === selected}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </>
        ) : error ? (
          <GitProblem error={error} what="repositories">
            {unsupported ? null : (
              <Button variant="secondary" size="touch" onClick={reload}>
                Try again
              </Button>
            )}
          </GitProblem>
        ) : (
          <RepoListSkeleton />
        )}
      </main>

      {repos && total > 0 && !offline && !unsupported ? (
        <p
          role="status"
          className="shrink-0 border-t px-safe py-1.5 font-mono text-[0.6875rem] leading-4 text-faint"
        >
          {needle.trim() !== ""
            ? `${matching} of ${plural(total, "repository", "repositories")}`
            : `${plural(total, "repository", "repositories")}, ${withChanges} with changes`}
        </p>
      ) : null}
    </>
  );
}

type RepoRowProps = { repo: GitRepo; folder: Folder | null; quiet: boolean; selected: boolean };

/** What a repository is called beyond its name: the folder it sits in, or the repository it is a worktree of. */
function placeOf(repo: GitRepo, folder: Folder | null): string | null {
  if (repo.is_worktree && repo.main_path !== null) return `worktree of ${baseName(repo.main_path)}`;
  if (repo.path === repo.root) return null;
  return `in ${folder?.name ?? baseName(repo.root)}`;
}

const RepoRow = memo(function RepoRow({ repo, folder, quiet, selected }: RepoRowProps) {
  const ui = useGitUi();
  const activity = useActivity(repo.path);
  const place = placeOf(repo, folder);
  const isFolder = folder !== null && repo.path === repo.root;
  const Icon = repo.is_worktree ? GitBranchIcon : FolderGit2Icon;

  return (
    <li className={cn(selected && "bg-accent")}>
      <div className="flex items-stretch">
        <a
          href={routes.repo(repo.path)}
          aria-current={selected ? "page" : undefined}
          className="flex min-h-14 min-w-0 flex-1 items-start gap-3 py-2.5 pl-[max(1rem,env(safe-area-inset-left))] outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        >
          <span
            className={cn(
              "mt-0.5 flex size-6 shrink-0 items-center justify-center",
              quiet && "opacity-60",
            )}
          >
            {isFolder ? (
              <FolderIcon folder={folder} />
            ) : (
              <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                className={cn(
                  "min-w-0 truncate text-[0.9375rem] leading-5 font-medium",
                  quiet && "font-normal text-muted-foreground",
                  selected && "text-lid",
                )}
                translate="no"
              >
                {repo.name}
              </span>
              {place ? (
                <span className="min-w-12 shrink-[99] truncate text-[0.75rem] leading-5 text-faint">
                  {place}
                </span>
              ) : null}
            </span>
            <span
              className={cn(
                "flex min-w-0 items-center gap-x-2.5 font-mono text-xs leading-5",
                quiet ? "text-faint" : "text-muted-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1" translate="no">
                {repo.operation !== null ? (
                  <GitMergeIcon aria-hidden="true" className="size-3 shrink-0 text-destructive" />
                ) : (
                  <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
                )}
                <span className="truncate">{branchLabel(repo)}</span>
              </span>
              {repo.ahead > 0 ? (
                <span className="shrink-0 text-foreground" aria-label={`${repo.ahead} to push`}>
                  ↑{repo.ahead}
                </span>
              ) : null}
              {repo.behind > 0 ? (
                <span className="shrink-0 text-foreground" aria-label={`${repo.behind} to pull`}>
                  ↓{repo.behind}
                </span>
              ) : null}
              {repo.operation !== null ? (
                <span className="shrink-0 text-destructive">{repo.operation} in progress</span>
              ) : repo.changed > 0 ? (
                <span className="shrink-0 text-amber">{repo.changed} changed</span>
              ) : isUnpublished(repo) && !quiet ? (
                <span className="shrink-0">not published</span>
              ) : null}
            </span>
          </span>
          <ChevronRightIcon aria-hidden="true" className="mt-3 size-4 shrink-0 text-faint" />
        </a>
        <Button
          variant="ghost"
          size="icon-touch"
          className="mt-1 mr-[max(0.25rem,env(safe-area-inset-right))] size-11 shrink-0 text-muted-foreground"
          aria-label={`More for ${repo.name}`}
          onClick={() => ui.showMore(repo)}
        >
          <EllipsisIcon />
        </Button>
      </div>
      {quiet && activity === null ? null : (
        <div className="flex flex-col gap-1 pr-[max(1rem,env(safe-area-inset-right))] pb-2.5 pl-[calc(max(1rem,env(safe-area-inset-left))+2.25rem)]">
          {quiet ? null : <RepoActions repo={repo} layout="row" />}
          <ActivityLine repo={repo} />
        </div>
      )}
    </li>
  );
});
