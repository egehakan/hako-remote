import { ArrowUpCircleIcon, FileQuestionMarkIcon, LockKeyholeIcon, UnplugIcon } from "lucide-react";
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
import type { FsError } from "@/lib/files/store";

type FsProblemProps = {
  error: FsError;
  /** What could not be read, as it reads in a sentence. */
  what: "folder" | "file" | "directory";
  /** Buttons that lead somewhere useful from here. */
  children?: ReactNode;
};

/** Says why the Mac did not hand over a folder or a file, in the Mac's own words where it gave any. */
export function FsProblem({ error, what, children }: FsProblemProps) {
  let Icon = FileQuestionMarkIcon;
  let title = `Couldn’t read this ${what}`;
  let detail: ReactNode = "Your Mac reported a problem. Try again.";
  let quote: string | null = error.message || null;

  switch (error.code) {
    case "not_supported":
      Icon = ArrowUpCircleIcon;
      title = "Files need a newer Hako";
      detail =
        "Update Hako on your Mac to use this. The version running there can’t share files with this app yet.";
      quote = null;
      break;
    case "not_found":
      title = `This ${what} isn’t there any more`;
      detail = "It was moved, renamed or deleted on your Mac.";
      quote = null;
      break;
    case "permission_denied":
      Icon = LockKeyholeIcon;
      title = `Your Mac won’t open this ${what}`;
      detail = "Hako isn’t allowed to read it. This is what your Mac said:";
      break;
    case "agent_offline":
    case "disconnected":
      Icon = UnplugIcon;
      title = "Your Mac went offline";
      detail = `The ${what} loads by itself when Hako on the Mac is back.`;
      quote = null;
      break;
    case "timeout":
      title = "Your Mac didn’t answer";
      detail = "It may be busy, or asleep. Try again.";
      quote = null;
      break;
    case "bad_request":
    case "failed":
    case "not_a_directory":
    case "is_a_directory":
    case "conflict":
    case "too_large":
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
          <p className="mt-1 max-w-full rounded-md bg-muted px-3 py-2 text-left font-mono text-xs leading-5 [overflow-wrap:anywhere] text-foreground">
            {quote}
          </p>
        ) : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

const WIDTHS = ["w-40", "w-28", "w-52", "w-36", "w-44", "w-24", "w-48", "w-32"];

/** Rows shaped like the list that is on its way. */
export function ListSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label={label}>
      {WIDTHS.map((width) => (
        <div key={width} className="flex h-12 items-center gap-3 px-safe">
          <Skeleton className="size-5 rounded" />
          <Skeleton className={`h-3.5 ${width}`} />
          <Skeleton className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}
