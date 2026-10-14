import { InfoIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { pictureType, readSlides, type Slide } from "@/lib/files/pptx";
import { PreviewFailed, Working } from "./preview-states";

type SlidesViewProps = { data: Uint8Array; fallback: ReactNode };

type Deck = { slides: Slide[]; pictures: Map<string, string> };

/** A deck's slides in order, each with its words and pictures; the layout is not kept. */
export default function SlidesView({ data, fallback }: SlidesViewProps) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const pictures = new Map<string, string>();
    void (async () => {
      try {
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(data);
        const parser = new DOMParser();
        const slides = await readSlides(
          {
            text: async (path) => (await zip.file(path)?.async("string")) ?? null,
            has: (path) => zip.file(path) !== null,
          },
          (text) => parser.parseFromString(text, "application/xml"),
        );
        // Pictures become addresses of bytes held in this page, which load nothing from elsewhere.
        for (const slide of slides) {
          for (const block of slide.blocks) {
            if (block.kind !== "image" || pictures.has(block.path)) continue;
            const bytes = await zip.file(block.path)?.async("uint8array");
            const mime = pictureType(block.path);
            if (bytes && mime) {
              pictures.set(
                block.path,
                URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })),
              );
            }
          }
        }
        if (cancelled) return;
        setDeck({ slides, pictures });
      } catch {
        if (!cancelled) {
          setProblem(
            "It doesn’t read as a PowerPoint file (.pptx). It may be damaged, or another kind of file under this name.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const url of pictures.values()) URL.revokeObjectURL(url);
    };
  }, [data]);

  if (problem) return <PreviewFailed reason={problem} fallback={fallback} />;
  if (!deck) return <Working label="Reading the slides…" />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-muted/40">
      <p className="flex items-center gap-2 border-b bg-background px-safe py-2 text-[0.8125rem] leading-5 text-muted-foreground">
        <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
        The layout is simplified: each slide’s text and pictures, in order.
      </p>
      <ol className="mx-auto flex max-w-[44rem] flex-col gap-4 px-safe py-4 wide:px-8">
        {deck.slides.map((slide) => (
          <li key={slide.number} className="rounded-xl border bg-card p-4" translate="no">
            <p className="mb-2 font-mono text-[0.6875rem] text-faint">
              Slide {slide.number} of {deck.slides.length}
            </p>
            {slide.title ? (
              <h2 className="mb-3 text-lg leading-7 font-semibold text-balance">{slide.title}</h2>
            ) : null}
            <div className="flex flex-col gap-3 text-[0.9375rem] leading-6">
              {slide.blocks.map((block, index) =>
                block.kind === "text" ? (
                  <div key={index} className="flex flex-col gap-1.5">
                    {block.paragraphs.map((paragraph, line) => (
                      <p key={line} className="whitespace-pre-line">
                        {paragraph}
                      </p>
                    ))}
                  </div>
                ) : block.kind === "image" ? (
                  deck.pictures.has(block.path) ? (
                    <img
                      key={index}
                      src={deck.pictures.get(block.path)}
                      alt={block.alt}
                      loading="lazy"
                      className="max-h-[60vh] max-w-full self-start rounded-md object-contain"
                    />
                  ) : null
                ) : (
                  <div key={index} className="overflow-x-auto">
                    <table className="border-collapse text-sm">
                      <tbody>
                        {block.rows.map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                              <td
                                key={cellIndex}
                                className="border px-2 py-1 align-top whitespace-pre-line"
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ),
              )}
              {slide.blocks.length === 0 && !slide.title ? (
                <p className="text-muted-foreground">No text or pictures on this slide.</p>
              ) : null}
              {slide.leftOut > 0 ? (
                <p className="text-[0.8125rem] text-muted-foreground">
                  {slide.leftOut === 1
                    ? "One picture can’t be shown here."
                    : `${slide.leftOut} pictures can’t be shown here.`}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
