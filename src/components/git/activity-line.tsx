import type { GitRepo } from "@shared/protocol";
import { CheckIcon, CircleAlertIcon, XIcon } from "lucide-react";
import { useGitUi } from "@/components/git/git-ui";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { dismissActivity, useActivity } from "@/lib/git/store";
import { cn } from "@/lib/utils";

/** What is being done to a repository right now, or how the last thing done to it ended. */
export function ActivityLine({ repo, className }: { repo: GitRepo; className?: string }) {
  const ui = useGitUi();
  const activity = useActivity(repo.path);
  if (activity === null) return null;
  const failed = activity.state === "failed";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-9 items-center gap-2 text-[0.8125rem] leading-5",
        failed
          ? "text-destructive"
          : activity.state === "done"
            ? "text-settled"
            : "text-muted-foreground",
        className,
      )}
    >
      {activity.state === "running" ? (
        <Spinner className="size-3.5 shrink-0" aria-hidden="true" />
      ) : failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{activity.summary}</span>
      {activity.state !== "running" && (failed || activity.output !== "") ? (
        <Button
          variant="ghost"
          className="h-9 px-2 text-[0.8125rem] text-foreground"
          onClick={() => ui.showOutput(repo)}
        >
          {failed ? "What git said" : "Output"}
        </Button>
      ) : null}
      {failed ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-9 text-muted-foreground"
          aria-label="Dismiss"
          onClick={() => dismissActivity(repo.path)}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
