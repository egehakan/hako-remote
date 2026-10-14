import {
  isSameOriginPath,
  PREVIEW_MESSAGE_TYPE,
  type Preview,
  type PreviewPageMessage,
} from "@shared/previews";
import {
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ExternalLinkIcon,
  HandIcon,
  MonitorSmartphoneIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MacOffline } from "@/components/mac-offline";
import { MacViewer } from "@/components/previews/mac-viewer";
import { ConsoleSheet, type ConsoleEntry } from "@/components/previews/console-sheet";
import { StatusDot } from "@/components/previews/preview-list";
import { ViewportSheet } from "@/components/previews/viewport-sheet";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { readMode, useMacBrowserSupport, type ViewerMode, writeMode } from "@/lib/browser/support";
import { describeFailure, NEEDS_NEWER_HAKO } from "@/lib/errors";
import { useConnection } from "@/lib/hooks";
import { previewTicket, restartPreview, usePreviews } from "@/lib/previews/store";
import {
  fitScale,
  readChoice,
  type ViewChoice,
  viewportLabel,
  viewportSize,
  writeChoice,
  zoomLevels,
} from "@/lib/previews/viewports";
import { routes } from "@/lib/route";
import { cn } from "@/lib/utils";

/** Room left around a page shown at a fixed size, so its edges can be seen (`p-3`). */
const STAGE_PADDING = 12;
const CONSOLE_KEPT = 200;

type PageState = { url: string; title: string; width: number; height: number };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a message's origin is one of this preview's: its own name or `<id>--<port>`, under the
 * domain and on the scheme and port of the address the relay gave for it.
 */
function previewOriginTest(ticketUrl: string, id: string): (origin: string) => boolean {
  const url = new URL(ticketUrl);
  const domain = url.hostname.slice(id.length + 1);
  const pattern = new RegExp(
    `^${escapeRegExp(url.protocol)}//${escapeRegExp(id)}(?:--\\d{1,5})?\\.${escapeRegExp(domain)}${url.port ? `:${url.port}` : ""}$`,
  );
  return (origin) => pattern.test(origin);
}

function readPageMessage(data: unknown): PreviewPageMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type !== PREVIEW_MESSAGE_TYPE) return null;
  if (message.kind === "location" && typeof message.url === "string") {
    return {
      type: PREVIEW_MESSAGE_TYPE,
      kind: "location",
      url: message.url.slice(0, 4000),
      title: typeof message.title === "string" ? message.title.slice(0, 300) : "",
      width: Number(message.width) || 0,
      height: Number(message.height) || 0,
    };
  }
  if (message.kind === "console" && typeof message.message === "string") {
    return {
      type: PREVIEW_MESSAGE_TYPE,
      kind: "console",
      level: message.level === "warn" ? "warn" : "error",
      message: message.message.slice(0, 2000),
      source: typeof message.source === "string" ? message.source.slice(0, 2000) : null,
      line: typeof message.line === "number" ? message.line : null,
    };
  }
  return null;
}

/** What the path field shows: the path on the main origin, or the whole address elsewhere. */
function displayPath(url: string, mainOrigin: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin === mainOrigin) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return url;
  } catch {
    return url;
  }
}

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

/** One preview in a frame, at the size the owner chose, with a browser's controls around it. */
export function PreviewViewer({ id }: { id: string }) {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const offline = link === "open" && agent?.online === false;
  const { previews, support } = usePreviews();
  const preview = previews?.find((item) => item.id === id) ?? null;

  if (offline)
    return (
      <ViewerShell title={id}>
        <MacOffline />
      </ViewerShell>
    );
  if (support === "no") {
    return (
      <ViewerShell title={id}>
        <ViewerState
          title="Previews need a newer Hako"
          text={`The Hako on your Mac can’t run previews yet. ${NEEDS_NEWER_HAKO}`}
        />
      </ViewerShell>
    );
  }
  if (previews === null || !online) {
    return (
      <ViewerShell title={id}>
        <div
          className="flex h-full items-center justify-center"
          aria-busy="true"
          aria-label="Loading…"
        >
          <Spinner />
        </div>
      </ViewerShell>
    );
  }
  if (preview === null) {
    return (
      <ViewerShell title={id}>
        <ViewerState
          title={`No preview called ${id}`}
          text="It may have been removed on your Mac. The list shows the ones that are there."
          action={
            <Button
              variant="secondary"
              size="touch"
              nativeButton={false}
              render={<a href={routes.previews} />}
            >
              Show previews
            </Button>
          }
        />
      </ViewerShell>
    );
  }
  if (preview.status !== "running") return <NotRunning preview={preview} />;
  return <RunningPreview key={preview.id} preview={preview} />;
}

