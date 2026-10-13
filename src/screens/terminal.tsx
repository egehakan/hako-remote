import "@xterm/xterm/css/xterm.css";
import {
  ArrowDownToLineIcon,
  ChevronLeftIcon,
  ChevronsUpDownIcon,
  FolderOpenIcon,
  MonitorIcon,
  SmartphoneIcon,
} from "lucide-react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { AgentBadge } from "@/components/agent-badge";
import { useAttach } from "@/components/terminal/attach";
import { DirectInput, type DirectInputHandle } from "@/components/terminal/direct-input";
import { KeyBar } from "@/components/terminal/key-bar";
import { MessageBox, type MessageBoxHandle } from "@/components/terminal/message-box";
import { PasteField } from "@/components/terminal/paste-field";
import { SelectView } from "@/components/terminal/select-view";
import { FrozenBanner, SessionStatus } from "@/components/terminal/session-status";
import { SwitcherSheet } from "@/components/terminal/switcher-sheet";
import { TouchLayer } from "@/components/terminal/touch-layer";
import { ViewSheet } from "@/components/terminal/view-sheet";
import { Button } from "@/components/ui/button";
import { useWorkspaceActions } from "@/components/workspace-actions";
import { useWorkspace } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { navigate, routes } from "@/lib/route";
import { type ControllerState, TerminalController } from "@/lib/terminal/controller";
import { NO_STICKY } from "@/lib/terminal/modifiers";
import {
  clamp,
  isTouchDevice,
  MAC_ZOOM_RANGE,
  PHONE_FONT_RANGE,
  type TerminalPrefs,
  terminalPrefs,
} from "@/lib/terminal/prefs";
import type { SessionState } from "@/lib/terminal/session";
import type { SurfaceLayout } from "@/lib/terminal/surface";
import { type TerminalLook, terminalLook } from "@/lib/terminal/theme";
import { useVisibleViewport } from "@/lib/terminal/viewport";
import { cn } from "@/lib/utils";
import { listTerminals, type TerminalLocation } from "@/lib/workspace";

const IDLE_SESSION: SessionState = {
  phase: "waiting",
  reason: null,
  cols: 0,
  rows: 0,
  fitError: null,
};
const IDLE_CONTROLLER: ControllerState = { sticky: NO_STICKY, scrolledUp: false };
const noSubscription = () => () => {};
const idleSession = () => IDLE_SESSION;
const idleController = () => IDLE_CONTROLLER;

const ZOOM_STEP = 1.25;
/** A phone holds too few columns at the Mac's font size, so fitting starts a little smaller. */
const PHONE_FONT_CAP = 12;
const SWIPE_MIN_PX = 56;

function phoneFontSize(prefs: TerminalPrefs, look: TerminalLook, touch: boolean): number {
  return prefs.phoneFontSize ?? (touch ? Math.min(look.fontSize, PHONE_FONT_CAP) : look.fontSize);
}

function layoutFor(prefs: TerminalPrefs, look: TerminalLook, touch: boolean): SurfaceLayout {
  return prefs.fitPhone
    ? { kind: "phone", fontSize: phoneFontSize(prefs, look, touch) }
    : { kind: "mac", zoom: prefs.macZoom };
}

/**
 * One terminal on the Mac, live: its screen, and under it the keys and the message box that make
 * it usable from a phone.
 */
