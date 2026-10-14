import type { NotifyKind } from "@shared/notify";
import { type ReactNode, useState } from "react";
import { BoxMark } from "@/components/box-mark";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useNotifications } from "@/lib/hooks";
import { type NotificationsSnapshot, notifications, type TestOutcome } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const KINDS: { kind: NotifyKind; label: string; detail: string }[] = [
  {
    kind: "agent_waiting",
    label: "An agent is waiting for you",
    detail: "A permission request or a question in one of your terminals.",
  },
  {
    kind: "agent_done",
    label: "An agent has finished",
    detail: "Claude Code or another agent is done with what you asked.",
  },
  {
    kind: "command_done",
    label: "A long command has finished",
    detail: "A build, a test run or anything else that took a while.",
  },
  {
    kind: "preview_ready",
    label: "A preview is ready",
    detail: "An app Claude Code started on your Mac answers; tapping opens it under Previews.",
  },
];

type Status = {
  /** The box is lit when notifications reach this device, and tries its lid while that is decided. */
  mark: "lit" | "dark" | "seeking";
  title: string;
  body: ReactNode;
  steps?: ReactNode[];
  after?: string;
};

function describe(state: NotificationsSnapshot): Status {
  switch (state.availability) {
    case "unsupported":
      return {
        mark: "dark",
        title: "This browser can’t show notifications",
        body: window.isSecureContext
          ? "Hako needs a browser with web push: a current Chrome, Edge, Firefox or Safari on a computer, or Hako on the home screen of an iPhone."
          : "Notifications only work over HTTPS. Open Hako at its https:// address and look here again.",
      };
    case "ios-update":
      return {
        mark: "dark",
        title: "This iPhone needs iOS 16.4 or later",
        body: "Home-screen apps can send notifications from iOS 16.4 on.",
        steps: [
          "Open the Settings app.",
          "Go to General, then Software Update, and install the update.",
          "Open Hako from its icon and come back to Account.",
        ],
      };
    case "needs-home-screen":
      return {
        mark: "dark",
        title: "Add Hako to your home screen first",
        body: "An iPhone only lets a site send notifications once it is an app on the home screen. You are in a browser tab now.",
        steps: [
          <>
            In Safari, tap <strong>Share</strong>: the square with an arrow pointing up.
          </>,
          <>
            Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </>,
          "Open Hako from the new icon and log in.",
          <>
            Come back to Account and tap <strong>Turn on notifications</strong>.
          </>,
        ],
        after: "This needs iOS 16.4 or later.",
      };
    case "ask":
      return {
        mark: state.asking ? "seeking" : "dark",
        title: "Notifications are off on this device",
        body: "Turn them on and your Mac tells you here when an agent is waiting for you, when it has finished and when a long command is done, whether Hako is open or not.",
        after: state.ios
          ? "Your iPhone asks for permission next. Choose Allow."
          : "Your browser asks for permission next. Choose Allow.",
      };
    case "denied":
      return state.ios
        ? {
            mark: "dark",
            title: "Notifications are turned off for Hako",
            body: "iOS is holding them back. You can allow them again in the Settings app.",
            steps: [
              "Open the Settings app.",
              <>
                Tap <strong>Notifications</strong>, then <strong>Hako</strong>.
              </>,
              <>
                Turn on <strong>Allow Notifications</strong>.
              </>,
              "Come back to Hako. This screen updates by itself.",
            ],
          }
        : {
            mark: "dark",
            title: "Notifications are blocked for this site",
            body: "This browser was told not to show notifications from Hako. Allow them in the site’s settings, which open from the icon at the left of the address bar, then reload this page.",
          };
    case "granted":
      if (state.link === "connecting") {
        return {
          mark: "seeking",
          title: "Turning notifications on…",
          body: "Registering this device with the relay.",
        };
      }
      if (state.link === "failed") {
        return {
          mark: "dark",
          title: "This device isn’t registered yet",
          body: state.problem ?? "Something went wrong. Try again in a moment.",
        };
      }
      return state.prefs.muted
        ? {
            mark: "dark",
            title: "On for this device, but muted",
            body: "Nothing is sent here until you turn Mute off.",
          }
        : {
            mark: "lit",
            title: "On for this device",
            body: "Your Mac reaches this device when an agent is waiting for you, when it has finished and when a long command is done, whether Hako is open or not.",
          };
  }
}

