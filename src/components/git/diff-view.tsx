import type { GitDiffParams, GitDiffResult, GitFile } from "@shared/protocol";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileDigitIcon,
  FileTextIcon,
  ScaleIcon,
  Undo2Icon,
  UnplugIcon,
  WrapTextIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { LineCounts, StatusMark } from "@/components/git/file-status";
import { useGitUi } from "@/components/git/git-ui";
import { DiffSkeleton, GitProblem } from "@/components/git/states";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Toggle } from "@/components/ui/toggle";
import { relay } from "@/lib/connection";
import { formatSize } from "@/lib/files/format";
import { joinPath } from "@/lib/files/paths";
import { type DiffLine, type Hunk, parseDiff, type ParsedDiff } from "@/lib/git/diff";
import { STATE_LABELS } from "@/lib/git/repos";
import {
  type GitError,
  gitPrefs,
  toGitError,
  useActivity,
  useCommit,
  useEpoch,
  useGitPrefs,
  useRepo,
  useRepoStatus,
} from "@/lib/git/store";
import { useConnection, useWide } from "@/lib/hooks";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

type Loaded =
  | { state: "loading" }
  | { state: "ready"; result: GitDiffResult }
  | { state: "error"; error: GitError };

/** How many lines are drawn at first, and how many more each time the owner asks. */
const LINES_STEP = 2_000;

type DiffViewProps = {
  repoPath: string;
  filePath: string;
  /** The commit whose change to the file is shown; null for the working tree's. */
  commit?: string | null;
};

