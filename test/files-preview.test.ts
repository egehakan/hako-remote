/// <reference lib="dom" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser, parseHTML } from "linkedom";
import { type DeckFiles, readSlides, resolvePart } from "../src/lib/files/pptx.ts";
import { cleanHtml } from "../src/lib/files/sanitize-html.ts";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
const parser = new DOMParser() as unknown as globalThis.DOMParser;

function clean(html: string): string {
  const holder = document.createElement("div");
  holder.appendChild(cleanHtml(html, parser, document as unknown as Document));
  return holder.innerHTML;
}

/** The one element `html` comes to, as its tag and its attributes, whatever their order. */
function cleanElement(html: string): { tag: string; attributes: Record<string, string> } | null {
  const holder = document.createElement("div");
  holder.appendChild(cleanHtml(html, parser, document as unknown as Document));
  const element = holder.firstElementChild;
  if (!element) return null;
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes)) {
    attributes[attribute.name] = attribute.value;
  }
  return { tag: element.tagName.toLowerCase(), attributes };
}

test("a document keeps its structure and its words", () => {
  assert.equal(
    clean("<h1>Title</h1><p>One <strong>bold</strong> and <em>soft</em> word.</p>"),
    "<h1>Title</h1><p>One <strong>bold</strong> and <em>soft</em> word.</p>",
  );
  assert.equal(
    clean('<table><tr><td colspan="2" style="color:red" class="x">a</td></tr></table>'),
    '<table><tr><td colspan="2">a</td></tr></table>',
  );
});

test("scripts, event handlers and their contents are gone", () => {
  const out = clean(
    '<p onclick="steal()">hi</p><script>alert(1)</script><style>p{}</style>' +
      '<iframe src="https://example.com"></iframe><svg onload="x()"><circle/></svg>',
  );
  assert.equal(out, "<p>hi</p>");
});

test("text that looks like markup stays text", () => {
  const out = clean("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(out, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

test("pictures come only from bytes already in the page", () => {
  assert.deepEqual(
    cleanElement('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot" onerror="x()">'),
    {
      tag: "img",
      attributes: { src: "data:image/png;base64,iVBORw0KGgo=", alt: "dot", loading: "lazy" },
    },
  );
  assert.equal(clean('<p><img src="https://tracker.example/pixel.png"></p>'), "<p></p>");
  assert.equal(clean('<img src="data:text/html;base64,PHNjcmlwdD4=">'), "");
  assert.equal(clean('<img src="//example.com/x.png">'), "");
});

test("links open elsewhere when safe, and lose their address when not", () => {
  assert.deepEqual(cleanElement('<a href="https://example.com/" id="x">site</a>'), {
    tag: "a",
    attributes: {
      href: "https://example.com/",
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    },
  });
  assert.equal(clean('<a href="javascript:alert(1)">run</a>'), "run");
  assert.equal(clean('<a href=" JAVASCRIPT:alert(1)">run</a>'), "run");
  assert.equal(clean('<a href="#_ftn1">1</a>'), "1");
});

test("unknown elements give way to their contents", () => {
  assert.equal(clean("<section><span>kept</span> <font>words</font></section>"), "kept words");
});

// The slides of a deck

const P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const rels = (body: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const text = (value: string, placeholder = "") =>
  `<p:sp><p:nvSpPr><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`;
const pic = (attribute: string, id: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture" descr="a picture"/></p:nvPicPr><p:blipFill><a:blip ${attribute}="${id}"/></p:blipFill></p:pic>`;
const slide = (shapes: string) =>
  `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;

function deck(parts: Record<string, string>, binary: string[] = []): DeckFiles {
  return {
    text: async (path) => parts[path] ?? null,
    has: (path) => path in parts || binary.includes(path),
  };
}

const parseXml = (source: string) =>
  parser.parseFromString(source, "text/xml" as never) as unknown as Document;

test("slides come in the deck's order, with their words, titles and pictures", async () => {
  const files = deck(
    {
      "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels(
        '<Relationship Id="rA" Target="slides/slide1.xml"/><Relationship Id="rB" Target="slides/slide2.xml"/>',
      ),
      "ppt/slides/slide1.xml": slide(text("Second")),
      "ppt/slides/slide2.xml": slide(
        text("First", '<p:ph type="title"/>') + text("Body") + pic("r:embed", "rImg"),
      ),
      "ppt/slides/_rels/slide2.xml.rels": rels(
        '<Relationship Id="rImg" Target="../media/image1.png"/>',
      ),
    },
    ["ppt/media/image1.png"],
  );
  const slides = await readSlides(files, parseXml);
  assert.deepEqual(
    slides.map((one) => one.title ?? one.blocks[0]),
    ["First", { kind: "text", paragraphs: ["Second"] }],
  );
  assert.deepEqual(slides[0].blocks, [
    { kind: "text", paragraphs: ["Body"] },
    { kind: "image", path: "ppt/media/image1.png", mime: "image/png", alt: "a picture" },
  ]);
});

test("a slide's markup-like text is only text, and outside pictures are left out", async () => {
  const files = deck(
    {
      "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels('<Relationship Id="r1" Target="slides/slide1.xml"/>'),
      "ppt/slides/slide1.xml": slide(
        text("&lt;script&gt;alert(1)&lt;/script&gt;") +
          pic("r:embed", "rWeb") +
          pic("r:link", "rLinked") +
          pic("r:embed", "rUp") +
          pic("r:embed", "rEmf"),
      ),
      "ppt/slides/_rels/slide1.xml.rels": rels(
        '<Relationship Id="rWeb" Target="https://tracker.example/x.png" TargetMode="External"/>' +
          '<Relationship Id="rLinked" Target="../media/a.png"/>' +
          '<Relationship Id="rUp" Target="../../../../etc/b.png"/>' +
          '<Relationship Id="rEmf" Target="../media/c.emf"/>',
      ),
    },
    ["ppt/media/a.png", "ppt/media/c.emf"],
  );
  const [only] = await readSlides(files, parseXml);
  assert.deepEqual(only.blocks, [{ kind: "text", paragraphs: ["<script>alert(1)</script>"] }]);
  assert.equal(only.leftOut, 4);
});

test("a relationship's target stays inside the deck", () => {
  assert.equal(resolvePart("ppt/slides/slide1.xml", "../media/a.png"), "ppt/media/a.png");
  assert.equal(resolvePart("ppt/slides/slide1.xml", "/ppt/media/a.png"), "ppt/media/a.png");
  assert.equal(resolvePart("ppt/slides/slide1.xml", "../../../x.png"), null);
  assert.equal(resolvePart("ppt/slides/slide1.xml", "https://example.com/x.png"), null);
  assert.equal(resolvePart("ppt/slides/slide1.xml", "file:///etc/passwd"), null);
});
