import type { GitFileState } from "@shared/protocol";
import { STATE_LABELS, STATE_LETTERS } from "@/lib/git/repos";
import { cn } from "@/lib/utils";

const COLOURS: Record<GitFileState, string> = {
  modified: "bg-amber/14 text-amber",
  added: "bg-settled/14 text-settled",
  untracked: "bg-settled/14 text-settled",
  deleted: "bg-destructive/14 text-destructive",
  renamed: "bg-lid/14 text-lid",
  conflicted: "bg-destructive text-background",
};

/** A file's status as one letter in its colour, with the word for those who cannot see either. */
export function StatusMark({ status, className }: { status: GitFileState; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded font-mono text-[0.6875rem] leading-none font-bold",
        COLOURS[status],
        className,
      )}
      title={STATE_LABELS[status]}
    >
      <span aria-hidden="true">{STATE_LETTERS[status]}</span>
      <span className="sr-only">{STATE_LABELS[status]}</span>
    </span>
  );
}

type LineCountsProps = {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  className?: string;
};

/** How many lines went in and out: `+12 −3`, with the signs, so it reads without the colours. */
export function LineCounts({ additions, deletions, binary, className }: LineCountsProps) {
  if (binary) {
    return <span className={cn("font-mono text-[0.6875rem] text-faint", className)}>binary</span>;
  }
  if (additions === null || deletions === null) return null;
  return (
    <span className={cn("flex gap-1.5 font-mono text-[0.6875rem] tabular-nums", className)}>
      {additions > 0 || deletions === 0 ? (
        <span className="text-settled" aria-label={`${additions} added`}>
          +{additions.toLocaleString()}
        </span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-destructive" aria-label={`${deletions} removed`}>
          −{deletions.toLocaleString()}
        </span>
      ) : null}
    </span>
  );
}
