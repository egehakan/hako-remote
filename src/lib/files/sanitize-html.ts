/// <reference lib="dom" />
// HTML made from a document on the Mac (a Word file's contents), rebuilt from an allow-list before
// it is put in the page. Nothing is copied over as markup: each kept element is made anew with the
// few attributes it may have, and text is copied as text, so nothing runs and nothing is fetched.

type Parser = { parseFromString(source: string, type: "text/html"): Document };

/** Elements dropped together with everything inside them. */
const DROPPED = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "template",
  "noscript",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "video",
  "audio",
  "source",
  "track",
  "picture",
  "canvas",
  "head",
  "title",
]);

/** Elements kept as they are, with no attributes unless named below. */
const KEPT = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "sup",
  "sub",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "blockquote",
  "pre",
  "code",
  "a",
  "img",
]);

/** Pictures only as bytes already in the page: no address that would be fetched. */
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]*$|^blob:/i;
const SAFE_LINK = /^(?:https?:|mailto:)/i;
const SMALL_NUMBER = /^\d{1,3}$/;

function copyAttributes(from: Element, to: Element, tag: string): boolean {
  if (tag === "a") {
    const href = from.getAttribute("href")?.trim() ?? "";
    if (!SAFE_LINK.test(href)) return false;
    to.setAttribute("href", href);
    to.setAttribute("target", "_blank");
    to.setAttribute("rel", "noopener noreferrer nofollow");
    return true;
  }
  if (tag === "img") {
    const src = from.getAttribute("src")?.trim() ?? "";
    if (!SAFE_IMAGE.test(src)) return false;
    to.setAttribute("src", src);
    to.setAttribute("alt", from.getAttribute("alt") ?? "");
    to.setAttribute("loading", "lazy");
    return true;
  }
  if (tag === "td" || tag === "th") {
    for (const name of ["colspan", "rowspan"]) {
      const value = from.getAttribute(name);
      if (value !== null && SMALL_NUMBER.test(value)) to.setAttribute(name, value);
    }
  }
  if (tag === "ol") {
    const start = from.getAttribute("start");
    if (start !== null && SMALL_NUMBER.test(start)) to.setAttribute("start", start);
  }
  return true;
}

function rebuild(source: Node, into: Node, target: Document): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3) {
      into.appendChild(target.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROPPED.has(tag)) continue;
    if (!KEPT.has(tag)) {
      // An element not on the list gives way to what it holds.
      rebuild(element, into, target);
      continue;
    }
    const copy = target.createElement(tag);
    if (!copyAttributes(element, copy, tag)) {
      // A link to somewhere unsafe keeps its words; a picture from elsewhere is left out.
      if (tag === "a") rebuild(element, into, target);
      continue;
    }
    rebuild(element, copy, target);
    into.appendChild(copy);
  }
}

/** The safe part of `html`, as nodes of `target` ready to be appended. */
export function cleanHtml(html: string, parser: Parser, target: Document): DocumentFragment {
  // Spelt out as a whole document, so every parser puts the content in a body.
  const parsed = parser.parseFromString(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    "text/html",
  );
  const fragment = target.createDocumentFragment();
  if (parsed.body) rebuild(parsed.body, fragment, target);
  return fragment;
}