/** One changed file against the last commit, or what one commit changed in it. */
export default function DiffView({ repoPath, filePath, commit = null }: DiffViewProps) {
  const ui = useGitUi();
  const wide = useWide();
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  // The files the diff is one of: the working tree's, or the commit's.
  const working = useRepoStatus(commit === null ? repoPath : null);
  const committed = useCommit(commit === null ? null : repoPath, commit);
  const status = commit === null ? working : committed;
  const repo = useRepo(repoPath) ?? working.data?.repo ?? null;
  const epoch = useEpoch(repoPath);
  const activity = useActivity(repoPath);
  const prefs = useGitPrefs();
  const wrap = prefs.wrap ?? !wide;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  const files = status.data?.files ?? null;
  const index = files?.findIndex((candidate) => candidate.path === filePath) ?? -1;
  const file: GitFile | null = files && index !== -1 ? files[index] : null;
  // The old name is part of the question, so the changed files have to be known first.
  const statusKnown = status.data !== null || status.error !== null;
  const oldPath = file?.old_path ?? null;

  useEffect(() => {
    if (!online || !statusKnown) return;
    let cancelled = false;
    const params: GitDiffParams = { repo: repoPath, path: filePath, old_path: oldPath };
    if (commit !== null) params.commit = commit;
    relay.request<GitDiffResult>("git.diff", params).then(
      (result) => {
        if (!cancelled) setLoaded({ state: "ready", result });
      },
      (failure) => {
        // A diff already on screen is worth more than the news that it could not be read again.
        if (cancelled) return;
        setLoaded((before) =>
          before.state === "ready" ? before : { state: "error", error: toGitError(failure) },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [online, statusKnown, repoPath, filePath, oldPath, commit, epoch]);

  const cut = filePath.lastIndexOf("/");
  const name = filePath.slice(cut + 1);
  const directory = cut === -1 ? "" : filePath.slice(0, cut);
  const previous = files && index > 0 ? files[index - 1] : null;
  const next = files && index !== -1 && index < files.length - 1 ? files[index + 1] : null;
  const gone = commit === null && files !== null && file === null && !status.loading;
  const back = commit === null ? routes.repo(repoPath) : routes.commit(repoPath, commit);
  const linkTo = (path: string) =>
    commit === null ? routes.diff(repoPath, path) : routes.commitFile(repoPath, commit, path);
  const busy = activity?.state === "running";
  const text = loaded.state === "ready" && loaded.result.kind === "text" ? loaded.result : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-0.5 border-b pt-safe pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.125rem,env(safe-area-inset-left))] wide:pl-4">
        <Button
          variant="ghost"
          size="icon-touch"
          // A commit's file opens over the commit, on a wide screen too, so there it leads back.
          className={cn("size-11", commit === null && "wide:hidden")}
          aria-label={commit === null ? "Back to the changed files" : "Back to the commit"}
          nativeButton={false}
          render={<a href={back} />}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex min-h-12 min-w-0 flex-1 flex-col justify-center px-1.5 py-1">
          <h1 className="truncate font-mono text-[0.9375rem] leading-5 font-bold" translate="no">
            {name}
          </h1>
          <p
            className="truncate font-mono text-[0.6875rem] leading-4 text-muted-foreground"
            translate="no"
          >
            {directory === "" ? (repo?.name ?? "") : directory}
            {commit !== null ? ` at ${commit.slice(0, 7)}` : ""}
          </p>
        </div>
        <Toggle
          aria-label="Wrap long lines"
          pressed={wrap}
          onPressedChange={(pressed) => gitPrefs.set({ wrap: pressed })}
          className="size-11 rounded-xl"
        >
          <WrapTextIcon />
        </Toggle>
        {commit === null ? (
          <>
            <Button
              variant="ghost"
              size="icon-touch"
              className="size-11"
              aria-label="Open this file in Files"
              disabled={file?.status === "deleted" || gone}
              nativeButton={false}
              render={<a href={routes.file(joinPath(repoPath, filePath))} />}
            >
              <FileTextIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-touch"
              className="size-11 text-destructive hover:text-destructive"
              aria-label="Discard the changes to this file"
              disabled={!ui.canAct || busy || file === null || repo === null}
              onClick={() => {
                if (repo !== null && file !== null) ui.askDiscard(repo, file);
              }}
            >
              <Undo2Icon />
            </Button>
          </>
        ) : null}
      </header>

      {file ? (
        <div className="flex min-h-9 shrink-0 items-center gap-2.5 border-b py-1 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] text-[0.75rem] text-muted-foreground wide:pl-5">
          <StatusMark status={file.status} />
          <span className="min-w-0 flex-1 truncate">
            {STATE_LABELS[file.status]}
            {file.old_path ? (
              <span className="font-mono text-[0.6875rem]" translate="no">
                {" "}
                from {file.old_path}
              </span>
            ) : null}
          </span>
          <LineCounts additions={file.additions} deletions={file.deletions} binary={file.binary} />
        </div>
      ) : null}

      {loaded.state === "loading" ? (
        link === "open" && agent?.online === false ? (
          <Notice
            icon={UnplugIcon}
            title="Hako isn’t connected"
            detail="This diff loads by itself when Hako on your Mac is back."
          />
        ) : (
          <DiffSkeleton />
        )
      ) : loaded.state === "error" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GitProblem error={loaded.error} what="diff">
            <Button
              variant="secondary"
              size="touch"
              nativeButton={false}
              render={<a href={back} />}
            >
              {commit === null ? "Back to the changed files" : "Back to the commit"}
            </Button>
          </GitProblem>
        </div>
      ) : loaded.result.kind === "binary" ? (
        <Notice
          icon={FileDigitIcon}
          title="A binary file"
          detail={binaryDetail(name, loaded.result.old_size, loaded.result.new_size)}
        />
      ) : loaded.result.kind === "too_large" ? (
        <Notice
          icon={ScaleIcon}
          title="Too large to show here"
          detail={`The diff of ${name} is over ${formatSize(loaded.result.limit)}${
            file && file.additions !== null && file.deletions !== null
              ? `: ${file.additions.toLocaleString()} lines added and ${file.deletions.toLocaleString()} removed`
              : ""
          }. Look at it on your Mac.`}
        />
      ) : text !== null ? (
        <DiffText
          diff={text.diff}
          wrap={wrap}
          gone={gone}
          status={file?.status ?? null}
          inCommit={commit !== null}
        />
      ) : null}

      {files && files.length > 1 && index !== -1 ? (
        <nav
          aria-label="Changed files"
          className="flex shrink-0 items-center gap-1 border-t bg-background px-[max(0.25rem,env(safe-area-inset-left))] pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
        >
          <StepLink file={previous} href={linkTo} direction="previous" />
          <span className="shrink-0 px-1 font-mono text-[0.6875rem] text-faint tabular-nums">
            {index + 1} of {files.length}
          </span>
          <StepLink file={next} href={linkTo} direction="next" />
        </nav>
      ) : null}
    </div>
  );
}

