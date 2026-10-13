import { ArrowUpCircleIcon, CircleQuestionMarkIcon, FolderXIcon, UnplugIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import type { GitError } from "@/lib/git/store";

type GitProblemProps = {
  error: GitError;
  /** What could not be read, as it reads in a sentence. */
  what: "repositories" | "repository" | "diff" | "branches" | "graph" | "commit";
  /** Buttons that lead somewhere useful from here. */
  children?: ReactNode;
};

/** Says why the Mac did not hand over what was asked, in git's own words where it gave any. */
export function GitProblem({ error, what, children }: GitProblemProps) {
  const subject =
    what === "repositories"
      ? "your repositories"
      : what === "branches"
        ? "the branches"
        : what === "graph"
          ? "the graph"
          : `this ${what}`;
  let Icon = CircleQuestionMarkIcon;
  let title = `Couldn’t read ${subject}`;
  let detail: ReactNode = "Your Mac reported a problem. Try again.";
  let quote: string | null = error.message || null;

  switch (error.code) {
    case "not_supported":
      Icon = ArrowUpCircleIcon;
      if (what === "branches" || what === "graph" || what === "commit") {
        title = "Branches and history need a newer Hako";
        detail = `${NEEDS_NEWER_HAKO} The version running there can’t switch branches or show commits from here yet.`;
      } else {
        title = "Source control needs a newer Hako";
        detail =
          "Update Hako on your Mac to use this. The version running there can’t share its repositories with this app yet.";
      }
      quote = null;
      break;
    case "not_found":
      Icon = FolderXIcon;
      title =
        what === "diff"
          ? "This file isn’t there any more"
          : what === "commit"
            ? "This commit isn’t there any more"
            : "This repository isn’t there any more";
      detail =
        what === "commit"
          ? "The history of this repository was rewritten on your Mac, or the commit was never in it."
          : "It was moved, renamed or deleted on your Mac.";
      quote = null;
      break;
    case "agent_offline":
    case "disconnected":
      Icon = UnplugIcon;
      title = "Your Mac went offline";
      detail = "This loads by itself when Hako on the Mac is back.";
      quote = null;
      break;
    case "timeout":
      title = "Your Mac didn’t answer";
      detail = "It may be busy, or asleep. Try again.";
      quote = null;
      break;
    case "git_failed":
      title = `Git couldn’t read ${subject}`;
      detail = "This is what git said on your Mac:";
      break;
    default:
      if (quote) detail = "This is what your Mac said:";
      break;
  }

  return (
    <Empty className="py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
        {quote ? (
          <p className="mt-1 max-w-full rounded-md bg-muted px-3 py-2 text-left font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
            {quote}
          </p>
        ) : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

const WIDTHS = ["w-32", "w-44", "w-28", "w-40", "w-36", "w-24"];

/** Rows shaped like the repositories that are on their way. */
export function RepoListSkeleton() {
  return (
    <div className="flex flex-col pt-4" aria-busy="true" aria-label="Loading your repositories">
      {WIDTHS.map((width) => (
        <div key={width} className="flex items-start gap-3 px-safe py-3">
          <Skeleton className="mt-0.5 size-6 rounded" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className={`h-4 ${width}`} />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rows shaped like the changed files that are on their way. */
export function FileListSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading the changed files">
      {WIDTHS.map((width) => (
        <div key={width} className="flex h-[3.25rem] items-center gap-3 px-safe">
          <Skeleton className="size-5 rounded" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={`h-3.5 ${width}`} />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

const DIFF_WIDTHS = ["w-3/5", "w-4/5", "w-2/5", "w-3/4", "w-1/2", "w-2/3", "w-4/5", "w-1/3"];

export function DiffSkeleton() {
  return (
    <div
      className="flex flex-col gap-2.5 px-safe py-4"
      aria-busy="true"
      aria-label="Loading the diff"
    >
      {DIFF_WIDTHS.map((width, index) => (
        // The widths repeat, so the position is the only thing that tells two bars apart.
        <Skeleton key={index} className={`h-3.5 ${width}`} />
      ))}
    </div>
  );
}
