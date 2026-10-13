import { CloudOffIcon, UnplugIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { SessionState } from "@/lib/terminal/session";
import { routes } from "@/lib/route";

/**
 * The banner over a frozen terminal: the last screen the Mac sent stays readable under it, and
 * says that nothing typed now would arrive.
 */
export function FrozenBanner({ state }: { state: SessionState }) {
  if (state.phase !== "frozen") return null;
  const Icon = state.reason === "mac" ? UnplugIcon : CloudOffIcon;
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2.5 border-b border-amber/40 bg-[color-mix(in_oklab,var(--amber)_16%,var(--background))] py-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] text-[0.8125rem] leading-5"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
      <p>
        <span className="font-medium">
          {state.reason === "mac" ? "Your Mac went offline." : "Connection lost."}
        </span>{" "}
        <span className="text-muted-foreground">
          This is the last screen your Mac sent. The terminal comes back by itself.
        </span>
      </p>
    </div>
  );
}

/** Covers the terminal while there is nothing live to show: not open yet, ended, or gone. */
export function SessionStatus({ state }: { state: SessionState }) {
  if (state.phase === "live" || state.phase === "frozen") return null;

  if (state.phase === "waiting") {
    return (
      <div
        role="status"
        className="absolute inset-0 z-10 flex items-center justify-center gap-2.5 bg-background/80 text-sm text-muted-foreground"
      >
        <Spinner />
        {state.reason === "mac"
          ? "Waiting for your Mac to come online…"
          : state.reason === "relay"
            ? "Connecting…"
            : "Opening the terminal…"}
      </div>
    );
  }

  const title =
    state.phase === "closed"
      ? "This terminal has ended"
      : state.phase === "missing"
        ? "This terminal isn’t open any more"
        : "Terminals need a newer Hako";
  const detail =
    state.phase === "unsupported"
      ? "The Hako on your Mac can’t show its terminals here yet. Update it and try again."
      : state.phase === "closed"
        ? "The shell exited, or its tab was closed."
        : "It was closed on your Mac or from another device.";
  return (
    <Empty className="absolute inset-0 z-10 bg-background/90">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="secondary"
          size="touch"
          nativeButton={false}
          render={<a href={routes.workspace} />}
        >
          Back to the workspace
        </Button>
      </EmptyContent>
    </Empty>
  );
}
