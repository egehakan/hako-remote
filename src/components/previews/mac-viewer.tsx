import {
  type BrowserInputEvent,
  MOD_META,
  type MouseButton,
  normalizeAddress,
} from "@shared/browser";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  HandIcon,
  KeyboardIcon,
  KeyboardOffIcon,
  LaptopIcon,
  RotateCcwIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CopyNotice } from "@/components/files/copy-path";
import { MacOffline } from "@/components/mac-offline";
import { ConsoleSheet, isConsoleError } from "@/components/previews/console-sheet";
import {
  displayUrl,
  DownloadsBar,
  FileChooserSheet,
  PageDialog,
  PickerSheet,
  TabsSheet,
} from "@/components/previews/mac-browser-sheets";
import { ViewportSheet } from "@/components/previews/viewport-sheet";
import { keyClasses, KeyButton } from "@/components/terminal/key-button";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { editEvents, keyDownEvent, keyPress, modifierBits, pasteEvents } from "@/lib/browser/keys";
import {
  clampPan,
  fitScale,
  type Placement,
  type Point,
  place,
  toPage,
  toPageClamped,
  zoomAround,
} from "@/lib/browser/mapping";
import { type BrowserTarget, MacBrowserSession, type SessionSnapshot } from "@/lib/browser/session";
import { deviceFor, noteMacBrowserSupport, type ViewerMode } from "@/lib/browser/support";
import { copyTextLater } from "@/lib/clipboard";
import { RpcFailure } from "@/lib/connection";
import { describeFailure, NEEDS_NEWER_HAKO } from "@/lib/errors";
import { useConnection } from "@/lib/hooks";
import {
  readChoice,
  type ViewChoice,
  viewportLabel,
  viewportSize,
  writeChoice,
  zoomLevels,
} from "@/lib/previews/viewports";
import { routes } from "@/lib/route";
import { diffInput } from "@/lib/terminal/input-diff";
import { isTouchDevice } from "@/lib/terminal/prefs";
import { useVisibleViewport } from "@/lib/terminal/viewport";
import { cn } from "@/lib/utils";

/** Room left around a page shown at a fixed size, so its edges can be seen. */
const STAGE_PADDING = 12;
/** How far a finger may wander and still tap. */
const TAP_SLOP = 8;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 350;
const MAX_ZOOM = 4;
/** A flick slower than this, in stage pixels per millisecond, just stops. */
const FLICK_MIN_SPEED = 0.25;
const MOMENTUM_STEP_MS = 40;
const MOMENTUM_DECAY = 0.86;
const VIEWPORT_DELAY_MS = 300;
const NOTICE_MS = 3_500;
/** What the hidden text field holds between keystrokes (see `direct-input.tsx`). */
const SENTINEL = " ";

/** Where each viewer was, so coming back to it (or the Mac coming back) opens the same page. */
const lastUrls = new Map<string, string>();

function useStageSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: Math.floor(box.width), height: Math.floor(box.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

const IDLE_SNAPSHOT: SessionSnapshot = {
  phase: "starting",
  message: null,
  bid: null,
  state: null,
  picture: null,
  dialog: null,
  picker: null,
  chooser: null,
  downloads: [],
  console: [],
};
const noSubscribe = () => () => {};
const idle = () => IDLE_SNAPSHOT;

type MacViewerProps = {
  /** What to open: a preview's own address, or any address. */
  target: BrowserTarget;
  /** Names the viewer while the page has no title of its own. */
  name: string;
  /** Where the view choice is remembered. */
  choiceKey: string;
  /** For a preview: the switch to the phone browser. */
  mode?: { onChange: (mode: ViewerMode) => void };
  /** A dot in the address field, as a preview's status. */
  status?: ReactNode;
  /**
   * Names this run of what is shown, for coming back to where the viewer was: a preview started
   * again may be on another port, and its old address must not be opened then.
   */
  runKey?: string;
};

/**
 * A page in Chrome on the Mac, as pictures on a canvas, with a browser's controls. Taps, drags,
 * keys and text go to the Mac; two fingers zoom the picture here.
 */
export function MacViewer({ target, name, choiceKey, mode, status, runKey }: MacViewerProps) {
  const { link, agent } = useConnection();
  const keyboardOpen = useVisibleViewport();
  const touchDevice = useMemo(() => isTouchDevice(), []);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const space = useStageSize(stage);
  const [choice, setChoiceState] = useState<ViewChoice>(() => readChoice(choiceKey));
  const [session, setSession] = useState<MacBrowserSession | null>(null);
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.getSnapshot ?? idle,
  );
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [liveZoom, setLiveZoom] = useState<number | null>(null);
  const [panMode, setPanMode] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [viewportOpen, setViewportOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [tabsOpen, setTabsOpen] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const targetKey = `${"previewId" in target ? `p:${target.previewId}` : `u:${target.url}`}#${runKey ?? ""}`;

  const setChoice = useCallback(
    (next: ViewChoice) => {
      setChoiceState(next);
      writeChoice(choiceKey, next);
      setPan({ x: 0, y: 0 });
    },
    [choiceKey],
  );

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // The device the Mac's browser pretends to be. Fit follows this screen, but not while the
  // keyboard covers part of it, as a phone's browser keeps its page size when the keyboard opens.
  const fixed = viewportSize(choice) !== null;
  const padding = fixed ? STAGE_PADDING : 0;
  const usable = {
    width: Math.max(0, space.width - padding * 2),
    height: Math.max(0, space.height - padding * 2),
  };
  const frozen = useRef<ReturnType<typeof deviceFor> | null>(null);
  const measured = usable.width >= 100 && usable.height >= 100;
  let device = deviceFor(choice, usable);
  if (!fixed && keyboardOpen && frozen.current) device = frozen.current;
  else if (measured) frozen.current = device;

  // One session for the life of the viewer, opened once the stage has a size.
  const deviceRef = useRef(device);
  deviceRef.current = device;
  useEffect(() => {
    if (!measured) return;
    const kept = lastUrls.get(targetKey);
    const opened = new MacBrowserSession(kept ? { url: kept } : target, deviceRef.current);
    opened.setCanvas(canvasRef.current);
    opened.start();
    setSession(opened);
    return () => {
      const url = opened.getSnapshot().state?.url;
      if (url && url !== "about:blank") lastUrls.set(targetKey, url);
      opened.dispose();
      setSession(null);
    };
    // `target` is the same for the life of the viewer, which is keyed by it, as `targetKey` says.
  }, [measured, targetKey]);

  useEffect(() => {
    const url = snapshot.state?.url;
    if (url && url !== "about:blank") lastUrls.set(targetKey, url);
  }, [snapshot.state?.url, targetKey]);

  useEffect(() => {
    if (snapshot.phase === "unsupported") noteMacBrowserSupport("no");
    else if (snapshot.phase === "live") noteMacBrowserSupport("yes");
  }, [snapshot.phase]);

  const deviceKey = `${device.width}x${device.height}@${device.scale}${device.mobile ? "m" : ""}${device.touch ? "t" : ""}`;
  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(
      () => session.setViewport(deviceRef.current),
      VIEWPORT_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [session, deviceKey]);

  // Where the picture is: the size it was drawn at (the device until the first one arrives).
  const page = snapshot.picture ?? { width: device.width, height: device.height };
  const fit = fitScale(page, usable);
  const scale = liveZoom ?? choice.zoom ?? fit;
  const inner = place(usable, page, scale, pan);
  const placement: Placement = {
    left: inner.left + padding,
    top: inner.top + padding,
    scale: inner.scale,
  };
  const zoomed = scale > fit + 0.005;
  const levels = zoomLevels(fit);

  const zoomTo = (next: number | null, focus?: Point) => {
    const target = next ?? fit;
    const at = focus ?? { x: usable.width / 2, y: usable.height / 2 };
    setPan(zoomAround(usable, page, { scale, pan }, target, at));
    const kept = next === null || Math.abs(target - fit) < 0.005 ? null : target;
    setChoiceState((before) => {
      const updated = { ...before, zoom: kept };
      writeChoice(choiceKey, updated);
      return updated;
    });
    if (kept === null) setPanMode(false);
  };
  const zoomBy = (step: 1 | -1) => {
    const index = levels.findIndex((level) => Math.abs(level - scale) < 0.005);
    const from = index === -1 ? levels.findLastIndex((level) => level < scale) : index;
    const next = levels[Math.min(levels.length - 1, Math.max(0, from + step))];
    zoomTo(next);
  };

  // Input

  const send = (...events: BrowserInputEvent[]) => session?.input(...events);
  const sendNow = (...events: BrowserInputEvent[]) => {
    session?.input(...events);
    session?.flush();
  };

  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const momentum = useRef<number | undefined>(undefined);
  const lastTap = useRef<{ at: number; point: Point; clicks: number } | null>(null);
  const live = snapshot.phase === "live";
  const touchViewport = device.touch;

  const stagePoint = (event: { clientX: number; clientY: number }): Point => {
    const box = stage?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const stopMomentum = () => {
    window.clearInterval(momentum.current);
    momentum.current = undefined;
  };

  /** A flick goes on as a few scroll steps that slow down, at the point where it was let go. */
  const flick = (at: Point, velocity: Point) => {
    stopMomentum();
    let vx = velocity.x;
    let vy = velocity.y;
    if (Math.hypot(vx, vy) < FLICK_MIN_SPEED) return;
    let steps = 0;
    momentum.current = window.setInterval(() => {
      const dx = (-vx * MOMENTUM_STEP_MS) / placement.scale;
      const dy = (-vy * MOMENTUM_STEP_MS) / placement.scale;
      if (Math.hypot(dx, dy) < 2 || ++steps > 14) {
        stopMomentum();
        return;
      }
      send({ type: "scroll", x: at.x, y: at.y, dx, dy });
      vx *= MOMENTUM_DECAY;
      vy *= MOMENTUM_DECAY;
    }, MOMENTUM_STEP_MS);
  };

  const pageAt = (point: Point) => toPage(point, placement, page);
  const pageNear = (point: Point) => toPageClamped(point, placement, page);

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const previous = gesture.current;
    if (previous?.kind === "touch" && previous.sent) {
      send({ type: "touch", phase: "cancel", points: [{ ...previous.last, id: 0 }] });
    }
    if (previous?.kind === "press") window.clearTimeout(previous.timer);
    if (previous?.kind === "press" && previous.mouseDown) {
      send(mouseEvent("up", previous.lastPage, "left", 1, 0));
    }
    gesture.current = {
      kind: "pinch",
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale,
      pan,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!live) return;
    stopMomentum();
    // A tap on the page leaves the address field, as it would leave a browser's.
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== fieldRef.current &&
      focused !== document.body
    ) {
      focused.blur();
    }
    const point = stagePoint(event);
    if (event.pointerType === "mouse") {
      onMouseDown(event, point);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      startPinch();
      return;
    }
    if (pointers.current.size > 2) return;
    const on = pageAt(point);
    if (!on) {
      gesture.current = { kind: "ignored" };
      return;
    }
    const sample = { at: event.timeStamp, point };
    if (touchViewport) {
      send({ type: "touch", phase: "start", points: [{ ...on, id: 0 }] });
      gesture.current = { kind: "touch", sent: true, last: on, samples: [sample], start: point };
    } else {
      const press: PressGesture = {
        kind: "press",
        start: point,
        startPage: on,
        lastPage: on,
        scrolling: false,
        mouseDown: false,
        samples: [sample],
        timer: window.setTimeout(() => {
          // Held without moving: the button goes down here, so a drag now selects text.
          if (gesture.current !== press || press.scrolling) return;
          press.mouseDown = true;
          send(mouseEvent("move", press.startPage, "none", 0, 0));
          send(mouseEvent("down", press.startPage, "left", 1, 0));
          session?.flush();
        }, LONG_PRESS_MS),
      };
      gesture.current = press;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") {
      onMouseMove(event);
      return;
    }
    if (!pointers.current.has(event.pointerId)) return;
    const point = stagePoint(event);
    pointers.current.set(event.pointerId, point);
    const current = gesture.current;
    if (!current) return;
    if (current.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const next = Math.min(MAX_ZOOM, Math.max(fit, (current.scale * distance) / current.distance));
      const focus = { x: current.mid.x - padding, y: current.mid.y - padding };
      const zoomedPan = zoomAround(
        usable,
        page,
        { scale: current.scale, pan: current.pan },
        next,
        focus,
      );
      setLiveZoom(next);
      setPan(
        clampPan(usable, page, next, {
          x: zoomedPan.x + mid.x - current.mid.x,
          y: zoomedPan.y + mid.y - current.mid.y,
        }),
      );
      return;
    }
    if (current.kind === "touch") {
      const on = pageNear(point);
      current.last = on;
      current.samples = recent([...current.samples, { at: event.timeStamp, point }]);
      send({ type: "touch", phase: "move", points: [{ ...on, id: 0 }] });
      return;
    }
    if (current.kind === "press") {
      const previous = current.samples[current.samples.length - 1]?.point ?? current.start;
      current.samples = recent([...current.samples, { at: event.timeStamp, point }]);
      const on = pageNear(point);
      if (current.mouseDown) {
        current.lastPage = on;
        send(mouseEvent("move", on, "left", 0, 0));
        return;
      }
      if (
        !current.scrolling &&
        Math.hypot(point.x - current.start.x, point.y - current.start.y) > TAP_SLOP
      ) {
        current.scrolling = true;
        window.clearTimeout(current.timer);
      }
      if (current.scrolling) {
        send({
          type: "scroll",
          x: current.startPage.x,
          y: current.startPage.y,
          dx: (previous.x - point.x) / placement.scale,
          dy: (previous.y - point.y) / placement.scale,
        });
      }
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (event.pointerType === "mouse") {
      onMouseUp(event);
      return;
    }
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current;
    if (!current) return;
    if (current.kind === "pinch") {
      if (pointers.current.size > 0) return;
      gesture.current = null;
      const ended = liveZoom;
      setLiveZoom(null);
      if (ended !== null) {
        const kept = Math.abs(ended - fit) < 0.01 ? null : ended;
        setChoiceState((before) => {
          const updated = { ...before, zoom: kept };
          writeChoice(choiceKey, updated);
          return updated;
        });
      }
      return;
    }
    gesture.current = null;
    if (current.kind === "touch") {
      send({
        type: "touch",
        phase: cancelled ? "cancel" : "end",
        points: [{ ...current.last, id: 0 }],
      });
      session?.flush();
      return;
    }
    if (current.kind === "press") {
      window.clearTimeout(current.timer);
      if (current.mouseDown) {
        sendNow(mouseEvent("up", current.lastPage, "left", 1, 0));
        return;
      }
      if (cancelled) return;
      if (current.scrolling) {
        flick(current.startPage, velocityOf(current.samples, event.timeStamp));
        return;
      }
      // A tap is a click; a second one close by soon after is a double click.
      const previous = lastTap.current;
      const clicks =
        previous &&
        event.timeStamp - previous.at < DOUBLE_TAP_MS &&
        Math.hypot(previous.point.x - current.start.x, previous.point.y - current.start.y) < 24
          ? previous.clicks + 1
          : 1;
      lastTap.current = { at: event.timeStamp, point: current.start, clicks };
      sendNow(
        mouseEvent("move", current.startPage, "none", 0, 0),
        mouseEvent("down", current.startPage, "left", clicks, 0),
        mouseEvent("up", current.startPage, "left", clicks, 0),
      );
    }
  };

  // A desktop browser's mouse and keyboard go to the page as they are.

  const mouseDrag = useRef<{ point: Point; pan: Point } | null>(null);
  const buttonsDown = useRef(0);

  const onMouseDown = (event: ReactPointerEvent<HTMLDivElement>, point: Point) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    if (panMode && zoomed) {
      mouseDrag.current = { point, pan };
      return;
    }
    fieldRef.current?.focus({ preventScroll: true });
    const on = pageAt(point);
    if (!on) return;
    buttonsDown.current += 1;
    sendNow(
      mouseEvent("move", on, "none", 0, modifierBits(event)),
      mouseEvent(
        "down",
        on,
        buttonOf(event.button),
        Math.max(1, event.detail),
        modifierBits(event),
      ),
    );
  };

  const onMouseMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!live) return;
    const point = stagePoint(event);
    if (mouseDrag.current) {
      const drag = mouseDrag.current;
      setPan(
        clampPan(usable, page, scale, {
          x: drag.pan.x + point.x - drag.point.x,
          y: drag.pan.y + point.y - drag.point.y,
        }),
      );
      return;
    }
    const held = (event.buttons & 1) !== 0 && buttonsDown.current > 0;
    const on = held ? pageNear(point) : pageAt(point);
    if (!on) return;
    send(mouseEvent("move", on, held ? "left" : "none", 0, modifierBits(event)));
  };

  const onMouseUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mouseDrag.current) {
      mouseDrag.current = null;
      return;
    }
    if (buttonsDown.current === 0) return;
    buttonsDown.current = Math.max(0, buttonsDown.current - 1);
    const on = pageNear(stagePoint(event));
    sendNow(
      mouseEvent("up", on, buttonOf(event.button), Math.max(1, event.detail), modifierBits(event)),
    );
  };

  // The wheel scrolls the page; with Ctrl (a trackpad's pinch) it zooms the picture here.
  const wheelState = useRef({ placement, page, scale, live, usable, pan, fit });
  wheelState.current = { placement, page, scale, live, usable, pan, fit };
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  useEffect(() => {
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = wheelState.current;
      if (!current.live) return;
      const box = stage.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      if (event.ctrlKey) {
        const next = Math.min(
          MAX_ZOOM,
          Math.max(current.fit, current.scale * Math.exp(-event.deltaY / 100)),
        );
        zoomToRef.current(next, { x: point.x - padding, y: point.y - padding });
        return;
      }
      const on = toPage(point, current.placement, current.page);
      if (!on) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.page.height : 1;
      session?.input({
        type: "mouse",
        action: "wheel",
        x: on.x,
        y: on.y,
        button: "none",
        clicks: 0,
        dx: event.deltaX * unit,
        dy: event.deltaY * unit,
        modifiers: modifierBits(event),
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stage, session, padding]);

  // The hidden text field: the phone's keyboard, a hardware keyboard, paste and dictation.

  const lastValue = useRef(SENTINEL);
  const composing = useRef(false);
  const settleField = () => {
    const field = fieldRef.current;
    if (!field) return;
    field.value = SENTINEL;
    field.setSelectionRange(SENTINEL.length, SENTINEL.length);
    lastValue.current = SENTINEL;
  };
  const flushField = () => {
    const field = fieldRef.current;
    if (!field) return;
    const edit = diffInput(lastValue.current, field.value);
    lastValue.current = field.value;
    const events = editEvents(edit);
    if (events.length > 0) sendNow(...events);
    if (!composing.current) settleField();
  };

  /** Copies the page's selection to this device; called from the tap or the key itself. */
  const copyFromPage = () => {
    if (!session) return;
    const text = session.copy().then((value) => {
      if (value === "") throw new Error("Nothing is selected on the page.");
      return value;
    });
    copyTextLater(text).catch((error: unknown) =>
      setNotice(
        error instanceof RpcFailure
          ? describeFailure(error)
          : error instanceof Error
            ? error.message
            : "Couldn’t copy.",
      ),
    );
  };

  /** Pastes this device's clipboard into the page, or the Mac's when this one cannot be read. */
  const pasteFromPhone = () => {
    let reading: Promise<string>;
    try {
      reading = navigator.clipboard.readText();
    } catch (error) {
      reading = Promise.reject(error);
    }
    reading.then(
      (text) => sendNow(...pasteEvents(text)),
      () => sendNow(keyPress("v", MOD_META)),
    );
  };

  const toggleKeyboard = () => {
    const field = fieldRef.current;
    if (!field) return;
    if (document.activeElement === field) field.blur();
    else field.focus({ preventScroll: true });
  };

  // Navigation

  const run = (action: Promise<void> | undefined) => {
    action?.catch((error: unknown) => setNotice(describeFailure(error)));
  };

  const state = snapshot.state;
  const url = state?.url ?? ("url" in target ? target.url : "");
  const tabs = state?.tabs ?? [];
  const errors = snapshot.console.filter(isConsoleError).length;
  const origin = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();

  const goTo = (typed: string) => {
    const text = typed.trim();
    if (text === "") return;
    let address: string | null = null;
    if (text.startsWith("/") && url.startsWith("http")) address = new URL(text, url).href;
    else address = normalizeAddress(text);
    if (address === null) {
      setNotice("That is not an address. Try localhost:3000 or a full https:// address.");
      return;
    }
    run(session?.navigate(address));
  };

  const title = state?.title || name;
  const offline = link === "open" && agent?.online === false;
  const reconnecting = snapshot.phase === "waiting";

  return (
    <div className="flex h-full min-h-0 flex-col bg-well">
      <header className="flex shrink-0 items-center gap-0.5 border-b bg-background pt-safe pr-[max(0.25rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))] wide:pl-2">
        <Button
          variant="ghost"
          size="icon-touch"
          className="size-11 wide:hidden"
          aria-label="Back to the previews"
          nativeButton={false}
          render={<a href={routes.previews} />}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Back"
          disabled={!live || !state?.can_back}
          onClick={() => run(session?.back())}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Forward"
          disabled={!live || !state?.can_forward}
          onClick={() => run(session?.forward())}
        >
          <ArrowRightIcon />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            goTo(editing ?? "");
            setEditing(null);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-input bg-input/30 px-2.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            {status ?? <LaptopIcon aria-hidden="true" className="size-3.5 shrink-0 text-faint" />}
            <span className="sr-only">Address in the Mac browser</span>
            <input
              type="text"
              name="address"
              inputMode="url"
              enterKeyHint="go"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={editing ?? displayUrl(url)}
              title={title}
              disabled={!live}
              onFocus={(event) => {
                setEditing(url === "about:blank" ? "" : displayUrl(url));
                const input = event.currentTarget;
                window.setTimeout(() => input.select(), 0);
              }}
              onBlur={() => setEditing(null)}
              onChange={(event) => setEditing(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-base outline-none disabled:opacity-60 wide:text-[0.8125rem]"
            />
          </label>
        </form>
        {state?.loading ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Stop loading"
            disabled={!live}
            onClick={() => run(session?.stopLoading())}
          >
            <XIcon />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Reload"
            disabled={!live}
            onClick={(event) => run(session?.reload(event.shiftKey))}
          >
            <RotateCwIcon />
          </Button>
        )}
      </header>

      <div
        ref={setStage}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden touch-none select-none [-webkit-touch-callout:none]",
          fieldFocused && !touchDevice && "outline outline-2 -outline-offset-2 outline-lid/60",
          panMode && zoomed && "cursor-grab active:cursor-grabbing",
        )}
        role="application"
        aria-label={`${title}, in Chrome on your Mac`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => onPointerUp(event, false)}
        onPointerCancel={(event) => onPointerUp(event, true)}
        // Taps never move focus: the keyboard stays up while the owner picks another field.
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas
          ref={(element) => {
            canvasRef.current = element;
            session?.setCanvas(element);
          }}
          aria-hidden="true"
          className={cn(
            "absolute block bg-white",
            fixed && "outline outline-1 outline-border",
            snapshot.picture === null
              ? "opacity-0"
              : snapshot.phase === "live"
                ? null
                : snapshot.phase === "ended" || snapshot.phase === "waiting"
                  ? "opacity-30"
                  : "opacity-0",
          )}
          style={{
            left: placement.left,
            top: placement.top,
            width: page.width * placement.scale,
            height: page.height * placement.scale,
          }}
        />
        {state?.loading && live ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden"
          >
            <div className="h-full w-1/3 bg-lid motion-safe:animate-op-slide" />
          </div>
        ) : null}
        <StageState
          snapshot={snapshot}
          offline={offline}
          reconnecting={reconnecting}
          onReopen={() => session?.reopen()}
          onUsePhone={mode ? () => mode.onChange("phone") : undefined}
        />
        {notice ? (
          <p
            role="status"
            className="pointer-events-none absolute inset-x-3 top-3 mx-auto w-fit max-w-[calc(100%-1.5rem)] rounded-full border bg-popover px-3.5 py-1.5 text-center text-[0.8125rem] leading-5 text-popover-foreground shadow-lg"
          >
            {notice}
          </p>
        ) : null}
        <textarea
          ref={fieldRef}
          aria-label="Type into the page"
          name="page-input"
          rows={1}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="enter"
          data-gramm="false"
          {...{ writingsuggestions: "false" }}
          className="pointer-events-none absolute bottom-2 left-2 h-6 w-6 resize-none overflow-hidden border-0 bg-transparent p-0 text-[16px] text-transparent caret-transparent opacity-0 outline-none"
          onFocus={() => {
            settleField();
            setFieldFocused(true);
          }}
          onBlur={() => {
            composing.current = false;
            setFieldFocused(false);
          }}
          onKeyDown={(event) => {
            const key = keyDownEvent(event.nativeEvent);
            if (!key) return;
            event.preventDefault();
            sendNow(key);
            if (
              key.type === "key" &&
              key.key.toLowerCase() === "c" &&
              (key.modifiers & (MOD_META | 2)) !== 0
            ) {
              copyFromPage();
            }
          }}
          onInput={flushField}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            window.setTimeout(() => {
              composing.current = false;
              flushField();
            }, 0);
          }}
          onPaste={(event) => {
            event.preventDefault();
            sendNow(...pasteEvents(event.clipboardData.getData("text/plain")));
          }}
        />
      </div>

      <DownloadsBar items={snapshot.downloads} onDismiss={(id) => session?.dismissDownload(id)} />

      {touchDevice && fieldFocused ? (
        <KeyRow
          onKey={(key, modifiers) => sendNow(keyPress(key, modifiers))}
          onCopy={() => {
            sendNow(keyPress("c", MOD_META));
            copyFromPage();
          }}
          onPaste={pasteFromPhone}
          onHide={() => fieldRef.current?.blur()}
        />
      ) : (
        <footer className="flex shrink-0 items-center gap-0.5 border-t bg-background pt-1 pr-[max(0.25rem,env(safe-area-inset-right))] pb-[max(0.25rem,env(safe-area-inset-bottom))] pl-[max(0.25rem,env(safe-area-inset-left))]">
          <button
            type="button"
            onClick={() => setViewportOpen(true)}
            className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label={`Viewport: ${viewportLabel(choice)}, Mac browser. Change`}
          >
            <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[0.8125rem] leading-4 font-medium">
                {viewportLabel(choice)}
              </span>
              <span className="truncate font-mono text-[0.6875rem] leading-4 text-faint tabular-nums">
                {`${page.width}×${page.height} ${Math.round(scale * 100)}%`}
              </span>
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Rotate"
            disabled={!fixed}
            onClick={() => setChoice({ ...choice, rotated: !choice.rotated, zoom: null })}
          >
            <RotateCcwIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Zoom out"
            disabled={scale <= fit + 0.005}
            onClick={() => zoomBy(-1)}
          >
            <ZoomOutIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Zoom in"
            disabled={scale >= levels[levels.length - 1] - 0.005}
            onClick={() => zoomBy(1)}
          >
            <ZoomInIcon />
          </Button>
          {zoomed && !touchDevice ? (
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-10", panMode && "bg-secondary text-lid")}
              aria-label="Pan the picture"
              aria-pressed={panMode}
              onClick={() => setPanMode(!panMode)}
            >
              <HandIcon />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="relative size-10"
            aria-label={`Tabs: ${tabs.length}`}
            disabled={tabs.length === 0}
            onClick={() => setTabsOpen(true)}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-5 items-center justify-center rounded-[5px] border-[1.5px] font-mono text-[0.6875rem] leading-none font-bold tabular-nums",
                tabs.length > 1 ? "border-lid text-lid" : "border-current",
              )}
            >
              {Math.min(tabs.length, 99) || 1}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("relative size-10", errors > 0 && "text-destructive")}
            aria-label={`Console: ${errors} ${errors === 1 ? "error" : "errors"}, ${snapshot.console.length} entries`}
            onClick={() => setConsoleOpen(true)}
          >
            <TriangleAlertIcon />
            {errors > 0 ? (
              <span
                aria-hidden="true"
                className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-destructive px-1 font-mono text-[0.625rem] leading-4 font-bold text-background tabular-nums"
              >
                {errors > 99 ? "99+" : errors}
              </span>
            ) : null}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Keyboard"
            aria-pressed={fieldFocused}
            disabled={!live}
            // On the pointer, before focus could move: iOS raises its keyboard only from a tap.
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleKeyboard}
          >
            <KeyboardIcon />
          </Button>
        </footer>
      )}

      <ViewportSheet
        open={viewportOpen}
        onOpenChange={setViewportOpen}
        choice={choice}
        onChoose={(next) => {
          setChoice(next);
          setPanMode(false);
        }}
        pageWidth={choice.viewport === "fit" ? device.width : null}
        mode={mode ? { value: "mac", onChange: mode.onChange, macUnavailable: null } : undefined}
      />
      <ConsoleSheet
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        entries={snapshot.console.map((entry) => ({
          id: entry.id,
          level: entry.level,
          message: entry.text,
          source: entry.source,
          line: entry.line,
          at: entry.at,
        }))}
        scriptPresent
        description="What pages served from your Mac logged in Chrome there, and the requests to them that failed. At most 200 each time a page loads."
        onClear={() => session?.clearConsole()}
      />
      <TabsSheet
        open={tabsOpen}
        onOpenChange={setTabsOpen}
        tabs={tabs}
        onSwitch={(tab) => run(session?.switchTab(tab))}
        onClose={(tab) => run(session?.closeTab(tab))}
      />
      <PageDialog
        dialog={snapshot.dialog}
        origin={origin}
        onReply={(accept, text) => session?.replyDialog(accept, text)}
      />
      <PickerSheet picker={snapshot.picker} onReply={(values) => session?.replyPicker(values)} />
      <FileChooserSheet
        chooser={snapshot.chooser}
        bid={snapshot.bid}
        onReply={(paths) => session?.replyChooser(paths)}
      />
      <CopyNotice />
    </div>
  );
}

