import { FileDiffIcon, GitBranchIcon } from "lucide-react";
import { lazy, Suspense } from "react";
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

type GitRoute = Extract<Route, { name: "git" | "repo" | "diff" }>;

/**
 * Source control: the repositories of the Mac, then one repository's changed files, on one side,
 * and a file's diff on the other. A phone shows one of the three at a time.
 */
export function SourceControlArea({ route }: { route: GitRoute }) {
  const repo = route.name === "git" ? null : route.repo;
  const file = route.name === "diff" ? route.file : null;

  return (
    <GitUiProvider>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col narrow:flex-1",
          file !== null && "narrow:hidden",
        )}
      >
        {repo === null ? (
          <RepoList selected={null} />
        ) : (
          <RepoDetail key={repo} repoPath={repo} selectedFile={file} />
        )}
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 wide:border-l",
          file !== null ? "narrow:flex-1" : "narrow:hidden",
        )}
      >
        {repo !== null && file !== null ? (
          <LoadBoundary>
            <Suspense fallback={<DiffSkeleton />}>
              <DiffView key={`${repo}\n${file}`} repoPath={repo} filePath={file} />
            </Suspense>
          </LoadBoundary>
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {repo === null ? <GitBranchIcon /> : <FileDiffIcon />}
              </EmptyMedia>
              <EmptyTitle>{repo === null ? "Pick a repository" : "Pick a file"}</EmptyTitle>
              <EmptyDescription>
                {repo === null
                  ? "Its changed files are listed here, and each one’s diff against the last commit opens beside them."
                  : "Its diff against the last commit opens here."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </GitUiProvider>
  );
}