function binaryDetail(name: string, before: number | null, after: number | null): string {
  const sizes =
    before !== null && after !== null
      ? `It was ${formatSize(before)} and is ${formatSize(after)} now.`
      : after !== null
        ? `It is new, and ${formatSize(after)}.`
        : before !== null
          ? `It was ${formatSize(before)}, and is deleted.`
          : "";
  return `${name} holds binary data, so there are no lines to compare. ${sizes}`.trim();
}

type StepLinkProps = {
  file: GitFile | null;
  /** The address of a file's diff, among the files this one is stepped through with. */
  href: (path: string) => string;
  direction: "previous" | "next";
};

function StepLink({ file, href, direction }: StepLinkProps) {
  const forward = direction === "next";
  const label = file?.path.slice(file.path.lastIndexOf("/") + 1) ?? "";
  const contents = (
    <>
      {forward ? null : <ChevronLeftIcon aria-hidden="true" className="size-4 shrink-0" />}
      <span className="min-w-0 truncate font-mono text-xs" translate="no">
        {label}
      </span>
      {forward ? <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
    </>
  );
  const layout = cn(
    "flex h-11 min-w-0 flex-1 items-center gap-1 rounded-lg px-2",
    forward && "justify-end",
  );
  if (file === null) return <span className={layout} />;
  return (
    <a
      href={href(file.path)}
      // Stepping through the files is one visit, not a trail of them to go back through.
      onClick={(event) => {
        // A click that asks for a new tab or window gets one.
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        window.location.replace(href(file.path));
      }}
      aria-label={`${forward ? "Next" : "Previous"} file: ${file.path}`}
      className={cn(
        layout,
        "text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
      )}
    >
      {contents}
    </a>
  );
}

type NoticeProps = {
  icon: React.ComponentType;
  title: string;
  detail: string;
  children?: React.ReactNode;
};

function Notice({ icon: Icon, title, detail, children }: NoticeProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Empty className="py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{detail}</EmptyDescription>
        </EmptyHeader>
        {children ? <EmptyContent>{children}</EmptyContent> : null}
      </Empty>
    </div>
  );
}

type DiffTextProps = {
  diff: string;
  wrap: boolean;
  /** True when the file is no longer among the changed ones. */
  gone: boolean;
  status: GitFile["status"] | null;
  /** True for what a commit changed, where there is no "now" to compare with. */
  inCommit: boolean;
};

function DiffText({ diff, wrap, gone, status, inCommit }: DiffTextProps) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const [limit, setLimit] = useState(LINES_STEP);
  const scroller = useRef<HTMLDivElement>(null);

  if (parsed.hunks.length === 0) {
    return (
      <Notice
        icon={FileTextIcon}
        title={
          !inCommit && (gone || status === null) ? "No changes in this file" : "No line changed"
        }
        detail={
          inCommit
            ? parsed.notes.length > 0
              ? `${parsed.notes.join(". ")}. The contents are the same.`
              : "This commit changed something other than the file’s lines, such as its mode, or did not touch it."
            : gone || status === null
              ? "It matches the last commit now: its changes were committed or discarded."
              : parsed.notes.length > 0
                ? `${parsed.notes.join(". ")}. The contents are the same.`
                : "The file differs from the last commit in something other than its lines, such as its mode."
        }
      />
    );
  }

  const digits = String(lastLineNumber(parsed)).length;
  const shown = visibleHunks(parsed.hunks, limit);
  const hidden = parsed.lineCount - shown.lines;

  return (
    <div
      ref={scroller}
      className={cn("diff-y min-h-0 flex-1 overscroll-contain", wrap && "diff-wrap")}
      style={{ "--diff-digits": digits } as React.CSSProperties}
      // Arrow keys and Page Down scroll a diff that has the focus.
      tabIndex={0}
      role="region"
      aria-label="Diff"
    >
      <div className="diff-x">
        <div className="diff-body" translate="no">
          {shown.hunks.map((hunk) => (
            <HunkBlock key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} />
          ))}
        </div>
      </div>
      {hidden > 0 ? (
        <div className="flex flex-col items-center gap-2 border-t px-safe py-5">
          <p className="text-[0.8125rem] text-muted-foreground">
            {hidden.toLocaleString()} more lines of this diff are not drawn yet.
          </p>
          <Button variant="secondary" size="touch" onClick={() => setLimit(limit + LINES_STEP)}>
            Show {Math.min(hidden, LINES_STEP).toLocaleString()} more lines
          </Button>
        </div>
      ) : (
        <p className="border-t px-safe py-3 text-center text-[0.6875rem] text-faint">
          End of the diff
        </p>
      )}
    </div>
  );
}

