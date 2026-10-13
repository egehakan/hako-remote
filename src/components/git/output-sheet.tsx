import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { explainFailure } from "@/lib/git/repos";
import { type Activity, useActivity, useRepo } from "@/lib/git/store";

type OutputSheetProps = {
  repoPath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** What git printed for the last command in a repository, with a line on what it means. */
export function OutputSheet({ repoPath, open, onOpenChange }: OutputSheetProps) {
  const repo = useRepo(repoPath);
  const live = useActivity(repoPath);
  // A finished command's line disappears from the row after a while; the sheet keeps what it shows.
  const [kept, setKept] = useState<Activity | null>(null);
  if (live !== null && live !== kept && live.state !== "running") setKept(live);
  const activity = live ?? kept;
  const [copied, setCopied] = useState(false);

  const failed = activity?.state === "failed";
  const explained =
    activity && failed ? explainFailure(activity.kind, activity.code, activity.output) : null;
  const output = activity?.output ?? "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard here; the text can still be selected.
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85%] max-w-lg gap-0 rounded-t-2xl border-x pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>{explained?.title ?? activity?.summary ?? "Git output"}</SheetTitle>
          <SheetDescription>
            {explained?.hint ?? (repo ? `In ${repo.name}.` : null)}{" "}
            {failed ? "Nothing is tried again by itself." : null}
          </SheetDescription>
        </SheetHeader>
        {output !== "" ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-y bg-well px-4 py-3">
            <p className="mb-1.5 text-[0.6875rem] text-faint">Git on your Mac said:</p>
            <pre
              className="font-mono text-[0.8125rem] leading-[1.35rem] [overflow-wrap:anywhere] whitespace-pre-wrap select-text"
              translate="no"
            >
              {output}
            </pre>
          </div>
        ) : (
          <p className="border-y px-4 py-4 text-sm text-muted-foreground">
            {failed ? "Git gave no output." : "Git printed nothing."}
          </p>
        )}
        <div className="flex gap-2 px-4 pt-4">
          {output !== "" ? (
            <Button variant="secondary" size="touch" onClick={() => void copy()}>
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
          <SheetClose render={<Button size="touch" className="flex-1" />}>Done</SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  );
}
