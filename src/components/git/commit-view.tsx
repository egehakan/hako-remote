import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  CopyIcon,
  UnplugIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { FileRow } from "@/components/git/file-row";
import { LineCounts } from "@/components/git/file-status";
import { RefChips } from "@/components/git/ref-chips";
import { GitProblem } from "@/components/git/states";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { formatModifiedFull } from "@/lib/files/format";
import { timeAgo } from "@/lib/git/branches";
import { plural } from "@/lib/git/repos";
import { useCommit, useRepo } from "@/lib/git/store";
import { useConnection } from "@/lib/hooks";
import { routes } from "@/lib/route";

type CommitViewProps = {
  repoPath: string;
  /** The commit's hash, as the graph or a link named it. */
  commitId: string;
};

/** One commit: what it says, who made it and when, and the files it changed. */
export function CommitView({ repoPath, commitId }: CommitViewProps) {
  const { link, agent } = useConnection();
  const offline = link === "open" && agent?.online === false;
  const repo = useRepo(repoPath);
  const { data, error, reload } = useCommit(repoPath, commitId);
  const commit = data?.commit ?? null;
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
  const short = (commit?.id ?? commitId).slice(0, 7);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-0.5 border-b pt-safe pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.125rem,env(safe-area-inset-left))] wide:pl-4">
        <Button
          variant="ghost"
          size="icon-touch"
          className="size-11 wide:hidden"
          aria-label="Back to the graph"
          nativeButton={false}
          render={<a href={routes.repo(repoPath)} />}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex min-h-[3.25rem] min-w-0 flex-1 flex-col justify-center px-1.5 py-1.5">
          <h1 className="truncate text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
            Commit{" "}
            <span className="font-mono text-[0.9375rem] font-bold" translate="no">
              {short}
            </span>
          </h1>
          <p
            className="truncate font-mono text-[0.6875rem] leading-4 text-muted-foreground"
            translate="no"
          >
            {repo?.name ?? ""}
          </p>
        </div>
        <CopyHash id={commit?.id ?? null} />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {data && commit && files ? (
          <>
            <div className="flex flex-col gap-3 px-safe pt-4 pb-4">
              <h2 className="text-[1.0625rem] leading-6 font-semibold [overflow-wrap:anywhere] select-text">
                {commit.subject || "(no message)"}
              </h2>
              {data.body !== "" ? (
                <p className="text-[0.9375rem] leading-6 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground/90 select-text">
                  {data.body}
                </p>
              ) : null}
              <RefChips refs={commit.refs} className="flex-wrap" />
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8125rem] leading-5">
                <dt className="text-muted-foreground">Author</dt>
                <dd className="truncate">{commit.author}</dd>
                <dt className="text-muted-foreground">Date</dt>
                <dd>
                  <time dateTime={new Date(commit.time).toISOString()}>
                    {formatModifiedFull(commit.time)}
                  </time>
                  <span className="text-muted-foreground">, {timeAgo(commit.time)}</span>
                </dd>
                {commit.parents.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">
                      {commit.parents.length === 1 ? "Parent" : "Parents"}
                    </dt>
                    <dd className="flex flex-wrap gap-x-3" translate="no">
                      {commit.parents.map((parent) => (
                        <a
                          key={parent}
                          href={routes.commit(repoPath, parent)}
                          className="rounded font-mono text-xs leading-5 text-lid underline decoration-lid/40 underline-offset-2 outline-none hover:decoration-lid focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          {parent.slice(0, 7)}
                        </a>
                      ))}
                    </dd>
                  </>
                ) : null}
              </dl>
              {commit.side === "local" ? (
                <p className="flex items-center gap-1.5 text-[0.8125rem] leading-5 text-amber">
                  <ArrowUpIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  Only on your Mac: not pushed yet.
                </p>
              ) : commit.side === "remote" ? (
                <p className="flex items-center gap-1.5 text-[0.8125rem] leading-5 text-remote">
                  <ArrowDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  Only on the remote: not pulled yet.
                </p>
              ) : null}
            </div>

            <p className="flex items-center gap-3 px-safe pt-2 pb-1.5 text-[0.8125rem] text-muted-foreground">
              <span className="flex-1">
                {files.length === 0
                  ? "No file changed"
                  : `${plural(files.length, "changed file")}${data.truncated ? ", and more that are not listed" : ""}`}
                {commit.parents.length > 1 ? ", against its first parent" : ""}
              </span>
              {files.length > 0 ? (
                <LineCounts
                  additions={totals.additions}
                  deletions={totals.deletions}
                  binary={false}
                />
              ) : null}
            </p>
            {files.length > 0 ? (
              <ul className="divide-y border-y">
                {files.map((file) => (
                  <FileRow
                    key={file.path}
                    href={routes.commitFile(repoPath, commit.id, file.path)}
                    file={file}
                    selected={false}
                  />
                ))}
              </ul>
            ) : null}
            <div className="pb-[max(1rem,env(safe-area-inset-bottom))]" />
          </>
        ) : offline ? (
          <Empty className="py-14">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UnplugIcon />
              </EmptyMedia>
              <EmptyTitle>Hako isn’t connected</EmptyTitle>
              <EmptyDescription>
                This commit loads by itself when Hako on your Mac is back.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : error ? (
          <GitProblem error={error} what="commit">
            {error.code === "not_supported" || error.code === "not_found" ? null : (
              <Button variant="secondary" size="touch" onClick={reload}>
                Try again
              </Button>
            )}
            <Button
              variant="ghost"
              size="touch"
              nativeButton={false}
              render={<a href={routes.repo(repoPath)} />}
            >
              Back to the graph
            </Button>
          </GitProblem>
        ) : (
          <CommitSkeleton />
        )}
      </main>
    </div>
  );
}

/** Copies the whole hash, which is what git and a search on a forge take. */
function CopyHash({ id }: { id: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (id === null) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard here; the hash is on the page and can be selected.
    }
  };
  return (
    <Button
      variant="ghost"
      size="touch"
      className="h-11 shrink-0 px-3 text-[0.8125rem]"
      disabled={id === null}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      <span aria-live="polite">{copied ? "Copied" : "Copy hash"}</span>
    </Button>
  );
}

function CommitSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 px-safe py-5"
      aria-busy="true"
      aria-label="Loading the commit"
    >
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="mt-4 h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
