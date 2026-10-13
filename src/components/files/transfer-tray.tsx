import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/lib/files/format";
import { handOver } from "@/lib/transfers/actions";
import { describeTransferFailure, fraction, progressLabel } from "@/lib/transfers/describe";
import type { Transfer } from "@/lib/transfers/queue";
import { FILES_GROUP, transfers, useTransfers, useTransferSupport } from "@/lib/transfers/store";
import { cn } from "@/lib/utils";

/** How long a transfer that needs nothing more from the owner stays on the list. */
const SETTLED_FOR_MS = 4_000;

/**
 * The files on their way to and from the Mac, each with how far it is and what can be done about
 * it. It takes no room while there are none.
 */
export function TransferTray({ className }: { className?: string }) {
  const items = useTransfers(FILES_GROUP);
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Transfers"
      className={cn(
        "max-h-[45%] shrink-0 overflow-y-auto overscroll-contain border-t bg-card",
        className,
      )}
    >
      <ul className="divide-y">
        {items.map((item) => (
          <TransferRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function TransferRow({ item }: { item: Transfer }) {
  const { limits } = useTransferSupport();
  const upload = item.direction === "upload";
  const settled = item.state === "done" && (upload || item.delivered);
  useEffect(() => {
    if (!settled) return;
    const timer = window.setTimeout(() => transfers.dismiss(item.id), SETTLED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [settled, item.id]);

  let Icon = upload ? ArrowUpIcon : ArrowDownIcon;
  let tone = "text-muted-foreground";
  let status: ReactNode;
  /** What stands at the end of the row: the one way out of it. */
  let actions: ReactNode = null;
  /** Buttons with words on them get a line of their own, so a long message keeps its width. */
  let choices: ReactNode = null;
  const dismiss = (
    <IconAction
      label={`Remove ${item.name} from the list`}
      onClick={() => transfers.dismiss(item.id)}
    >
      <XIcon />
    </IconAction>
  );
  const cancel = (
    <IconAction
      label={`Cancel ${upload ? "uploading" : "downloading"} ${item.name}`}
      onClick={() => transfers.cancel(item.id)}
    >
      <XIcon />
    </IconAction>
  );

  switch (item.state) {
    case "queued":
      status = "Waiting for its turn";
      actions = cancel;
      break;
    case "running":
      tone = "text-lid";
      status = progressLabel(item);
      actions = cancel;
      break;
    case "paused":
      Icon = UnplugIcon;
      status = `Paused at ${progressLabel(item)}: no connection to your Mac. It goes on by itself.`;
      actions = cancel;
      break;
    case "asking":
      Icon = CopyIcon;
      tone = "text-amber";
      status = "A file of this name is already in this folder on your Mac.";
      break;
    case "done":
      Icon = CheckIcon;
      tone = "text-settled";
      if (upload) {
        status =
          item.uploaded && item.uploaded.name !== item.name
            ? `On your Mac as ${item.uploaded.name}`
            : "On your Mac";
        actions = dismiss;
      } else if (item.delivered) {
        status = "Saved";
        actions = dismiss;
      } else {
        status = `${formatSize(item.total ?? 0)}, ready to save`;
        actions = dismiss;
        choices = (
          <Button className="h-10 px-3.5" onClick={() => void handOver(item.id)}>
            Save…
          </Button>
        );
      }
      break;
    case "failed":
      Icon = CircleAlertIcon;
      tone = "text-destructive";
      status = (
        <span className="text-destructive">{describeTransferFailure(item, limits.maxBytes)}</span>
      );
      actions = dismiss;
      choices =
        item.error?.code === "too_large" || item.error?.code === "not_supported" ? null : (
          <Button
            variant="secondary"
            className="h-10 px-3.5"
            onClick={() => transfers.retry(item.id)}
          >
            Try again
          </Button>
        );
      break;
    case "cancelled":
      status = "Cancelled";
      actions = dismiss;
      choices = (
        <Button
          variant="secondary"
          className="h-10 px-3.5"
          onClick={() => transfers.retry(item.id)}
        >
          Start again
        </Button>
      );
      break;
  }

  if (item.state === "asking") {
    choices = (
      <>
        <Button
          variant="destructive"
          className="h-10 px-3.5"
          onClick={() => transfers.answer(item.id, "replace")}
        >
          Replace
        </Button>
        <Button
          variant="secondary"
          className="h-10 px-3.5"
          onClick={() => transfers.answer(item.id, "rename")}
        >
          Keep both
        </Button>
        <Button
          variant="ghost"
          className="h-10 px-3.5"
          onClick={() => {
            // "Leave it" needs nothing more from the owner, so the row goes with the answer.
            transfers.answer(item.id, "cancel");
            transfers.dismiss(item.id);
          }}
        >
          Cancel
        </Button>
      </>
    );
  }

  const moving = item.state === "running" || item.state === "paused";
  const part = fraction(item);

  return (
    <li className="relative flex flex-col gap-2 py-2 pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
      <div className="flex min-h-10 items-center gap-3">
        <Icon aria-hidden="true" className={cn("size-5 shrink-0", tone)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm leading-5" translate="no">
            {item.name}
          </span>
          <span
            className="text-[0.75rem] leading-4 [overflow-wrap:anywhere] text-muted-foreground tabular-nums"
            role="status"
          >
            {status}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      {choices ? <div className="flex flex-wrap gap-2 pr-2.5 pb-1 pl-8">{choices}</div> : null}
      {moving ? (
        <div
          role="progressbar"
          aria-label={`${upload ? "Uploading" : "Downloading"} ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={part === null ? undefined : Math.round(part * 100)}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-input/60"
        >
          <div
            className={cn(
              "h-full origin-left transition-transform duration-200 ease-out",
              item.state === "paused" ? "bg-muted-foreground" : "bg-amber",
            )}
            style={{ transform: `scaleX(${part ?? 0})` }}
          />
        </div>
      ) : null}
    </li>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-touch"
      className="size-11 text-muted-foreground"
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
