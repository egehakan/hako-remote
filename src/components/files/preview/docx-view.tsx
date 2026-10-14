import { InfoIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cleanHtml } from "@/lib/files/sanitize-html";
import { PreviewFailed, Working } from "./preview-states";

type DocxViewProps = { data: Uint8Array; fallback: ReactNode };

type Converted = { fragment: DocumentFragment; simplified: boolean };

/** A Word document's text, headings, lists, tables and pictures, as safe HTML. */
export default function DocxView({ data, fallback }: DocxViewProps) {
  const [converted, setConverted] = useState<Converted | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { default: mammoth } = await import("mammoth/mammoth.browser.min.js");
        const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer as ArrayBuffer },
          { externalFileAccess: false },
        );
        if (cancelled) return;
        setConverted({
          fragment: cleanHtml(result.value, new DOMParser(), document),
          simplified: result.messages.length > 0,
        });
      } catch {
        if (!cancelled) {
          setProblem(
            "It doesn’t read as a Word document (.docx). It may be damaged, or another kind of file under this name.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(() => {
    const element = host.current;
    if (!element || !converted) return;
    element.replaceChildren(converted.fragment.cloneNode(true));
  }, [converted]);

  if (problem) return <PreviewFailed reason={problem} fallback={fallback} />;
  if (!converted) return <Working label="Reading the document…" />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {converted.simplified ? (
        <p className="flex items-center gap-2 border-b px-safe py-2 text-[0.8125rem] leading-5 text-muted-foreground">
          <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
          Some formatting is simplified here.
        </p>
      ) : null}
      <article
        ref={host}
        className="markdown mx-auto max-w-[44rem] px-safe py-6 wide:px-8"
        translate="no"
      />
    </div>
  );
}