/**
 * A running preview, in the browser chosen for it: Chrome on the Mac (the default), or this
 * browser through the preview's own address. An app without the Mac browser gets this browser.
 */
function RunningPreview({ preview }: { preview: Preview }) {
  const support = useMacBrowserSupport();
  const [mode, setModeState] = useState<ViewerMode>(() => readMode(preview.id));
  const setMode = (next: ViewerMode) => {
    setModeState(next);
    writeMode(preview.id, next);
  };
  if (mode === "mac" && support !== "no") {
    return (
      <MacViewer
        target={{ previewId: preview.id }}
        name={preview.name}
        choiceKey={preview.id}
        runKey={`${preview.port}:${preview.started}`}
        mode={{ onChange: setMode }}
        status={<StatusDot status={preview.status} />}
      />
    );
  }
  return (
    <RunningViewer
      preview={preview}
      mode={{
        value: "phone",
        onChange: setMode,
        macUnavailable: support === "no" ? NEEDS_NEWER_HAKO : null,
      }}
    />
  );
}

function ViewerShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b bg-background pt-safe pr-[max(1rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))] wide:pl-4">
        <BackToList />
        <h1 className="min-w-0 flex-1 truncate py-3.5 text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
          {title}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function BackToList() {
  return (
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
  );
}

