/// <reference lib="dom" />
// A PowerPoint file read for its words and pictures, slide by slide in the deck's own order. The
// result is plain data: text stays text, and a picture is only ever a file inside the deck itself,
// never an address outside it.

type XmlParser = (text: string) => Document;

/** What the deck's zip holds, as the reader needs it. */
export type DeckFiles = {
  text: (path: string) => Promise<string | null>;
  has: (path: string) => boolean;
};

export type SlideBlock =
  | { kind: "text"; paragraphs: string[] }
  | { kind: "image"; path: string; mime: string; alt: string }
  | { kind: "table"; rows: string[][] };

export type Slide = {
  number: number;
  title: string | null;
  blocks: SlideBlock[];
  /** Pictures in a format a browser cannot draw (EMF, TIFF …), or outside the deck. */
  leftOut: number;
};

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export function pictureType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? null : (IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null);
}

const local = (node: Element) => node.tagName.replace(/^.*:/, "");

function kids(node: Element, name?: string): Element[] {
  return Array.from(node.children).filter((child) => name === undefined || local(child) === name);
}

function first(node: Element, ...path: string[]): Element | null {
  let current: Element | null = node;
  for (const name of path) {
    current = current ? (kids(current, name)[0] ?? null) : null;
  }
  return current;
}

/** An attribute by its name without a prefix; `prefixed` asks for one that has a prefix. */
function attr(node: Element, name: string, prefixed = false): string | null {
  for (const attribute of Array.from(node.attributes)) {
    const hasPrefix = attribute.name.includes(":");
    if (prefixed && !hasPrefix) continue;
    if (attribute.name.replace(/^.*:/, "") === name) return attribute.value;
  }
  return null;
}

/** Every element called `name` below `node`, in document order. */
function below(node: Element, name: string): Element[] {
  const found: Element[] = [];
  const walk = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (local(child) === name) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** Where a relationship's target is inside the deck, or null when it would leave it. */
export function resolvePart(from: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const segments = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of target.replace(/^\/+/, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.length === 0 ? null : segments.join("/");
}

type Relations = Map<string, string>;

async function relationsOf(files: DeckFiles, part: string, parse: XmlParser): Promise<Relations> {
  const cut = part.lastIndexOf("/");
  const path = `${part.slice(0, cut)}/_rels/${part.slice(cut + 1)}.rels`;
  const text = await files.text(path);
  const relations: Relations = new Map();
  if (text === null) return relations;
  for (const relation of below(parse(text).documentElement, "Relationship")) {
    const id = attr(relation, "Id");
    const target = attr(relation, "Target");
    // A picture linked from the internet would be fetched just by being shown.
    if (!id || !target || attr(relation, "TargetMode") === "External") continue;
    const resolved = resolvePart(part, target);
    if (resolved !== null) relations.set(id, resolved);
  }
  return relations;
}

function paragraphsOf(body: Element): string[] {
  return kids(body, "p")
    .map((paragraph) =>
      Array.from(paragraph.children)
        .map((piece) => {
          const kind = local(piece);
          if (kind === "br") return "\n";
          if (kind === "r" || kind === "fld") return first(piece, "t")?.textContent ?? "";
          return "";
        })
        .join(""),
    )
    .filter((text) => text.trim() !== "");
}

function readShapes(parent: Element, relations: Relations, files: DeckFiles, slide: Slide): void {
  for (const shape of kids(parent)) {
    switch (local(shape)) {
      case "sp": {
        const body = first(shape, "txBody");
        if (!body) break;
        const paragraphs = paragraphsOf(body);
        if (paragraphs.length === 0) break;
        const placeholder = first(shape, "nvSpPr", "nvPr", "ph");
        const type = placeholder ? attr(placeholder, "type") : null;
        if ((type === "title" || type === "ctrTitle") && slide.title === null) {
          slide.title = paragraphs.join(" ");
        } else {
          slide.blocks.push({ kind: "text", paragraphs });
        }
        break;
      }
      case "pic": {
        const blip = first(shape, "blipFill", "blip");
        const id = blip ? attr(blip, "embed", true) : null;
        const path = id ? relations.get(id) : undefined;
        const mime = path ? pictureType(path) : null;
        const described = first(shape, "nvPicPr", "cNvPr");
        if (path && mime && files.has(path)) {
          slide.blocks.push({
            kind: "image",
            path,
            mime,
            alt: (described && (attr(described, "descr") ?? attr(described, "name"))) ?? "",
          });
        } else {
          slide.leftOut++;
        }
        break;
      }
      case "grpSp":
        readShapes(shape, relations, files, slide);
        break;
      case "graphicFrame": {
        const table = below(shape, "tbl")[0];
        if (!table) break;
        const rows = kids(table, "tr").map((row) =>
          kids(row, "tc").map((cell) => {
            const body = first(cell, "txBody");
            return body ? paragraphsOf(body).join("\n") : "";
          }),
        );
        if (rows.length > 0) slide.blocks.push({ kind: "table", rows });
        break;
      }
    }
  }
}

/** The slides of a deck, in the order its presentation lists them. */
export async function readSlides(files: DeckFiles, parse: XmlParser): Promise<Slide[]> {
  const main = "ppt/presentation.xml";
  const presentation = await files.text(main);
  if (presentation === null)
    throw new Error("This is not a PowerPoint file: it has no slides list.");
  const relations = await relationsOf(files, main, parse);
  const list = first(parse(presentation).documentElement, "sldIdLst");
  const parts = (list ? kids(list, "sldId") : [])
    // `id` is the slide's number; the prefixed `r:id` names its relationship.
    .map((entry) => relations.get(attr(entry, "id", true) ?? "") ?? null)
    .filter((part): part is string => part !== null);

  const slides: Slide[] = [];
  for (const part of parts) {
    const text = await files.text(part);
    if (text === null) continue;
    const slide: Slide = { number: slides.length + 1, title: null, blocks: [], leftOut: 0 };
    const tree = below(parse(text).documentElement, "spTree")[0];
    if (tree) readShapes(tree, await relationsOf(files, part, parse), files, slide);
    slides.push(slide);
  }
  return slides;
}