export default function TerminalScreen({ sessionId }: { sessionId: string }) {
  const [touch] = useState(isTouchDevice);
  const { windows } = useWorkspace();
  const { canAct, openTab, askToClose, notice, dismissNotice } = useWorkspaceActions();
  const prefs = useSyncExternalStore(terminalPrefs.subscribe, terminalPrefs.get);
  const look = useSyncExternalStore(terminalLook.subscribe, terminalLook.get);
  const keyboardOpen = useVisibleViewport();

  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const directInput = useRef<DirectInputHandle>(null);
  const messageBox = useRef<MessageBoxHandle>(null);
  const [controller, setController] = useState<TerminalController | null>(null);
  const session = useSyncExternalStore(
    controller ? controller.session.subscribe : noSubscription,
    controller ? controller.session.getSnapshot : idleSession,
  );
  const ui = useSyncExternalStore(
    controller ? controller.subscribe : noSubscription,
    controller ? controller.getSnapshot : idleController,
  );

  const [typing, setTyping] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const terminals = useMemo(() => listTerminals(windows), [windows]);
  const listed = terminals.find((terminal) => terminal.sessionId === sessionId) ?? null;
  // While the Mac is offline there is no workspace, but the frozen screen still has a name.
  const [lastListed, setLastListed] = useState(listed);
  if (listed !== null && listed !== lastListed) setLastListed(listed);
  const current = listed ?? lastListed;
  const panes = current ? terminals.filter((terminal) => terminal.tab === current.tab) : [];

  useEffect(() => {
    if (!scroller.current || !host.current) return;
    const created = new TerminalController({
      sessionId,
      scroller: scroller.current,
      host: host.current,
      touch,
      look: terminalLook.get(),
      layout: layoutFor(terminalPrefs.get(), terminalLook.get(), touch),
    });
    created.start();
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [sessionId, touch]);

  useEffect(() => controller?.surface.setLook(look), [controller, look]);

  const layout = useMemo(() => layoutFor(prefs, look, touch), [prefs, look, touch]);
  useEffect(() => controller?.setLayout(layout), [controller, layout]);

  const live = session.phase === "live";
  const frozen = session.phase === "frozen";

  const focusInput = useCallback(() => {
    if (terminalPrefs.get().inputMode === "message") messageBox.current?.focus();
    else if (touch) directInput.current?.focus();
    else controller?.surface.terminal.focus();
  }, [controller, touch]);

  // A sheet hands the keyboard's focus back to the button that opened it. With a keyboard and a
  // mouse that leaves the next keys with the button, so there it goes to the terminal instead; on
  // a touch screen that would raise the on-screen keyboard, and the button keeps it.
  const focusAfterSheet = useCallback(
    () => (touch ? true : (controller?.surface.terminal.textarea ?? true)),
    [controller, touch],
  );

  // An attached picture's path goes where the owner is writing: the message box, or the terminal.
  const insertAttachment = useCallback(
    (text: string) => {
      if (terminalPrefs.get().inputMode === "message" && messageBox.current) {
        messageBox.current.insert(text);
        return true;
      }
      if (!controller?.session.live) return false;
      controller.paste(text);
      return true;
    },
    [controller],
  );
  const attach = useAttach({ sessionId, insert: insertAttachment });

  const toggleInputMode = () => {
    const next = prefs.inputMode === "message" ? "keys" : "message";
    // The other field has to exist before this tap ends, or the keyboard would close in between.
    flushSync(() => terminalPrefs.set({ inputMode: next }));
    if (typing || !touch) focusInput();
  };

  const toggleKeyboard = () => {
    if (typing) {
      directInput.current?.blur();
      messageBox.current?.blur();
    } else {
      focusInput();
    }
  };

  const paste = () => {
    if (!controller) return;
    const fallback = () => setPasteOpen(true);
    if (!navigator.clipboard?.readText) return fallback();
    navigator.clipboard.readText().then((text) => controller.paste(text), fallback);
  };

  const zoom = (direction: 1 | -1 | 0) => {
    // Read at the moment of the tap, so two quick taps make two steps.
    const now = terminalPrefs.get();
    if (now.fitPhone) {
      const size = phoneFontSize(now, look, touch);
      terminalPrefs.set({
        phoneFontSize:
          direction === 0 ? null : clamp(Math.round(size) + direction, PHONE_FONT_RANGE),
      });
    } else {
      const factor = direction === 1 ? ZOOM_STEP : 1 / ZOOM_STEP;
      terminalPrefs.set({
        macZoom: direction === 0 ? 1 : clamp(now.macZoom * factor, MAC_ZOOM_RANGE),
      });
    }
  };

  const pinch = (scale: number, x: number, y: number) => {
    if (!controller) return;
    const change: Partial<TerminalPrefs> = prefs.fitPhone
      ? {
          phoneFontSize: clamp(
            Math.round(phoneFontSize(prefs, look, touch) * scale),
            PHONE_FONT_RANGE,
          ),
        }
      : { macZoom: clamp(prefs.macZoom * scale, MAC_ZOOM_RANGE) };
    // Applied at once, so the text under the fingers does not jump before the choice is stored.
    controller.zoomAround(layoutFor({ ...prefs, ...change }, look, touch), x, y);
    terminalPrefs.set(change);
  };

  const choose = (terminal: TerminalLocation) => {
    setSwitcherOpen(false);
    if (terminal.sessionId === sessionId) return;
    if (terminal.tab !== current?.tab) openTab(terminal.tab);
    navigate(routes.terminal(terminal.sessionId), { replace: true });
  };

  const step = (offset: 1 | -1) => {
    const index = terminals.findIndex((terminal) => terminal.sessionId === sessionId);
    const next = terminals[index + offset];
    if (index !== -1 && next) choose(next);
  };

  const size = { cols: session.cols, rows: session.rows };
  const knownSize = size.cols > 0 ? size : null;
  const zoomLabel = prefs.fitPhone
    ? `${Math.round(phoneFontSize(prefs, look, touch))}\u00a0px`
    : `${Math.round(prefs.macZoom * 100)}% of the full width`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <TerminalHeader
        current={current}
        size={knownSize}
        fitPhone={prefs.fitPhone}
        onOpenSwitcher={() => setSwitcherOpen(true)}
        onOpenView={() => setViewOpen(true)}
        onStep={step}
      />

      {panes.length > 1 ? (
        <nav
          aria-label="Panes of this tab"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-safe py-1"
        >
          {panes.map((pane) => (
            <a
              key={pane.sessionId}
              href={routes.terminal(pane.sessionId)}
              aria-current={pane.sessionId === sessionId ? "page" : undefined}
              className={cn(
                "flex h-8 max-w-48 shrink-0 items-center rounded-md px-2.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                pane.sessionId === sessionId
                  ? "bg-secondary text-lid"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              translate="no"
              onClick={(event) => {
                event.preventDefault();
                navigate(routes.terminal(pane.sessionId), { replace: true });
              }}
            >
              <span className="truncate">{pane.pane.title}</span>
            </a>
          ))}
        </nav>
      ) : null}

      {notice ? (
        // Beside the workspace list the same message already shows there.
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 py-1.5 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] text-[0.8125rem] leading-5 wide:hidden"
        >
          <p className="min-w-0 flex-1">{notice}</p>
          <Button variant="ghost" className="h-9 px-2.5 text-sm" onClick={dismissNotice}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <FrozenBanner state={session} />

      <div className="relative min-h-0 flex-1" style={{ backgroundColor: look.background }}>
        <div
          ref={scroller}
          // A click always leaves the keys with the terminal, whatever held the focus before.
          onClick={touch ? undefined : () => controller?.surface.terminal.focus()}
          className={cn(
            "terminal-scroller absolute inset-y-0 right-[max(2px,env(safe-area-inset-right))] left-[max(2px,env(safe-area-inset-left))] transition-opacity",
            touch ? "overflow-hidden" : "overflow-auto",
            frozen && "opacity-55",
          )}
        >
          <div ref={host} className={cn("terminal-host", touch && "terminal-host-touch")} />
        </div>
        {touch && controller && host.current ? (
          <TouchLayer
            controller={controller}
            host={host.current}
            onTap={focusInput}
            onLongPress={() => setSelecting(controller.surface.text())}
            onPinch={pinch}
          />
        ) : null}
        <SessionStatus state={session} />
        {ui.scrolledUp && controller ? (
          <Button
            variant="secondary"
            aria-label="Jump to the newest output"
            className="absolute right-[max(0.75rem,env(safe-area-inset-right))] bottom-3 z-10 size-11 rounded-full border-input shadow-lg"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => controller.jumpToBottom()}
          >
            <ArrowDownToLineIcon />
          </Button>
        ) : null}
        {selecting !== null ? (
          <SelectView text={selecting} onClose={() => setSelecting(null)} />
        ) : null}
      </div>

      {controller ? (
        <div
          className={cn(
            "relative shrink-0 border-t bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]",
            // The keyboard covers the home indicator, so its inset is only needed without one.
            keyboardOpen ? "pb-1" : "pb-[max(0.25rem,env(safe-area-inset-bottom))]",
          )}
        >
          {touch ? (
            <DirectInput ref={directInput} controller={controller} onFocusChange={setTyping} />
          ) : null}
          {attach.picker}
          {attach.chips}
          {pasteOpen ? (
            <PasteField
              onPaste={(text) => controller.paste(text)}
              onClose={() => {
                setPasteOpen(false);
                // The field took the keyboard; hand it back to where typing goes.
                if (typing) focusInput();
              }}
            />
          ) : null}
          {prefs.inputMode === "message" ? (
            <MessageBox
              ref={messageBox}
              controller={controller}
              sessionId={sessionId}
              enabled={live}
              attach={attach}
              onFocusChange={setTyping}
            />
          ) : null}
          <KeyBar
            controller={controller}
            ctrl={ui.sticky.ctrl}
            alt={ui.sticky.alt}
            enabled={live}
            inputMode={prefs.inputMode}
            onToggleInputMode={toggleInputMode}
            moreOpen={moreOpen}
            onToggleMore={() => setMoreOpen((open) => !open)}
            onPaste={paste}
            attach={attach}
            keyboard={touch ? { open: typing, toggle: toggleKeyboard } : null}
            onSelect={() => {
              setMoreOpen(false);
              setSelecting(controller.surface.text());
            }}
            onView={() => {
              setMoreOpen(false);
              setViewOpen(true);
            }}
          />
        </div>
      ) : null}

      <ViewSheet
        open={viewOpen}
        onOpenChange={setViewOpen}
        size={size}
        fitPhone={prefs.fitPhone}
        onFitPhoneChange={(fitPhone) => terminalPrefs.set({ fitPhone })}
        fitError={session.fitError}
        zoomLabel={zoomLabel}
        onZoom={zoom}
        canZoomOut={
          prefs.fitPhone
            ? phoneFontSize(prefs, look, touch) > PHONE_FONT_RANGE.min
            : prefs.macZoom > MAC_ZOOM_RANGE.min
        }
        canZoomIn={
          prefs.fitPhone
            ? phoneFontSize(prefs, look, touch) < PHONE_FONT_RANGE.max
            : prefs.macZoom < MAC_ZOOM_RANGE.max
        }
        finalFocus={focusAfterSheet}
      />
      <SwitcherSheet
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        terminals={terminals}
        currentSessionId={sessionId}
        finalFocus={focusAfterSheet}
        onChoose={choose}
        onCloseTab={
          current && canAct
            ? () => {
                setSwitcherOpen(false);
                askToClose(current.tab);
              }
            : null
        }
      />
    </div>
  );
}

type TerminalHeaderProps = {
  current: TerminalLocation | null;
  size: { cols: number; rows: number } | null;
  fitPhone: boolean;
  onOpenSwitcher: () => void;
  onOpenView: () => void;
  onStep: (offset: 1 | -1) => void;
};

/** A compact bar: back, which terminal this is and where, what its agent is doing, and its size. */
function TerminalHeader({
  current,
  size,
  fitPhone,
  onOpenSwitcher,
  onOpenView,
  onStep,
}: TerminalHeaderProps) {
  const swipe = useRef<{ x: number; y: number; done: boolean } | null>(null);
  const SizeIcon = fitPhone ? SmartphoneIcon : MonitorIcon;

  const swipeEnd = (event: PointerEvent<HTMLButtonElement>) => {
    const start = swipe.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 2) {
      start.done = true;
      // Like turning a page: swiping left brings the next terminal in from the right.
      onStep(dx < 0 ? 1 : -1);
    }
  };

  return (
    <header className="flex shrink-0 items-center gap-0.5 border-b pt-safe pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.125rem,env(safe-area-inset-left))] wide:pl-3">
      <h1 className="sr-only">{current ? `Terminal: ${current.tab.title}` : "Terminal"}</h1>
      <Button
        variant="ghost"
        size="icon-touch"
        className="size-11 wide:hidden"
        aria-label="Back to the workspace"
        nativeButton={false}
        render={<a href={routes.workspace} />}
      >
        <ChevronLeftIcon />
      </Button>
      <button
        type="button"
        aria-label={current ? `${current.tab.title}. Switch terminal` : "Switch terminal"}
        className="flex min-h-12 min-w-0 flex-1 touch-pan-y flex-col justify-center rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70 wide:px-2"
        onPointerDown={(event) => {
          swipe.current = { x: event.clientX, y: event.clientY, done: false };
        }}
        onPointerUp={swipeEnd}
        onPointerCancel={() => {
          swipe.current = null;
        }}
        onClick={() => {
          if (!swipe.current?.done) onOpenSwitcher();
          swipe.current = null;
        }}
      >
        <span className="flex items-center gap-1">
          <span className="truncate text-[0.9375rem] leading-5 font-semibold tracking-[-0.01em]">
            {current ? current.tab.title : "Terminal"}
          </span>
          <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
        </span>
        {current?.pane.cwd ? (
          <span
            className="truncate font-mono text-[0.6875rem] leading-4 text-muted-foreground"
            translate="no"
          >
            {tildify(current.pane.cwd)}
          </span>
        ) : null}
      </button>
      {current?.pane.agent ? <AgentBadge agent={current.pane.agent} /> : null}
      {current?.pane.cwd ? (
        <Button
          variant="ghost"
          size="icon-touch"
          className="size-11 text-muted-foreground"
          aria-label="Files here"
          title="Files here"
          nativeButton={false}
          render={<a href={routes.dir(current.pane.cwd)} />}
        >
          <FolderOpenIcon />
        </Button>
      ) : null}
      <button
        type="button"
        aria-label={
          size
            ? `Size and zoom. ${size.cols} by ${size.rows}, ${fitPhone ? "fitted to this screen" : "your Mac’s size"}`
            : "Size and zoom"
        }
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-xs text-muted-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/70"
        onClick={onOpenView}
      >
        <SizeIcon aria-hidden="true" className={cn("size-4", fitPhone && "text-amber")} />
        {size ? (
          <span translate="no">
            {size.cols}×{size.rows}
          </span>
        ) : null}
      </button>
    </header>
  );
}