function ViewerState({
  title,
  text,
  busy = false,
  action,
}: {
  title: string;
  text: string;
  busy?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <Empty className="h-full py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">{busy ? <Spinner /> : <AppWindowIcon />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
      {action ? <div className="flex flex-wrap justify-center gap-2">{action}</div> : null}
    </Empty>
  );
}

function NotRunning({ preview }: { preview: Preview }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await restartPreview(preview.id);
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };
  const logs = preview.session_id ? (
    <Button
      variant="secondary"
      size="touch"
      nativeButton={false}
      render={<a href={routes.terminal(preview.session_id)} />}
    >
      <ScrollTextIcon data-icon="inline-start" />
      Show logs
    </Button>
  ) : null;
  const restartButton = (
    <Button size="touch" disabled={busy} onClick={() => void restart()}>
      {busy ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
      Restart
    </Button>
  );
  const body =
    preview.status === "starting" ? (
      <ViewerState
        busy
        title={`Starting ${preview.name}`}
        text="Its dev server is starting on your Mac. The page opens here as soon as it answers."
        action={logs}
      />
    ) : (
      <ViewerState
        title={
          preview.status === "failed" ? `${preview.name} failed` : `${preview.name} is stopped`
        }
        text={
          error ??
          preview.message ??
          (preview.status === "failed"
            ? "Its dev server did not start."
            : "Its dev server is not running.")
        }
        action={
          <>
            {restartButton}
            {logs}
          </>
        }
      />
    );
  return <ViewerShell title={preview.name}>{body}</ViewerShell>;
}

function RunningViewer({
  preview,
  mode,
}: {
  preview: Preview;
  mode: { value: ViewerMode; onChange: (mode: ViewerMode) => void; macUnavailable: string | null };
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const space = useStageSize(stage);
  const [choice, setChoiceState] = useState<ViewChoice>(() => readChoice(preview.id));
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [frameOrigin, setFrameOrigin] = useState<string | null>(null);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [viewportOpen, setViewportOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const nextEntry = useRef(1);

  const setChoice = useCallback(
    (next: ViewChoice) => {
      setChoiceState(next);
      writeChoice(preview.id, next);
    },
    [preview.id],
  );

  const open = useCallback(
    (path: string) => {
      setLoadError(null);
      previewTicket(preview.id, path).then(
        (url) => {
          setPage(null);
          setFrameOrigin(null);
          setSrc(url);
        },
        (error: Error) => setLoadError(error.message),
      );
    },
    [preview.id],
  );

  useEffect(() => {
    open(isSameOriginPath(preview.url_path) ? preview.url_path : "/");
  }, [open, preview.url_path]);

  const mainOrigin = src ? new URL(src).origin : null;
  const isPreviewOrigin = useMemo(
    () => (src ? previewOriginTest(src, preview.id) : () => false),
    [src, preview.id],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || !isPreviewOrigin(event.origin))
        return;
      const message = readPageMessage(event.data);
      if (!message) return;
      setFrameOrigin(event.origin);
      if (message.kind === "location") {
        setPage({
          url: message.url,
          title: message.title,
          width: message.width,
          height: message.height,
        });
      } else {
        const entry: ConsoleEntry = {
          id: nextEntry.current++,
          level: message.level,
          message: message.message,
          source: message.source,
          line: message.line,
          at: Date.now(),
        };
        setEntries((current) => [...current, entry].slice(-CONSOLE_KEPT));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isPreviewOrigin]);

  /** Sends a command to the page; without the client script in it, does the next best thing. */
  const command = (kind: "back" | "forward" | "reload" | "navigate", path?: string) => {
    const target = frameRef.current?.contentWindow;
    if (target && frameOrigin) {
      target.postMessage(
        { type: PREVIEW_MESSAGE_TYPE, kind, ...(path ? { path } : {}) },
        frameOrigin,
      );
      return;
    }
    if (kind === "reload") open(page && mainOrigin ? displayPath(page.url, mainOrigin) : "/");
    else if (kind === "navigate" && path) open(path);
  };

  const size = viewportSize(choice);
  const usable = {
    width: Math.max(0, space.width - STAGE_PADDING * 2),
    height: Math.max(0, space.height - STAGE_PADDING * 2),
  };
  const fit = size ? fitScale(size, usable) : 1;
  const levels = zoomLevels(fit);
  const scale = size ? (choice.zoom ?? fit) : 1;
  const zoomIndex = levels.findIndex((level) => Math.abs(level - scale) < 0.005);
  const zoomBy = (step: 1 | -1) => {
    const from = zoomIndex === -1 ? levels.findLastIndex((level) => level < scale) : zoomIndex;
    const next = levels[Math.min(levels.length - 1, Math.max(0, from + step))];
    setChoice({ ...choice, zoom: next === fit ? null : next });
    if (next === fit) setPanning(false);
  };
  const zoomed = size !== null && scale > fit + 0.005;
  const errors = entries.filter((entry) => entry.level === "error").length;

  const path = page && mainOrigin ? displayPath(page.url, mainOrigin) : preview.url_path;

  const openAlone = () => {
    // Opened in the tap itself, which a browser allows, and pointed at the preview once the relay
    // has given an address for it.
    const opened = window.open("", "_blank");
    if (opened) opened.opener = null;
    previewTicket(preview.id, isSameOriginPath(path) ? path : "/").then(
      (url) => {
        if (opened) opened.location.href = url;
        else window.location.href = url;
      },
      (error: Error) => {
        opened?.close();
        setLoadError(error.message);
      },
    );
  };

  // Dragging with a mouse pans a page that is larger than the stage; touch scrolls by itself.
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPanDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    drag.current = { x: event.clientX, y: event.clientY };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPanMove = (event: PointerEvent) => {
    if (!drag.current || !scrollerRef.current) return;
    scrollerRef.current.scrollBy(drag.current.x - event.clientX, drag.current.y - event.clientY);
    drag.current = { x: event.clientX, y: event.clientY };
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-well">
      <header className="flex shrink-0 items-center gap-0.5 border-b bg-background pt-safe pr-[max(0.25rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))] wide:pl-2">
        <BackToList />
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Back"
          onClick={() => command("back")}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Forward"
          onClick={() => command("forward")}
        >
          <ArrowRightIcon />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            const value = (editing ?? "").trim();
            const target = value.startsWith("/") ? value : `/${value}`;
            if (isSameOriginPath(target)) command("navigate", target);
            setEditing(null);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-input bg-input/30 px-2.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            <StatusDot status={preview.status} />
            <span className="sr-only">Address in {preview.name}</span>
            <input
              type="text"
              name="address"
              inputMode="url"
              enterKeyHint="go"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={editing ?? path}
              title={page?.title || preview.name}
              onFocus={(event) => {
                setEditing(path);
                event.currentTarget.select();
              }}
              onBlur={() => setEditing(null)}
              onChange={(event) => setEditing(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-base outline-none wide:text-[0.8125rem]"
            />
          </label>
        </form>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Reload"
          onClick={() => command("reload")}
        >
          <RotateCwIcon />
        </Button>
      </header>

      <div ref={setStage} className="relative min-h-0 flex-1">
        {loadError ? (
          <ViewerState
            title="Couldn’t open the preview"
            text={loadError}
            action={
              <Button variant="secondary" size="touch" onClick={() => open(path)}>
                Try again
              </Button>
            }
          />
        ) : (
          <div
            ref={scrollerRef}
            className={cn(
              "absolute inset-0 flex",
              size ? "overflow-auto overscroll-contain p-3" : "overflow-hidden",
            )}
          >
            <div
              className="relative m-auto shrink-0"
              style={
                size
                  ? { width: size.width * scale, height: size.height * scale }
                  : { width: "100%", height: "100%" }
              }
            >
              {src ? (
                <iframe
                  ref={frameRef}
                  key={src}
                  src={src}
                  title={page?.title || preview.name}
                  allow="clipboard-write; fullscreen"
                  className={cn(
                    "block border-0 bg-white",
                    size && "origin-top-left outline outline-1 outline-border",
                  )}
                  style={
                    size
                      ? { width: size.width, height: size.height, transform: `scale(${scale})` }
                      : { width: "100%", height: "100%" }
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center" aria-busy="true">
                  <Spinner />
                </div>
              )}
              {panning && zoomed ? (
                <div
                  aria-hidden="true"
                  className="absolute inset-0 cursor-grab touch-pan-x touch-pan-y active:cursor-grabbing"
                  onPointerDown={onPanDown}
                  onPointerMove={onPanMove}
                  onPointerUp={() => (drag.current = null)}
                  onPointerCancel={() => (drag.current = null)}
                />
              ) : null}
            </div>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-0.5 border-t bg-background pr-[max(0.25rem,env(safe-area-inset-right))] pb-[max(0.25rem,env(safe-area-inset-bottom))] pl-[max(0.25rem,env(safe-area-inset-left))] pt-1">
        <button
          type="button"
          onClick={() => setViewportOpen(true)}
          className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={`Viewport: ${viewportLabel(choice)}. Change`}
        >
          <MonitorSmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[0.8125rem] leading-4 font-medium">
              {viewportLabel(choice)}
            </span>
            <span className="truncate font-mono text-[0.6875rem] leading-4 text-faint tabular-nums">
              {size
                ? `${size.width}×${size.height} ${Math.round(scale * 100)}%`
                : page && page.width > 0
                  ? `${page.width}×${page.height}`
                  : "Phone browser"}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Rotate"
          disabled={!size}
          onClick={() => setChoice({ ...choice, rotated: !choice.rotated, zoom: null })}
        >
          <RotateCcwIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Zoom out"
          disabled={!size || scale <= fit + 0.005}
          onClick={() => zoomBy(-1)}
        >
          <ZoomOutIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Zoom in"
          disabled={!size || scale >= levels[levels.length - 1] - 0.005}
          onClick={() => zoomBy(1)}
        >
          <ZoomInIcon />
        </Button>
        {zoomed ? (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-10", panning && "bg-secondary text-lid")}
            aria-label="Pan the page"
            aria-pressed={panning}
            onClick={() => setPanning(!panning)}
          >
            <HandIcon />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative size-10", errors > 0 && "text-destructive")}
          aria-label={`Console: ${errors} ${errors === 1 ? "error" : "errors"}, ${entries.length - errors} warnings`}
          onClick={() => setConsoleOpen(true)}
        >
          <TriangleAlertIcon />
          {entries.length > 0 ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-0.5 right-0.5 min-w-4 rounded-full px-1 font-mono text-[0.625rem] leading-4 font-bold tabular-nums",
                errors > 0 ? "bg-destructive text-background" : "bg-amber text-primary-foreground",
              )}
            >
              {entries.length > 99 ? "99+" : entries.length}
            </span>
          ) : null}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Open on its own"
          onClick={openAlone}
        >
          <ExternalLinkIcon />
        </Button>
      </footer>

      <ViewportSheet
        open={viewportOpen}
        onOpenChange={setViewportOpen}
        choice={choice}
        onChoose={(next) => {
          setChoice(next);
          setPanning(false);
        }}
        pageWidth={choice.viewport === "fit" ? (page?.width ?? null) : null}
        mode={mode}
      />
      <ConsoleSheet
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        entries={entries}
        scriptPresent={frameOrigin !== null}
        onClear={() => setEntries([])}
      />
    </div>
  );
}
