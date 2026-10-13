import type { GitFile } from "@shared/protocol";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";
import { LineCounts, StatusMark } from "@/components/git/file-status";
import { cn } from "@/lib/utils";

type FileRowProps = {
  /** Where the file's diff opens. */
  href: string;
  file: GitFile;
  selected: boolean;
};

/** One changed file in a list: what happened to it, its name, and the lines that went in and out. */
export const FileRow = memo(function FileRow({ href, file, selected }: FileRowProps) {
  const cut = file.path.lastIndexOf("/");
  const name = file.path.slice(cut + 1);
  const directory = cut === -1 ? "" : file.path.slice(0, cut);
  const from =
    file.old_path === null
      ? null
      : file.old_path.slice(0, file.old_path.lastIndexOf("/") + 1) === file.path.slice(0, cut + 1)
        ? file.old_path.slice(file.old_path.lastIndexOf("/") + 1)
        : file.old_path;
  return (
    // A repository can have two thousand changed files; the ones off screen are not laid out.
    <li className="[contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]">
      <a
        href={href}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex min-h-[3.25rem] scroll-mt-11 items-center gap-3 px-safe py-1.5 outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
          selected && "bg-accent",
        )}
      >
        <StatusMark status={file.status} />
        <span className="flex min-w-0 flex-1 flex-col" translate="no">
          <span
            className={cn(
              "truncate font-mono text-sm leading-5",
              file.status === "deleted" && "text-muted-foreground line-through decoration-faint",
              selected && "text-lid",
            )}
          >
            {name}
          </span>
          {directory !== "" || from !== null ? (
            <span className="truncate font-mono text-[0.6875rem] leading-4 text-faint">
              {from !== null ? `was ${from}` : directory}
              {from !== null && directory !== "" ? ` · ${directory}` : ""}
            </span>
          ) : null}
        </span>
        <LineCounts
          additions={file.additions}
          deletions={file.deletions}
          binary={file.binary}
          className="shrink-0"
        />
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-faint" />
      </a>
    </li>
  );
});
