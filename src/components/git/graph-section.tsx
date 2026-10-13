import type { GitCommit, GitRepo } from "@shared/protocol";
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon } from "lucide-react";
import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useGitUi } from "@/components/git/git-ui";
import { GRAPH_ROW_HEIGHT, GraphLines } from "@/components/git/graph-lines";
import { RefChips } from "@/components/git/ref-chips";
import { SectionHeader } from "@/components/git/section-header";
import { GitProblem } from "@/components/git/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { timeAgo } from "@/lib/git/branches";
import type { GraphRow } from "@/lib/git/graph";
import { type History, useHistory } from "@/lib/git/history";
import { isUnpublished, plural } from "@/lib/git/repos";
import { gitPrefs, useActivity, useGitPrefs, useHistorySupport } from "@/lib/git/store";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

type GraphSectionProps = {
  repo: GitRepo;
  /** The element that scrolls the screen the graph is on. */
  scroller: RefObject<HTMLElement | null>;
  /** The commit that is open beside the graph, which its row marks. */
  selectedCommit: string | null;
};

/**
 * A repository's history as a graph: the current branch's line, its upstream's beside it where the
 * two differ, and what was merged in. It folds away, and loads older commits as they are reached.
 */
export function GraphSection({ repo, scroller, selectedCommit }: GraphSectionProps) {
  const { graphOpen: open } = useGitPrefs();
  const support = useHistorySupport();
  const { history, error, loading, loadingMore, reload, loadMore } = useHistory(
    repo.path,
    open && support !== "no",
  );

  return (
    <section aria-label="Graph">
      <SectionHeader
        open={open}
        onToggle={() => gitPrefs.set({ graphOpen: !open })}
        label="Graph"
        aside={open && loading && history !== null ? <Spinner className="size-3.5" /> : null}
      />
      {!open ? null : support === "no" || error?.code === "not_supported" ? (
        <p className="px-safe pt-1 pb-5 text-[0.8125rem] leading-5 text-muted-foreground">
          The graph and switching branches need a newer Hako. {NEEDS_NEWER_HAKO}
        </p>
      ) : history === null ? (
        error ? (
          <GitProblem error={error} what="graph">
            <Button variant="secondary" size="touch" onClick={reload}>
              Try again
            </Button>
          </GitProblem>
        ) : (
          <GraphSkeleton />
        )
      ) : history.commits.length === 0 ? (
        <p className="px-safe pt-1 pb-5 text-[0.8125rem] leading-5 text-muted-foreground">
          No commits yet. The first commit in {repo.name} starts its graph.
        </p>
      ) : (
        <>
          {error ? (
            <Alert className="mx-auto mb-2 w-[calc(100%-2rem)]">
              <CircleAlertIcon />
              <AlertDescription>
                Couldn’t refresh from your Mac. This is the graph as it was last read.
              </AlertDescription>
            </Alert>
          ) : null}
          <SyncLine repo={repo} />
          <CommitList
            repoPath={repo.path}
            history={history}
            scroller={scroller}
            selectedCommit={selectedCommit}
            loadingMore={loadingMore}
            stalled={error !== null}
            loadMore={loadMore}
          />
        </>
      )}
    </section>
  );
}

