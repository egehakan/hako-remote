import type { GitRef } from "@shared/protocol";
import { TagIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ORDER: Record<GitRef["kind"], number> = { head: 0, local: 1, remote: 2, tag: 3 };

const STYLES: Record<GitRef["kind"], string> = {
  head: "bg-amber text-primary-foreground font-bold",
  local: "bg-amber/14 text-amber",
  remote: "bg-remote/14 text-remote",
  tag: "bg-muted text-muted-foreground",
};

const SPOKEN: Record<GitRef["kind"], string> = {
  head: "current branch",
  local: "branch",
  remote: "remote branch",
  tag: "tag",
};

/** The refs in the order a row shows them: where HEAD is, then branches, remote ones, tags. */
export function orderRefs(refs: readonly GitRef[]): GitRef[] {
  return refs.toSorted(
    (a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

type RefChipsProps = {
  refs: readonly GitRef[];
  /** How many are shown before the rest are counted; all of them when left out. */
  limit?: number;
  className?: string;
};

/** The branches and tags that point at a commit, each in the colour of its kind. */
export function RefChips({ refs, limit, className }: RefChipsProps) {
  if (refs.length === 0) return null;
  const ordered = orderRefs(refs);
  const shown = limit === undefined ? ordered : ordered.slice(0, limit);
  const rest = ordered.length - shown.length;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)} translate="no">
      {shown.map((ref) => (
        <span
          key={`${ref.kind}:${ref.name}`}
          className={cn(
            "flex h-[1.125rem] min-w-0 items-center gap-1 rounded px-1.5 font-mono text-[0.6875rem] leading-none",
            limit === undefined ? "max-w-full" : "max-w-[9.5rem] shrink",
            STYLES[ref.kind],
          )}
        >
          {ref.kind === "tag" ? <TagIcon aria-hidden="true" className="size-2.5 shrink-0" /> : null}
          <span className="sr-only">{SPOKEN[ref.kind]} </span>
          <span className="truncate">{ref.name}</span>
        </span>
      ))}
      {rest > 0 ? (
        <span className="shrink-0 font-mono text-[0.6875rem] text-faint">+{rest}</span>
      ) : null}
    </span>
  );
}
