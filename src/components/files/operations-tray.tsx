import { CheckIcon, CircleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { dismissOperation, type Operation } from "@/lib/files/operations";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

/** How long an operation that needs nothing more from the owner stays on the list. */
const SETTLED_FOR_MS = 5_000;

/** Rows for the copies, moves, zips and unzips on their way, and what each came to. */
export function OperationRows({ items }: { items: readonly Operation[] }) {
  return items.map((item) => <OperationRow key={item.id} item={item} />);
}

function useElapsed(since: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

function OperationRow({ item }: { item: Operation }) {
  const running = item.state === "running";
  const elapsed = useElapsed(item.startedAt, running);
  // What a zip left out, and where an unpacked folder is, stay until the owner has seen them.
  const settled = item.state === "done" && item.openPath === null && item.kind !== "archive";
  useEffect(() => {
    if (!settled) return;
    const timer = window.setTimeout(() => dismissOperation(item.id), SETTLED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [settled, item.id]);

  return (
    <li className="relative flex flex-col gap-1.5 py-2 pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
      <div className="flex min-h-10 items-center gap-3">
        {running ? (
          <Spinner className="size-5 shrink-0 text-lid" />
        ) : item.state === "done" ? (
          <CheckIcon aria-hidden="true" className="size-5 shrink-0 text-settled" />
        ) : (
          <CircleAlertIcon aria-hidden="true" className="size-5 shrink-0 text-destructive" />
        )}
        <div className="flex min-w-0 flex-1 flex-col" role="status">
          <span className="text-sm leading-5 [overflow-wrap:anywhere]">
            {running ? item.title : item.summary}
          </span>
          {running ? (
            <span className="text-[0.75rem] leading-4 text-muted-foreground tabular-nums">
              {elapsed < 3
                ? "On your Mac…"
                : `On your Mac for ${elapsed} s. It may take a while for many or large files.`}
            </span>
          ) : null}
        </div>
        {running ? null : (
          <Button
            variant="ghost"
            size="icon-touch"
            className="size-11 text-muted-foreground"
            aria-label="Remove from the list"
            onClick={() => dismissOperation(item.id)}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {item.failures.length > 0 ? (
        <ul className="ml-8 mr-2.5 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md bg-muted px-3 py-2 text-xs leading-5">
          {item.failures.map((failure, index) => (
            <li key={`${failure.name}\n${index}`} className="[overflow-wrap:anywhere]">
              <span className="font-mono text-foreground" translate="no">
                {failure.name}
              </span>
              <span className="text-muted-foreground">: {failure.message || "failed"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {item.openPath && item.state === "done" ? (
        <div className="flex gap-2 pb-1 pl-8">
          <Button
            variant="secondary"
            className="h-10 px-3.5"
            nativeButton={false}
            render={<a href={routes.dir(item.openPath)} />}
            onClick={() => dismissOperation(item.id)}
          >
            Open the folder
          </Button>
        </div>
      ) : null}
      {running ? (
        <div
          role="progressbar"
          aria-label={item.title}
          className={cn("absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-input/60")}
        >
          <div className="h-full w-1/3 animate-op-slide bg-amber motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-60" />
        </div>
      ) : null}
    </li>
  );
}