type Sample = { at: number; point: Point };

type TouchGesture = {
  kind: "touch";
  sent: boolean;
  start: Point;
  last: Point;
  samples: Sample[];
};

type PressGesture = {
  kind: "press";
  start: Point;
  startPage: Point;
  lastPage: Point;
  scrolling: boolean;
  /** The finger was held, so the mouse button went down and a drag selects. */
  mouseDown: boolean;
  samples: Sample[];
  timer: number;
};

type Gesture =
  | TouchGesture
  | PressGesture
  | { kind: "pinch"; distance: number; mid: Point; scale: number; pan: Point }
  | { kind: "ignored" };

/** The samples of the last tenth of a second, which is what a flick's speed is read from. */
function recent(samples: Sample[]): Sample[] {
  const last = samples[samples.length - 1];
  return samples.filter((sample) => last.at - sample.at <= 100);
}

function velocityOf(samples: Sample[], now: number): Point {
  const first = samples[0];
  const last = samples[samples.length - 1];
  // A finger that stopped before it lifted throws nothing.
  if (!first || !last || now - last.at > 80 || last.at - first.at < 10) return { x: 0, y: 0 };
  const time = last.at - first.at;
  return { x: (last.point.x - first.point.x) / time, y: (last.point.y - first.point.y) / time };
}

