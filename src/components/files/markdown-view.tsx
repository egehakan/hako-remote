import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { useMemo } from "react";
import { resolveRelative } from "@/lib/files/paths";
import { routes } from "@/lib/route";

const WEB = /^https?:\/\//i;
const OUTSIDE = /^(?:https?:\/\/|mailto:)/i;

/**
 * Markdown as HTML that is safe to put on the page. micromark does not pass raw HTML through and
 * drops unsafe link protocols; what is left to do here is to point relative links at the file view
 * and to keep pictures from being fetched, since a document should not make the phone call out.
 */
function render(source: string, directory: string): string {
  const html = micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  // A document from DOMParser is inert: nothing in it loads or runs while it is being edited.
  const parsed = new DOMParser().parseFromString(html, "text/html");

  for (const link of parsed.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    const local = resolveRelative(directory, href);
    if (local !== null) {
      link.setAttribute("href", routes.file(local));
    } else if (OUTSIDE.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else {
      // An anchor inside the document would be read as an address of this app.
      link.removeAttribute("href");
    }
  }

  for (const image of parsed.querySelectorAll("img")) {
    const source = image.getAttribute("src") ?? "";
    const label = image.getAttribute("alt") || source || "picture";
    const local = resolveRelative(directory, source);
    const stand = parsed.createElement(local !== null || WEB.test(source) ? "a" : "span");
    stand.className = "md-picture";
    stand.textContent = label;
    if (local !== null) stand.setAttribute("href", routes.file(local));
    else if (WEB.test(source)) stand.setAttribute("href", source);
    image.replaceWith(stand);
  }
  return parsed.body.innerHTML;
}

type MarkdownViewProps = { source: string; directory: string };

export default function MarkdownView({ source, directory }: MarkdownViewProps) {
  const html = useMemo(() => render(source, directory), [source, directory]);
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <article
        className="markdown mx-auto max-w-[44rem] px-safe pt-5 pb-[max(4rem,env(safe-area-inset-bottom))] wide:px-8"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
