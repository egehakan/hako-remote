import type { Preview } from "@shared/previews";
import {
  AppWindowIcon,
  CircleAlertIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";
import { MacOffline } from "@/components/mac-offline";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RpcFailure } from "@/lib/connection";
import { describeFailure, NEEDS_NEWER_HAKO } from "@/lib/errors";
import { useConnection } from "@/lib/hooks";
import {
  loadPreviews,
  removePreview,
  restartPreview,
  stopPreview,
  usePreviews,
} from "@/lib/previews/store";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

export const STATUS_LABELS: Record<Preview["status"], string> = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
};

/** A dot in the colour of a preview's state: lit while it runs, pulsing while it starts. */
export function StatusDot({ status }: { status: Preview["status"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "running" &&
          "bg-settled shadow-[0_0_0_3px_color-mix(in_oklab,var(--settled)_20%,transparent)]",
        status === "starting" && "bg-amber motion-safe:animate-pulse",
        status === "stopped" && "bg-faint",
        status === "failed" && "bg-destructive",
      )}
    />
  );
}

/** "just now", "4 min ago", "2 h ago", or the date. */
function startedAgo(started: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(started).toLocaleDateString();
}

/** The end of a path, which tells directories apart better than their shared start. */
function shortDirectory(directory: string): string {
  const parts = directory.split("/").filter(Boolean);
  return parts.length <= 2 ? directory : `…/${parts.slice(-2).join("/")}`;
}

export function portsLabel(preview: Preview): string {
  const ports = preview.ports?.length ? preview.ports : [{ port: preview.port, label: "web" }];
  return ports.map((item) => `${item.label} ${item.port}`).join(", ");
}