/** What there is to push and to pull, in a line, with the buttons that do it. */
function SyncLine({ repo }: { repo: GitRepo }) {
  const ui = useGitUi();
  const activity = useActivity(repo.path);
  const running = activity?.state === "running" ? activity.kind : null;
  const blocked = !ui.canAct || running !== null;
  const base = "flex min-h-11 items-center gap-2 border-t px-safe py-2 text-[0.8125rem] leading-5";

  if (repo.upstream === null) {
    return (
      <p className={cn(base, "text-muted-foreground")}>
        {repo.branch === null
          ? "HEAD is detached, so there is nothing to push or pull."
          : isUnpublished(repo)
            ? "Not on a remote yet: these commits are only on your Mac."
            : null}
      </p>
    );
  }
  if (repo.ahead === 0 && repo.behind === 0) {
    return (
      <p className={cn(base, "text-muted-foreground")}>
        <span className="min-w-0 truncate">
          Level with{" "}
          <span className="font-mono text-xs" translate="no">
            {repo.upstream}
          </span>
        </span>
      </p>
    );
  }
  return (
    <div className={base}>
      <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">
        {repo.ahead > 0 ? (
          <span className="flex items-center gap-1 text-amber">
            <ArrowUpIcon aria-hidden="true" className="size-3.5" />
            {repo.ahead.toLocaleString()} to push
          </span>
        ) : null}
        {repo.behind > 0 ? (
          <span className="flex items-center gap-1 text-remote">
            <ArrowDownIcon aria-hidden="true" className="size-3.5" />
            {repo.behind.toLocaleString()} to pull
          </span>
        ) : null}
      </p>
      {repo.behind > 0 ? (
        <Button
          variant="secondary"
          size="lg"
          className="px-3"
          disabled={blocked}
          aria-label={`Pull ${plural(repo.behind, "commit")}`}
          onClick={() => ui.pull(repo)}
        >
          {running === "pull" ? <Spinner data-icon="inline-start" /> : null}
          Pull
        </Button>
      ) : null}
      {repo.ahead > 0 ? (
        <Button
          variant="secondary"
          size="lg"
          className="px-3"
          disabled={blocked}
          aria-label={`Push ${plural(repo.ahead, "commit")}`}
          onClick={() => ui.push(repo)}
        >
          {running === "push" ? <Spinner data-icon="inline-start" /> : null}
          Push
        </Button>
      ) : null}
    </div>
  );
}

const OVERSCAN = 8;

type CommitListProps = {
  repoPath: string;
  history: History;
  scroller: RefObject<HTMLElement | null>;
  selectedCommit: string | null;
  loadingMore: boolean;
  /** True after a read failed: older commits then wait to be asked for. */
  stalled: boolean;
  loadMore: () => void;
};

/**
 * The commits, of which only those on screen are built: the list scrolls with the screen it is on,
 * so which ones those are is worked out from where the list sits in that screen.
 */
