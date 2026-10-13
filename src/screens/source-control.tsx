import { FileDiffIcon, GitBranchIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { CommitView } from "@/components/git/commit-view";
import { GitUiProvider } from "@/components/git/git-ui";
import { RepoDetail } from "@/components/git/repo-detail";
import { RepoList } from "@/components/git/repo-list";
import { DiffSkeleton } from "@/components/git/states";
import { LoadBoundary } from "@/components/load-boundary";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { Route } from "@/lib/route";
import { cn } from "@/lib/utils";

// The diff is the one screen here that most visits never reach.
const DiffView = lazy(() => import("@/components/git/diff-view"));

type GitRoute = Extract<Route, { name: "git" | "repo" | "diff" | "commit" | "commitFile" }>;

/**
 * Source control: the repositories of the Mac, then one repository's changed files and its graph,
 * on one side, and a file's diff or a commit on the other. A phone shows one of them at a time.
 */
export function SourceControlArea({ route }: { route: GitRoute }) {
  const repo = route.name === "git" ? null : route.repo;
  const commit = route.name === "commit" || route.name === "commitFile" ? route.commit : null;
  const file = route.name === "diff" || route.name === "commitFile" ? route.file : null;
  /** True when the second pane has something to show, which on a phone takes the whole screen. */
  const detail = file !== null || commit !== null;

  return (
    <GitUiProvider>
      <div className={cn("flex min-h-0 min-w-0 flex-col narrow:flex-1", detail && "narrow:hidden")}>
        {repo === null ? (
          <RepoList selected={null} />
        ) : (
          <RepoDetail
            key={repo}
            repoPath={repo}
            selectedFile={commit === null ? file : null}
            selectedCommit={commit}
          />
        )}
      </div>
      <div
        className={cn("min-h-0 min-w-0 wide:border-l", detail ? "narrow:flex-1" : "narrow:hidden")}
      >
        {repo !== null && file !== null ? (
          <LoadBoundary>
            <Suspense fallback={<DiffSkeleton />}>
              <DiffView
                key={`${repo}\n${commit ?? ""}\n${file}`}
                repoPath={repo}
                filePath={file}
                commit={commit}
              />
            </Suspense>
          </LoadBoundary>
        ) : repo !== null && commit !== null ? (
          <CommitView key={`${repo}\n${commit}`} repoPath={repo} commitId={commit} />
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {repo === null ? <GitBranchIcon /> : <FileDiffIcon />}
              </EmptyMedia>
              <EmptyTitle>
                {repo === null ? "Pick a repository" : "Pick a file or a commit"}
              </EmptyTitle>
              <EmptyDescription>
                {repo === null
                  ? "Its changed files and its graph are listed here, and a file’s diff or a commit opens beside them."
                  : "A changed file’s diff against the last commit opens here, and so does a commit from the graph."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </GitUiProvider>
  );
}