/** Account → Notifications: where this device stands, what to do next, and what to hear about. */
export function NotificationSettings() {
  const state = useNotifications();
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const status = describe(state);
  const ready = state.availability === "granted" && state.link === "ready";
  const { muted, kinds } = state.prefs;

  async function sendTest() {
    setTesting(true);
    setOutcome(null);
    setOutcome(await notifications.sendTest());
    setTesting(false);
  }

  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-4">
      <h2 id="notifications-heading" className="text-base font-semibold">
        Notifications
      </h2>

      {/* The same box as a folder in the workspace list: its lid is lit when notifications arrive. */}
      <div className="overflow-hidden rounded-lg border bg-card">
        <div
          aria-hidden="true"
          className={cn(
            "h-[3px] transition-colors duration-500",
            status.mark === "lit" ? "bg-amber" : "bg-input",
          )}
        />
        <div className="flex gap-3.5 p-4">
          <BoxMark state={status.mark} className="mt-0.5 h-9" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5" role="status" aria-live="polite">
            <h3 className="text-[0.9375rem] leading-6 font-semibold">{status.title}</h3>
            <p className="text-sm leading-6 text-pretty text-muted-foreground">{status.body}</p>
            {status.steps ? (
              <ol className="mt-1 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-6 marker:font-medium marker:text-lid [&_strong]:font-semibold [&_strong]:text-foreground">
                {status.steps.map((step, index) => (
                  <li key={index} className="pl-1">
                    {step}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </div>

        {state.availability === "ask" ? (
          <div className="flex flex-col gap-2 border-t p-4">
            <Button
              size="touch"
              className="self-start"
              disabled={state.asking}
              // Straight from the tap: the browser shows its question only in answer to one.
              onClick={() => notifications.enable()}
            >
              {state.asking ? <Spinner data-icon="inline-start" /> : null}
              Turn on notifications
            </Button>
            <p className="text-[0.8125rem] leading-5 text-muted-foreground">{status.after}</p>
          </div>
        ) : state.availability === "granted" && state.link === "failed" ? (
          <div className="border-t p-4">
            <Button size="touch" variant="secondary" onClick={() => notifications.retry()}>
              Try again
            </Button>
          </div>
        ) : ready ? (
          <div className="flex flex-col gap-2 border-t p-4">
            <Button
              size="touch"
              variant="secondary"
              className="self-start"
              disabled={testing}
              onClick={() => void sendTest()}
            >
              {testing ? <Spinner data-icon="inline-start" /> : null}
              Send a test notification
            </Button>
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "text-[0.8125rem] leading-5",
                outcome && !outcome.ok ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {outcome === null
                ? "Lock the screen or leave Hako first to see it as it will arrive."
                : outcome.ok
                  ? "Sent. It should arrive within a few seconds."
                  : outcome.message}
            </p>
          </div>
        ) : status.after ? (
          <p className="border-t px-4 py-3 text-[0.8125rem] leading-5 text-muted-foreground">
            {status.after}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col divide-y border-y">
        <SwitchRow
          label="Mute"
          detail={
            muted
              ? "Nothing is sent to this device and no banner appears in the app. A test still comes through."
              : "Stops every notification on this device until you turn this off."
          }
          checked={muted}
          onCheckedChange={(checked) => notifications.setMuted(checked)}
        />
        {KINDS.map(({ kind, label, detail }) => (
          <SwitchRow
            key={kind}
            label={label}
            detail={detail}
            checked={kinds[kind]}
            disabled={muted}
            onCheckedChange={(checked) => notifications.setKind(kind, checked)}
          />
        ))}
      </div>

      {ready && state.problem ? (
        <p role="alert" className="text-sm leading-6 text-destructive">
          {state.problem}
        </p>
      ) : null}

      <p className="text-[0.8125rem] leading-5 text-pretty text-muted-foreground">
        These switches belong to this device, and also decide which banners appear while Hako is
        open. A notification’s title and text travel through the push service of this device’s maker
        (Apple’s, on an iPhone), encrypted so that only this device can read them.
      </p>
    </section>
  );
}

function SwitchRow({
  label,
  detail,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn("flex min-h-16 items-center gap-4 py-3 pr-1", disabled && "text-foreground/50")}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base font-medium">{label}</span>
        <span className="text-[0.8125rem] leading-5 text-muted-foreground">{detail}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  );
}