function lastLineNumber(parsed: ParsedDiff): number {
  let highest = 1;
  for (const hunk of parsed.hunks) {
    const last = hunk.lines.at(-1);
    highest = Math.max(
      highest,
      hunk.oldStart + hunk.lines.length,
      hunk.newStart + hunk.lines.length,
    );
    if (last) highest = Math.max(highest, last.oldNumber ?? 0, last.newNumber ?? 0);
  }
  return highest;
}

/** The hunks to draw within a budget of lines: whole ones, and at least the first. */
function visibleHunks(hunks: Hunk[], limit: number): { hunks: Hunk[]; lines: number } {
  const shown: Hunk[] = [];
  let lines = 0;
  for (const hunk of hunks) {
    if (shown.length > 0 && lines + hunk.lines.length > limit) break;
    shown.push(hunk);
    lines += hunk.lines.length;
  }
  return { hunks: shown, lines };
}

const HunkBlock = memo(function HunkBlock({ hunk }: { hunk: Hunk }) {
  return (
    <section>
      <div className="diff-hunk">
        <span className="diff-hunk-text">
          <span>{hunk.range}</span>
          {hunk.section !== "" ? <span className="diff-hunk-section"> {hunk.section}</span> : null}
        </span>
      </div>
      {hunk.lines.map((line, index) => (
        // A hunk's lines never change places, so their position names them.
        <Line key={index} line={line} />
      ))}
    </section>
  );
});

const SIGNS: Record<DiffLine["kind"], string> = { add: "+", del: "−", context: "", note: "" };
const SPOKEN: Record<DiffLine["kind"], string> = {
  add: "added",
  del: "removed",
  context: "",
  note: "",
};

function Line({ line }: { line: DiffLine }) {
  if (line.kind === "note") {
    return (
      <div className="diff-row" data-kind="note">
        <span className="diff-gutter">
          <span className="diff-no diff-no-old" />
          <span className="diff-no diff-no-new" />
          <span className="diff-sign" />
        </span>
        <span className="diff-code">{line.text}</span>
      </div>
    );
  }
  const { text, changed } = line;
  return (
    <div className="diff-row" data-kind={line.kind}>
      <span className="diff-gutter" aria-hidden="true">
        <span className="diff-no diff-no-old">{line.oldNumber}</span>
        <span className="diff-no diff-no-new">{line.newNumber}</span>
        <span className="diff-sign">{SIGNS[line.kind]}</span>
      </span>
      <span className="diff-code">
        {line.kind === "context" ? null : <span className="sr-only">{SPOKEN[line.kind]}: </span>}
        {changed && changed.to > changed.from ? (
          <>
            {text.slice(0, changed.from)}
            <mark>{text.slice(changed.from, changed.to)}</mark>
            {text.slice(changed.to)}
          </>
        ) : text === "" ? (
          "​"
        ) : (
          text
        )}
      </span>
    </div>
  );
}