function buttonOf(button: number): MouseButton {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

function mouseEvent(
  action: "move" | "down" | "up",
  at: Point,
  button: MouseButton,
  clicks: number,
  modifiers: number,
): BrowserInputEvent {
  return { type: "mouse", action, x: at.x, y: at.y, button, clicks, dx: 0, dy: 0, modifiers };
}

/** The states the stage shows over (or instead of) the picture. */
function StageState({
  snapshot,
  offline,
  reconnecting,
  onReopen,
  onUsePhone,
}: {
  snapshot: SessionSnapshot;
  offline: boolean;
  reconnecting: boolean;
  onReopen: () => void;
  onUsePhone?: () => void;
}) {
  const usePhone = onUsePhone ? (
    <Button variant="secondary" size="touch" onClick={onUsePhone}>
      Use the phone browser
    </Button>
  ) : null;
  let body: ReactNode = null;
  if (offline) {
    body = <MacOffline />;
  } else if (reconnecting) {
    body = <Message busy title="Reconnecting" text="The page opens again where it was." />;
  } else {
    switch (snapshot.phase) {
      case "starting":
        body = (
          <Message
            busy
            title="Starting the browser on your Mac"
            text="Chrome opens in the background there. The first time can take a few seconds."
          />
        );
        break;
      case "live":
        if (snapshot.picture === null) {
          body = <Message busy title="Loading the page" text="The first picture is on its way." />;
        }
        break;
      case "ended":
        body = (
          <Message
            title="This browser session ended"
            text={snapshot.message ?? "Chrome on your Mac closed it."}
            action={
              <Button size="touch" onClick={onReopen}>
                Reopen
              </Button>
            }
          />
        );
        break;
      case "no-chrome":
        body = (
          <Message
            title="Chrome isn’t on your Mac"
            text="The Mac browser runs the page in Google Chrome. Install Chrome on the Mac, then try again."
            action={
              <>
                <Button size="touch" onClick={onReopen}>
                  Try again
                </Button>
                {usePhone}
              </>
            }
          />
        );
        break;
      case "unsupported":
        body = (
          <Message
            title="The Mac browser needs a newer Hako"
            text={`The Hako on your Mac can’t show pages in its browser yet. ${NEEDS_NEWER_HAKO}`}
            action={usePhone}
          />
        );
        break;
      case "failed":
        body = (
          <Message
            title="Couldn’t open the browser on your Mac"
            text={snapshot.message ?? "Try again in a moment."}
            action={
              <>
                <Button size="touch" onClick={onReopen}>
                  Try again
                </Button>
                {usePhone}
              </>
            }
          />
        );
        break;
      case "waiting":
        break;
    }
  }
  if (body === null) return null;
  return (
    <div
      className="absolute inset-0 overflow-y-auto bg-well/80"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {body}
    </div>
  );
}

function Message({
  title,
  text,
  busy = false,
  action,
}: {
  title: string;
  text: string;
  busy?: boolean;
  action?: ReactNode;
}) {
  return (
    <Empty className="h-full py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">{busy ? <Spinner /> : <LaptopIcon />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
      {action ? <div className="flex flex-wrap justify-center gap-2">{action}</div> : null}
    </Empty>
  );
}

const ROW_KEYS: { label: ReactNode; name: string; key: string; repeat?: boolean }[] = [
  { label: "tab", name: "Tab", key: "Tab" },
  { label: "esc", name: "Escape", key: "Escape" },
  { label: <ArrowLeftIcon />, name: "Left", key: "ArrowLeft", repeat: true },
  { label: <ArrowUpIcon />, name: "Up", key: "ArrowUp", repeat: true },
  { label: <ArrowDownIcon />, name: "Down", key: "ArrowDown", repeat: true },
  { label: <ArrowRightIcon />, name: "Right", key: "ArrowRight", repeat: true },
];

/** The keys a phone keyboard lacks, above it while it is up, as the terminal has them. */
function KeyRow({
  onKey,
  onCopy,
  onPaste,
  onHide,
}: {
  onKey: (key: string, modifiers?: number) => void;
  onCopy: () => void;
  onPaste: () => void;
  onHide: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Keys"
      className="flex shrink-0 gap-0.5 overflow-x-auto border-t bg-background px-[max(0.375rem,env(safe-area-inset-left))] py-1.5 [scrollbar-width:none]"
    >
      {ROW_KEYS.map((item) => (
        <KeyButton
          key={item.name}
          aria-label={item.name}
          repeat={item.repeat}
          className="min-w-8 flex-1 px-0"
          onPress={() => onKey(item.key)}
        >
          {item.label}
        </KeyButton>
      ))}
      <KeyButton
        aria-label="Command A, select all"
        className="min-w-9 flex-1 px-0"
        onPress={() => onKey("a", MOD_META)}
      >
        ⌘A
      </KeyButton>
      <button
        type="button"
        aria-label="Command C, copy to this phone"
        className={cn(keyClasses(), "min-w-9 flex-1 px-0")}
        // A button, not a key: the copy has to start in the tap itself.
        onPointerDown={(event) => event.preventDefault()}
        onClick={onCopy}
      >
        ⌘C
      </button>
      <button
        type="button"
        aria-label="Command V, paste from this phone"
        className={cn(keyClasses(), "min-w-9 flex-1 px-0")}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onPaste}
      >
        ⌘V
      </button>
      <KeyButton
        aria-label="Command Z, undo"
        className="min-w-9 flex-1 px-0"
        onPress={() => onKey("z", MOD_META)}
      >
        ⌘Z
      </KeyButton>
      <button
        type="button"
        aria-label="Hide the keyboard"
        className={cn(keyClasses("accent"), "min-w-9 flex-1 px-0")}
        // On the click, not the pointer: the footer that takes this row's place must not receive
        // the click that ends this tap.
        onPointerDown={(event) => event.preventDefault()}
        onClick={onHide}
      >
        <KeyboardOffIcon />
      </button>
    </div>
  );
}