/** The previews the Mac runs, newest first, each with what can be done to it. */
export function PreviewList({ selected }: { selected: string | null }) {
  const { link, agent } = useConnection();
  const offline = link === "open" && agent?.online === false;
  const { previews, support, error, loading } = usePreviews();
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const now = Date.now();

  const act = async (id: string, action: (id: string) => Promise<void>) => {
    setNotice(null);
    setBusy(id);
    try {
      await action(id);
    } catch (failure) {
      setNotice(
        failure instanceof RpcFailure && failure.code === "not_found"
          ? "That preview is no longer on your Mac."
          : describeFailure(failure),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header className="shrink-0 border-b pt-safe">
        <div className="flex items-center gap-0.5 pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
          <h1 className="min-w-0 flex-1 truncate py-3.5 text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
            Previews
          </h1>
          <Button
            variant="ghost"
            size="icon-touch"
            className="size-11"
            aria-label="Refresh"
            disabled={loading || offline || support === "no"}
            onClick={() => void loadPreviews()}
          >
            <RefreshCwIcon className={cn(loading && "motion-safe:animate-spin")} />
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {notice || (error && previews) ? (
          <Alert variant="destructive" className="mx-auto mt-3 w-[calc(100%-2rem)]">
            <CircleAlertIcon />
            <AlertDescription>
              {notice ?? "Couldn’t refresh the previews from your Mac."}
            </AlertDescription>
            {notice ? (
              <AlertAction>
                <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
                  Dismiss
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}
        {offline ? (
          <MacOffline />
        ) : support === "no" ? (
          <Empty className="py-14">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AppWindowIcon />
              </EmptyMedia>
              <EmptyTitle>Previews need a newer Hako</EmptyTitle>
              <EmptyDescription>
                The Hako on your Mac can’t run previews yet. {NEEDS_NEWER_HAKO}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : previews === null ? (
          error ? (
            <Empty className="py-14">
              <EmptyHeader>
                <EmptyTitle>Couldn’t read the previews</EmptyTitle>
                <EmptyDescription>{error}</EmptyDescription>
              </EmptyHeader>
              <Button variant="secondary" size="touch" onClick={() => void loadPreviews()}>
                Try again
              </Button>
            </Empty>
          ) : (
            <div className="flex flex-col gap-px pt-3" aria-busy="true" aria-label="Loading…">
              <Skeleton className="mx-4 h-24 rounded-lg" />
              <Skeleton className="mx-4 mt-2 h-24 rounded-lg" />
            </div>
          )
        ) : previews.length === 0 ? (
          <Empty className="py-14">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AppWindowIcon />
              </EmptyMedia>
              <EmptyTitle>No previews running</EmptyTitle>
              <EmptyDescription>
                Ask Claude Code on your Mac to preview the app it changed. It starts the dev server
                in a tab of Hako, and the app shows up here to open on this phone.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y border-b">
            {previews.map((preview) => (
              <PreviewRow
                key={preview.id}
                preview={preview}
                now={now}
                selected={preview.id === selected}
                busy={busy === preview.id}
                onStop={() => void act(preview.id, stopPreview)}
                onRestart={() => void act(preview.id, restartPreview)}
                onRemove={() => setRemoving(preview)}
              />
            ))}
          </ul>
        )}
      </main>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its dev server stops, its tab on your Mac closes, and it leaves this list. Claude Code
              can start it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} size="touch">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="touch"
              onClick={() => {
                if (removing) void act(removing.id, removePreview);
                setRemoving(null);
              }}
            >
              Remove preview
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type RowProps = {
  preview: Preview;
  now: number;
  selected: boolean;
  busy: boolean;
  onStop: () => void;
  onRestart: () => void;
  onRemove: () => void;
};

function PreviewRow({ preview, now, selected, busy, onStop, onRestart, onRemove }: RowProps) {
  const live = preview.status === "running" || preview.status === "starting";
  return (
    <li className={cn("relative", selected && "bg-secondary")}>
      {selected ? (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-lid" />
      ) : null}
      <a
        href={routes.preview(preview.id)}
        aria-current={selected ? "page" : undefined}
        className="flex flex-col gap-1 px-safe pt-3.5 pb-2 outline-none hover:bg-accent/40 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <span className="flex items-center gap-2">
          <StatusDot status={preview.status} />
          <span className="min-w-0 flex-1 truncate text-[0.9375rem] leading-5 font-medium">
            {preview.name}
          </span>
          <span className="shrink-0 text-[0.75rem] leading-5 text-muted-foreground">
            {STATUS_LABELS[preview.status]}
          </span>
        </span>
        <span
          className="truncate pl-4 font-mono text-[0.75rem] leading-5 text-muted-foreground"
          title={preview.directory}
        >
          {shortDirectory(preview.directory)}
        </span>
        <span className="truncate pl-4 text-[0.75rem] leading-5 text-faint">
          <span className="font-mono">{portsLabel(preview)}</span>, started{" "}
          {startedAgo(preview.started, now)}
        </span>
        {preview.message && (preview.status === "failed" || preview.status === "stopped") ? (
          <span
            className={cn(
              "pl-4 text-[0.8125rem] leading-5",
              preview.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {preview.message}
          </span>
        ) : null}
      </a>
      <div className="flex flex-wrap items-center gap-1 px-safe pb-3 pl-[calc(max(1rem,env(safe-area-inset-left))+0.75rem)]">
        <Button
          variant={live ? "default" : "secondary"}
          size="sm"
          nativeButton={false}
          render={<a href={routes.preview(preview.id)} />}
        >
          <AppWindowIcon data-icon="inline-start" />
          Open
        </Button>
        {live ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onStop}>
            {busy ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}
            Stop
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRestart}>
          {live ? <RotateCwIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          {live ? "Restart" : "Start again"}
        </Button>
        {preview.session_id ? (
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<a href={routes.terminal(preview.session_id)} />}
          >
            <ScrollTextIcon data-icon="inline-start" />
            Show logs
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-label={`Remove ${preview.name}`}
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2Icon data-icon="inline-start" />
          Remove
        </Button>
      </div>
    </li>
  );
}
