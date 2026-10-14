import { CircleAlertIcon, FileSearchIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { formatSize } from "@/lib/files/format";
import type { PreviewKind } from "@/lib/files/preview";
import { LARGE_DOWNLOAD_BYTES } from "@/lib/transfers/actions";
import { describeTransferFailure, fraction, progressLabel } from "@/lib/transfers/describe";
import { transfers, useTransfers, useTransferSupport } from "@/lib/transfers/store";

import { Working } from "./preview-states";

const PdfView = lazy(() => import("./pdf-view"));
const DocxView = lazy(() => import("./docx-view"));
const SheetView = lazy(() => import("./sheet-view"));
const SlidesView = lazy(() => import("./slides-view"));

type DocumentPreviewProps = {
  path: string;
  name: string;
  size: number;
  kind: PreviewKind;
  /** What can still be done with the file, shown when it can't be previewed. */
  fallback: ReactNode;
};

/** A document fetched whole from the Mac and drawn here: a PDF, Word, a spreadsheet or slides. */
export default function DocumentPreview({
  path,
  name,
  size,
  kind,
  fallback,
}: DocumentPreviewProps) {
  const group = `preview:${path}`;
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const items = useTransfers(group);
  const item = items[0] ?? null;
  const { limits } = useTransferSupport();

  // A large file is fetched only once the owner has seen its size.
  const [started, setStarted] = useState(size <= LARGE_DOWNLOAD_BYTES);
  useEffect(() => {
    if (!started) return;
    transfers.addDownload({ group, path, name, size });
    return () => transfers.drop(group);
  }, [started, group, path, name, size]);

  // The file becomes the one block of bytes the preview reads, and the queue lets go of its copy.
  const done = item?.state === "done" ? item.downloaded : null;
  useEffect(() => {
    if (!done) return;
    let cancelled = false;
    void done.blob.arrayBuffer().then((buffer) => {
      if (cancelled) return;
      setBytes(new Uint8Array(buffer));
      transfers.drop(group);
    });
    return () => {
      cancelled = true;
    };
  }, [done, group]);

  if (!started) {
    return (
      <Empty className="min-h-0 py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileSearchIcon />
          </EmptyMedia>
          <EmptyTitle>A large file to preview</EmptyTitle>
          <EmptyDescription>
            {name} is {formatSize(size)}. A preview fetches all of it into this device’s memory
            first.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="touch" onClick={() => setStarted(true)}>
            Fetch {formatSize(size)} and preview
          </Button>
          {fallback}
        </EmptyContent>
      </Empty>
    );
  }

  if (bytes) {
    return (
      <Suspense fallback={<Working label="Opening the preview…" />}>
        {kind === "pdf" ? (
          <PdfView data={bytes} />
        ) : kind === "docx" ? (
          <DocxView data={bytes} fallback={fallback} />
        ) : kind === "sheet" ? (
          <SheetView source={{ bytes, name }} fallback={fallback} />
        ) : (
          <SlidesView data={bytes} fallback={fallback} />
        )}
      </Suspense>
    );
  }

  if (item?.state === "failed" || item?.state === "cancelled") {
    return (
      <Empty className="min-h-0 py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Couldn’t fetch it for a preview</EmptyTitle>
          <EmptyDescription>
            {item.state === "cancelled"
              ? "Cancelled."
              : describeTransferFailure(item, limits.maxBytes)}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {item.error?.code === "too_large" ? null : (
            <Button variant="secondary" size="touch" onClick={() => transfers.retry(item.id)}>
              Try again
            </Button>
          )}
          {fallback}
        </EmptyContent>
      </Empty>
    );
  }

  const part = item ? fraction(item) : null;
  return (
    <Empty className="min-h-0 py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileSearchIcon />
        </EmptyMedia>
        <EmptyTitle>Fetching for a preview</EmptyTitle>
        <EmptyDescription className="tabular-nums">
          {item?.state === "paused"
            ? "Paused: no connection to your Mac. It goes on by itself."
            : item && item.moved > 0
              ? progressLabel(item)
              : `${formatSize(size)} from your Mac`}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div
          role="progressbar"
          aria-label={`Fetching ${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={part === null ? undefined : Math.round(part * 100)}
          className="h-1 w-48 overflow-hidden rounded-full bg-input/60"
        >
          <div
            className="h-full origin-left bg-amber transition-transform duration-200 ease-out"
            style={{ transform: `scaleX(${part ?? 0})` }}
          />
        </div>
      </EmptyContent>
    </Empty>
  );
}
