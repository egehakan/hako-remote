import type { NotifyKind } from "@shared/notify";
import { CheckIcon, HandIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type Banner, banners } from "@/lib/notifications";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

// The words and colours of the workspace list's agent badge, so the two say the same thing.
const KIND: Record<NotifyKind, { label: string; variant: "waiting" | "done" | "outline" }> = {
  agent_waiting: { label: "Waiting for you", variant: "waiting" },
  agent_done: { label: "Done", variant: "done" },
  command_done: { label: "Command", variant: "outline" },
};

function KindIcon({ kind }: { kind: NotifyKind }) {
  switch (kind) {
    case "agent_waiting":
      return <HandIcon data-icon="inline-start" />;
    case "agent_done":
      return <CheckIcon data-icon="inline-start" />;
    case "command_done":
      return <SquareTerminalIcon data-icon="inline-start" />;
  }
}

/**
 * What the Mac just notified about, shown over the app while it is open. Tapping one opens its
 * terminal. They sit at the top of the visible part of the page, clear of an open keyboard.
 */
export function NotifyBanners() {
  const shown = useSyncExternalStore(banners.subscribe, banners.getSnapshot);
  return (
    <section
      aria-label="Notifications from your Mac"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-(--vv-top) z-50 flex flex-col items-center gap-2 px-safe pt-[max(0.5rem,env(safe-area-inset-top))] wide:items-end wide:pr-4"
    >
      {shown.map((banner) => (
        <BannerCard key={banner.id} banner={banner} />
      ))}
    </section>
  );
}

function BannerCard({ banner }: { banner: Banner }) {
  const { notification } = banner;
  const kind = KIND[notification.kind];
  return (
    <div className="pointer-events-auto flex w-full max-w-md animate-in items-stretch overflow-hidden rounded-xl border bg-popover shadow-[0_12px_32px_-8px_rgb(0_0_0/0.7)] duration-200 fade-in slide-in-from-top-3">
      <span
        aria-hidden="true"
        className={cn(
          "w-[3px] shrink-0",
          notification.kind === "agent_waiting"
            ? "bg-lid"
            : notification.kind === "agent_done"
              ? "bg-settled"
              : "bg-input",
        )}
      />
      <a
        href={routes.terminal(notification.session_id)}
        className="flex min-w-0 flex-1 flex-col gap-1 py-2.5 pr-1 pl-3 outline-none hover:bg-accent/40 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        onClick={() => banners.dismiss(banner.id)}
      >
        <span className="flex items-center gap-2">
          <Badge variant={kind.variant}>
            <KindIcon kind={notification.kind} />
            {kind.label}
          </Badge>
          <span className="sr-only">Open the terminal:</span>
        </span>
        <span className="truncate text-[0.9375rem] leading-5 font-medium">
          {notification.title}
        </span>
        {notification.body ? (
          <span className="line-clamp-2 text-[0.8125rem] leading-5 whitespace-pre-line text-muted-foreground">
            {notification.body}
          </span>
        ) : null}
      </a>
      <Button
        variant="ghost"
        size="icon-touch"
        className="my-1 mr-1 self-center text-muted-foreground"
        aria-label="Dismiss"
        onClick={() => banners.dismiss(banner.id)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
