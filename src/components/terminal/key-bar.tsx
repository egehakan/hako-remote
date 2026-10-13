import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ClipboardPasteIcon,
  CornerDownLeftIcon,
  EllipsisIcon,
  KeyboardIcon,
  KeyboardOffIcon,
  LockIcon,
  MessageSquareTextIcon,
  ScalingIcon,
  TextSelectIcon,
} from "lucide-react";
import type { TerminalController } from "@/lib/terminal/controller";
import type { Sticky } from "@/lib/terminal/modifiers";
import type { InputMode } from "@/lib/terminal/prefs";
import { cn } from "@/lib/utils";
import { type Attach, AttachKey } from "./attach";
import { KeyButton } from "./key-button";

type KeyBarProps = {
  controller: TerminalController;
  ctrl: Sticky;
  alt: Sticky;
  /** False while nothing reaches the Mac, which greys the keys out. */
  enabled: boolean;
  inputMode: InputMode;
  onToggleInputMode: () => void;
  moreOpen: boolean;
  onToggleMore: () => void;
  onPaste: () => void;
  attach: Pick<Attach, "pick" | "available">;
  /** Shown on touch devices only: whether the on-screen keyboard is up, and the way to toggle it. */
  keyboard: { open: boolean; toggle: () => void } | null;
  onSelect: () => void;
  onView: () => void;
};

type ExtraKey = { label: string; name: string; key: string; ctrl?: boolean };

/** The keys behind "more": too rare for the bar, too awkward to reach on a phone keyboard. */
const EXTRA_KEYS: ExtraKey[] = [
  { label: "^D", name: "Control D", key: "d", ctrl: true },
  { label: "^L", name: "Control L", key: "l", ctrl: true },
  { label: "^R", name: "Control R", key: "r", ctrl: true },
  { label: "^Z", name: "Control Z", key: "z", ctrl: true },
  { label: "home", name: "Home", key: "Home" },
  { label: "end", name: "End", key: "End" },
  { label: "pgup", name: "Page up", key: "PageUp" },
  { label: "pgdn", name: "Page down", key: "PageDown" },
  { label: "del", name: "Delete", key: "Delete" },
  { label: "|", name: "Pipe", key: "|" },
  { label: "~", name: "Tilde", key: "~" },
  { label: "/", name: "Slash", key: "/" },
  { label: "-", name: "Hyphen", key: "-" },
  { label: "_", name: "Underscore", key: "_" },
  { label: "\\", name: "Backslash", key: "\\" },
  { label: "`", name: "Backtick", key: "`" },
  { label: "*", name: "Asterisk", key: "*" },
];

function stickyLabel(name: string, state: Sticky): string {
  if (state === "armed") return `${name}, on for the next key`;
  if (state === "locked") return `${name}, locked on`;
  return name;
}

function StickyKey({
  label,
  name,
  state,
  enabled,
  onTap,
  onLock,
}: {
  label: string;
  name: string;
  state: Sticky;
  enabled: boolean;
  onTap: () => void;
  onLock: () => void;
}) {
  return (
    <KeyButton
      aria-label={stickyLabel(name, state)}
      aria-pressed={state !== "off"}
      title={`${name}: tap for the next key, hold to lock`}
      tone={state === "off" ? "key" : "armed"}
      disabled={!enabled}
      onPress={onTap}
      onHold={onLock}
    >
      {label}
      {state === "locked" ? <LockIcon aria-hidden="true" className="ml-1 size-3!" /> : null}
    </KeyButton>
  );
}