function CommitList({
  repoPath,
  history,
  scroller,
  selectedCommit,
  loadingMore,
  stalled,
  loadMore,
}: CommitListProps) {
  const list = useRef<HTMLUListElement>(null);
  const [range, setRange] = useState({ start: 0, end: 24 });
  const count = history.commits.length;

  const measure = useCallback(() => {
    const view = scroller.current;
    const element = list.current;
    if (!view || !element) return;
    const above = view.getBoundingClientRect().top - element.getBoundingClientRect().top;
    const start = Math.max(0, Math.floor(above / GRAPH_ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      count,
      Math.ceil((above + view.clientHeight) / GRAPH_ROW_HEIGHT) + OVERSCAN,
    );
    setRange((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    );
  }, [scroller, count]);

  useLayoutEffect(() => {
    const view = scroller.current;
    if (!view) return;
    measure();
    view.addEventListener("scroll", measure, { passive: true });
    // What is above the list can fold away or grow, which moves the list without a scroll.
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    if (view.firstElementChild) observer.observe(view.firstElementChild);
    return () => {
      view.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [scroller, measure]);

  const nearEnd = range.end >= count - OVERSCAN;
  useEffect(() => {
    if (nearEnd && history.hasMore && !loadingMore && !stalled) loadMore();
  }, [nearEnd, history.hasMore, loadingMore, stalled, loadMore, count]);

  const now = Date.now();
  const rows: React.ReactNode[] = [];
  for (let index = range.start; index < Math.min(range.end, count); index++) {
    const commit = history.commits[index];
    rows.push(
      <li
        key={commit.id}
        className="absolute inset-x-0"
        style={{ top: index * GRAPH_ROW_HEIGHT, height: GRAPH_ROW_HEIGHT }}
      >
        <CommitRow
          repoPath={repoPath}
          commit={commit}
          row={history.rows[index]}
          head={commit.id === history.head}
          selected={commit.id === selectedCommit}
          now={now}
        />
      </li>,
    );
  }

  return (
    <>
      <ul
        ref={list}
        aria-label="Commits, newest first"
        className="relative border-t"
        style={{ height: count * GRAPH_ROW_HEIGHT }}
      >
        {rows}
      </ul>
      <p
        role="status"
        className="flex min-h-11 items-center justify-center gap-2 border-t px-safe text-[0.6875rem] text-faint"
      >
        {history.hasMore && stalled && !loadingMore ? (
          <Button variant="ghost" size="lg" className="text-foreground" onClick={loadMore}>
            Load older commits
          </Button>
        ) : history.hasMore ? (
          <>
            <Spinner className="size-3.5" aria-hidden="true" />
            Loading older commits…
          </>
        ) : (
          `${plural(count, "commit")}, back to the first`
        )}
      </p>
    </>
  );
}

type CommitRowProps = {
  repoPath: string;
  commit: GitCommit;
  row: GraphRow;
  head: boolean;
  selected: boolean;
  /** When the list was drawn, which the ages of its commits are counted from. */
  now: number;
};

const CommitRow = memo(
  function CommitRow({ repoPath, commit, row, head, selected, now }: CommitRowProps) {
    return (
      <a
        href={routes.commit(repoPath, commit.id)}
        aria-current={selected ? "page" : undefined}
        className={cn(
          // The margin keeps a row that the keyboard reaches clear of the section's sticky header.
          "flex h-full scroll-mt-11 items-stretch pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.625rem,env(safe-area-inset-left))] outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
          selected && "bg-accent",
        )}
      >
        <GraphLines row={row} side={commit.side} merge={commit.parents.length > 1} head={head} />
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 pl-2">
          <span
            className={cn(
              "truncate text-[0.9375rem] leading-5",
              commit.side === "remote" && "text-muted-foreground",
              selected && "text-lid",
            )}
          >
            {commit.subject || "(no message)"}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-[0.6875rem] leading-[1.125rem] text-faint">
            <RefChips refs={commit.refs} limit={2} className="shrink" />
            {/* The author gives way before a branch's name does. */}
            {commit.refs.length < 2 ? (
              <span className="min-w-0 shrink-[1000] truncate">{commit.author}</span>
            ) : null}
            <time dateTime={new Date(commit.time).toISOString()} className="shrink-0">
              {timeAgo(commit.time, now)}
            </time>
          </span>
        </span>
        {commit.side === "local" ? (
          <span className="flex w-6 shrink-0 items-center justify-end text-amber">
            <ArrowUpIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Not pushed yet</span>
          </span>
        ) : commit.side === "remote" ? (
          <span className="flex w-6 shrink-0 items-center justify-end text-remote">
            <ArrowDownIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Not pulled yet</span>
          </span>
        ) : null}
      </a>
    );
  },
  // The age of a commit is not worth drawing a row again for.
  (before, after) =>
    before.commit === after.commit &&
    before.row === after.row &&
    before.head === after.head &&
    before.selected === after.selected &&
    before.repoPath === after.repoPath,
);

const WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-1/2"];

/** Rows shaped like the commits that are on their way. */
function GraphSkeleton() {
  return (
    <div className="flex flex-col border-t" aria-busy="true" aria-label="Loading the graph">
      {WIDTHS.map((width, index) => (
        // The widths repeat, so the position is the only thing that tells two rows apart.
        <div
          key={index}
          className="flex items-center gap-3 px-safe"
          style={{ height: GRAPH_ROW_HEIGHT }}
        >
          <Skeleton className="size-2.5 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={`h-3.5 ${width}`} />
            <Skeleton className="h-2.5 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}
