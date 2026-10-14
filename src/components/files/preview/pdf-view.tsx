import { MinusIcon, PlusIcon } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PreviewFailed, Working } from "./preview-states";

/** Pages drawn at once, around the one on screen; the rest give their memory back. */
const KEEP_RADIUS = 3;
/** The most pixels one page's canvas may hold, which keeps an iPhone within its canvas memory. */
const MAX_CANVAS_PIXELS = 8_000_000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const PAGE_GAP = 12;
const COPY_UP_TO = 32 * 1024 * 1024;

type PdfViewProps = { data: Uint8Array };

/** A PDF, every page, drawn only as it comes near the screen; two fingers zoom. */
export default function PdfView({ data }: PdfViewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [aspect, setAspect] = useState(1.294);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | null = null;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        if (data.buffer.byteLength === 0) throw new Error("Open the file again to see it.");
        // The worker takes the bytes it is given. A small file goes as a copy, so these stay
        // usable; a large one goes as it is, so it is never in memory twice.
        const source = data.byteLength <= COPY_UP_TO ? data.slice() : data;
        loading = pdfjs.getDocument({ data: source, enableXfa: false });
        const opened = await loading.promise;
        if (cancelled) return;
        const first = await opened.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        setAspect(viewport.height / viewport.width);
        setDoc(opened);
      } catch (error) {
        if (cancelled) return;
        const name = (error as { name?: string }).name;
        setProblem(
          name === "PasswordException"
            ? "This PDF has a password, which this preview can’t ask for."
            : `It doesn’t read as a PDF: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
      void loading?.destroy();
    };
  }, [data]);

  if (problem) return <PreviewFailed reason={problem} fallback={null} />;
  if (!doc) return <Working label="Reading the PDF…" />;
  return <Pages doc={doc} aspect={aspect} />;
}

function Pages({ doc, aspect }: { doc: PDFDocumentProxy; aspect: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const pinch = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const pending = useRef<{ zoom: number; x: number; y: number } | null>(null);
  const count = doc.numPages;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(0, element.clientWidth - 24));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pageWidth = Math.round(width * zoom);
  const heightOf = useCallback(
    (number: number) => Math.round(pageWidth * (aspects[number] ?? aspect)),
    [pageWidth, aspects, aspect],
  );
  const setPageAspect = useCallback((number: number, value: number) => {
    setAspects((before) => (before[number] === value ? before : { ...before, [number]: value }));
  }, []);

  // Which page is on screen: the one under the middle of the view.
  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const middle = element.scrollTop + element.clientHeight / 2;
    let top = 12;
    for (let number = 1; number <= count; number++) {
      const bottom = top + heightOf(number) + PAGE_GAP;
      if (middle < bottom) {
        setCurrent(number);
        return;
      }
      top = bottom;
    }
    setCurrent(count);
  };

  /** Zooms to `next`, keeping the point at (x, y) of the view where it was. */
  const zoomTo = (next: number, x?: number, y?: number) => {
    const element = scroller.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (!element || clamped === zoom) return;
    pending.current = {
      zoom: clamped / zoom,
      x: x ?? element.clientWidth / 2,
      y: y ?? element.clientHeight / 2,
    };
    setZoom(clamped);
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    const change = pending.current;
    if (!element || !change) return;
    pending.current = null;
    element.scrollLeft = (element.scrollLeft + change.x) * change.zoom - change.x;
    element.scrollTop = (element.scrollTop + change.y) * change.zoom - change.y;
  }, [zoom]);

  // Two fingers zoom the pages, drawn sharp again once they let go; one finger scrolls.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const spread = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const box = element.getBoundingClientRect();
      pinch.current = {
        distance: spread(event.touches),
        zoom,
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2 - box.left,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2 - box.top,
      };
    };
    const move = (event: TouchEvent) => {
      const gesture = pinch.current;
      if (!gesture || event.touches.length !== 2) return;
      event.preventDefault();
      const scale = spread(event.touches) / gesture.distance;
      const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, gesture.zoom * scale));
      const live = target / gesture.zoom;
      if (column.current) {
        column.current.style.transformOrigin = `${gesture.x + element.scrollLeft}px ${gesture.y + element.scrollTop}px`;
        column.current.style.transform = `scale(${live})`;
      }
    };
    const end = (event: TouchEvent) => {
      const gesture = pinch.current;
      if (!gesture || event.touches.length >= 2) return;
      pinch.current = null;
      const live = column.current?.style.transform.match(/scale\(([\d.]+)\)/);
      if (column.current) column.current.style.transform = "";
      if (live) zoomTo(gesture.zoom * Number(live[1]), gesture.x, gesture.y);
    };
    // Safari's own page zoom would take the gesture otherwise.
    const block = (event: Event) => event.preventDefault();
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", end);
    element.addEventListener("gesturestart", block);
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", end);
      element.removeEventListener("gesturestart", block);
    };
  });

  const pages = [];
  for (let number = 1; number <= count; number++) {
    pages.push(
      <Page
        key={number}
        doc={doc}
        number={number}
        width={pageWidth}
        height={heightOf(number)}
        near={Math.abs(number - current) <= KEEP_RADIUS}
        onAspect={setPageAspect}
      />,
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-muted/40 [touch-action:pan-x_pan-y]"
        onScroll={onScroll}
        onWheel={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          zoomTo(
            zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
            event.clientX - box.left,
            event.clientY - box.top,
          );
        }}
      >
        <div
          ref={column}
          className="flex flex-col items-center p-3"
          style={{ gap: PAGE_GAP, width: pageWidth + 24, minWidth: "100%" }}
        >
          {width > 0 ? pages : null}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-card/95 py-0.5 pr-0.5 pl-3.5 text-xs tabular-nums shadow-sm">
          <span role="status" aria-live="polite">
            Page {current} of {count}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomTo(zoom / 1.5)}
          >
            <MinusIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomTo(zoom * 1.5)}
          >
            <PlusIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

type PageProps = {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  /** True for a page close enough to the screen to be drawn. */
  near: boolean;
  onAspect: (number: number, aspect: number) => void;
};

const Page = memo(function Page({ doc, number, width, height, near, onAspect }: PageProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (!near || width === 0) {
      // A page far away holds no pixels.
      element.width = 0;
      element.height = 0;
      setDrawn(false);
      return;
    }
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        onAspect(number, natural.height / natural.width);
        const ratio = window.devicePixelRatio || 1;
        let scale = (width / natural.width) * ratio;
        const pixels = natural.width * natural.height * scale * scale;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const viewport = page.getViewport({ scale });
        element.width = Math.floor(viewport.width);
        element.height = Math.floor(viewport.height);
        task = page.render({ canvas: element, viewport });
        await task.promise;
        if (!cancelled) setDrawn(true);
      } catch {
        // A cancelled render, or a page that would not draw: it stays a blank sheet.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, width, near, onAspect]);

  return (
    <div
      className="relative shrink-0 bg-white shadow-sm ring-1 ring-black/10"
      style={{ width, height }}
      aria-label={`Page ${number}`}
      role="img"
    >
      <canvas ref={canvas} className="block size-full" />
      {drawn ? null : (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400">
          {number}
        </span>
      )}
    </div>
  );
});