/** The keys a phone keyboard lacks, in two rows, with the rarer ones behind "more". */
export function KeyBar({
  controller,
  ctrl,
  alt,
  enabled,
  inputMode,
  onToggleInputMode,
  moreOpen,
  onToggleMore,
  onPaste,
  attach,
  keyboard,
  onSelect,
  onView,
}: KeyBarProps) {
  return (
    <div className="flex flex-col gap-1 px-1 pt-1" role="group" aria-label="Terminal keys">
      {moreOpen ? (
        <div id="terminal-more-keys" className="flex flex-col gap-1 border-b pb-1">
          <div className="grid grid-cols-6 gap-1 sm:grid-cols-9 lg:grid-cols-18">
            <StickyKey
              label="alt"
              name="Alt"
              state={alt}
              enabled={enabled}
              onTap={() => controller.tapModifier("alt")}
              onLock={() => controller.lockModifier("alt")}
            />
            {EXTRA_KEYS.map((extra) => (
              <KeyButton
                key={extra.label}
                aria-label={extra.name}
                disabled={!enabled}
                repeat={extra.key.length > 1}
                onPress={() => controller.press(extra.key, { ctrl: extra.ctrl })}
              >
                {extra.label}
              </KeyButton>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <KeyButton className="gap-2 font-sans text-sm" onPress={onSelect}>
              <TextSelectIcon aria-hidden="true" />
              Select text
            </KeyButton>
            <KeyButton className="gap-2 font-sans text-sm" onPress={onView}>
              <ScalingIcon aria-hidden="true" />
              Size and zoom
            </KeyButton>
          </div>
        </div>
      ) : null}

      {/* Two rows on a phone held upright; one row wherever there is the width for it. */}
      <div className="flex flex-col gap-1 sm:flex-row">
        <div className={cn("grid gap-1 sm:flex-1", keyboard ? "grid-cols-7" : "grid-cols-6")}>
          <KeyButton
            aria-label="Escape"
            disabled={!enabled}
            onPress={() => controller.press("Escape")}
          >
            esc
          </KeyButton>
          <KeyButton aria-label="Tab" disabled={!enabled} onPress={() => controller.press("Tab")}>
            tab
          </KeyButton>
          <KeyButton
            aria-label="Shift Tab"
            disabled={!enabled}
            onPress={() => controller.press("Tab", { shift: true })}
          >
            ⇧tab
          </KeyButton>
          <StickyKey
            label="ctrl"
            name="Control"
            state={ctrl}
            enabled={enabled}
            onTap={() => controller.tapModifier("ctrl")}
            onLock={() => controller.lockModifier("ctrl")}
          />
          <KeyButton
            aria-label="Control C"
            tone="accent"
            disabled={!enabled}
            onPress={() => controller.press("c", { ctrl: true })}
          >
            ^C
          </KeyButton>
          <KeyButton
            aria-label="More keys"
            aria-expanded={moreOpen}
            aria-controls="terminal-more-keys"
            tone={moreOpen ? "armed" : "key"}
            onPress={onToggleMore}
          >
            <EllipsisIcon aria-hidden="true" />
          </KeyButton>
          {keyboard ? (
            <KeyButton
              aria-label={keyboard.open ? "Hide the keyboard" : "Show the keyboard"}
              onPress={keyboard.toggle}
            >
              {keyboard.open ? (
                <KeyboardOffIcon aria-hidden="true" />
              ) : (
                <KeyboardIcon aria-hidden="true" />
              )}
            </KeyButton>
          ) : null}
        </div>

        <div className="grid grid-cols-8 gap-1 sm:flex-1">
          <KeyButton
            aria-label={
              inputMode === "message"
                ? "Message box is on. Switch to typing keys directly"
                : "Typing keys directly. Switch to the message box"
            }
            aria-pressed={inputMode === "message"}
            tone={inputMode === "message" ? "armed" : "key"}
            onPress={onToggleInputMode}
          >
            <MessageSquareTextIcon aria-hidden="true" />
          </KeyButton>
          <KeyButton aria-label="Paste" disabled={!enabled} onPress={onPaste}>
            <ClipboardPasteIcon aria-hidden="true" />
          </KeyButton>
          <AttachKey attach={attach} disabled={!enabled} />
          <KeyButton
            aria-label="Left"
            repeat
            disabled={!enabled}
            onPress={() => controller.press("ArrowLeft")}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </KeyButton>
          <KeyButton
            aria-label="Down"
            repeat
            disabled={!enabled}
            onPress={() => controller.press("ArrowDown")}
          >
            <ArrowDownIcon aria-hidden="true" />
          </KeyButton>
          <KeyButton
            aria-label="Up"
            repeat
            disabled={!enabled}
            onPress={() => controller.press("ArrowUp")}
          >
            <ArrowUpIcon aria-hidden="true" />
          </KeyButton>
          <KeyButton
            aria-label="Right"
            repeat
            disabled={!enabled}
            onPress={() => controller.press("ArrowRight")}
          >
            <ArrowRightIcon aria-hidden="true" />
          </KeyButton>
          <KeyButton
            aria-label="Enter"
            tone="accent"
            disabled={!enabled}
            onPress={() => controller.press("Enter")}
          >
            <CornerDownLeftIcon aria-hidden="true" />
          </KeyButton>
        </div>
      </div>
    </div>
  );
}
