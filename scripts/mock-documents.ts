// Documents and zips for the mock agent's tree, made at start: one of each kind the previews read,
// zips that unpack and zips that must be refused, and a project with folders a zip leaves out.
// Everything here is written for this fixture; nothing is copied from elsewhere.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import JSZip from "jszip";
import * as XLSX from "xlsx";

const write = (root: string, path: string, data: string | Uint8Array) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};

/** A small PNG of stripes, for the pictures inside documents. */
function stripes(width: number, height: number, colours: [number, number, number][]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw.set(colours[Math.floor((x + y) / 12) % colours.length], y * stride + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const frame = Buffer.alloc(8 + body.length);
    frame.writeUInt32BE(data.length, 0);
    body.copy(frame, 4);
    frame.writeUInt32BE(crc32(body), 4 + body.length);
    return frame;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const AMBER: [number, number, number] = [232, 146, 62];
const INK: [number, number, number] = [19, 21, 27];
const SAND: [number, number, number] = [246, 201, 132];

// PDF

const pdfText = (text: string) => text.replace(/[\\()]/g, (character) => `\\${character}`);

/** A PDF of `pages` pages, each with a heading, a few lines and a bar, in the standard fonts. */
function pdf(pages: number): Buffer {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(""); // The page tree, filled in once the pages are known.
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (let page = 1; page <= pages; page++) {
    const lines = [
      `BT /F1 26 Tf 56 760 Td (${pdfText(`Page ${page} of ${pages}`)}) Tj ET`,
      `BT /F2 12 Tf 56 730 Td 16 TL (${pdfText("A fixture of the mock agent, drawn by hand.")}) Tj T* (${pdfText(
        `Each page has its own number, so lazy loading can be checked: this is page ${page}.`,
      )}) Tj T* (${pdfText("Characters that need escaping: (round) and back\\slash.")}) Tj ET`,
      `0.91 0.57 0.24 rg 56 ${600 - page * 8} ${40 + page * 22} 24 re f`,
      `0.07 0.08 0.11 RG 2 w 56 120 m 556 120 l S`,
      `BT /F2 9 Tf 56 100 Td (${pdfText(`hako-remote preview fixture, page ${page}`)}) Tj ET`,
    ].join("\n");
    const content = objects.push(`<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`);
    kids.push(
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R ` +
          "/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>",
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// Word

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xmlText = (text: string) =>
  text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

const run = (text: string, props = "") =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
const para = (body: string, style?: string, list?: number) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${
    list !== undefined ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${list}"/></w:numPr>` : ""
  }</w:pPr>${body}</w:p>`;

function docx(picture: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdPicture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stripes.png"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/><Relationship Id="rIdScript" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:document.title='UNSAFE'" TargetMode="External"/><Relationship Id="rIdRemote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/tracker.png" TargetMode="External"/></Relationships>`,
  );
  const style = (id: string, name: string, size: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${style("Title", "Title", 48)}${style("Heading1", "heading 1", 32)}${style("Heading2", "heading 2", 26)}</w:styles>`,
  );
  zip.file(
    "word/numbering.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
  );
  const drawing = (relation: string, attribute: "r:embed" | "r:link", name: string) =>
    `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="2400000" cy="900000"/><wp:docPr id="1" name="${name}" descr="${name}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${attribute}="${relation}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const cell = (text: string, bold = false) =>
    `<w:tc><w:p>${run(text, bold ? "<w:b/>" : "")}</w:p></w:tc>`;
  const body = [
    para(run("Quarterly letter"), "Title"),
    para(
      run("This document was written for the mock agent. It has ") +
        run("bold", "<w:b/>") +
        run(", ") +
        run("italic", "<w:i/>") +
        run(" and ") +
        run("underlined", '<w:u w:val="single"/>') +
        run(" words, a list, a table and a picture."),
    ),
    para(run("What happened"), "Heading1"),
    para(run("The box shipped to the phone"), undefined, 1),
    para(run("Files learned to copy and move"), undefined, 1),
    para(run("Previews arrived"), undefined, 1),
    para(run("Next steps"), "Heading2"),
    para(run("Read the protocol"), undefined, 2),
    para(run("Try it on the iPhone"), undefined, 2),
    `<w:tbl><w:tblPr/><w:tr>${cell("Month", true)}${cell("Boxes", true)}</w:tr><w:tr>${cell("August")}${cell("12")}</w:tr><w:tr>${cell("September")}${cell("31")}</w:tr></w:tbl>`,
    para(drawing("rIdPicture", "r:embed", "Amber stripes")),
    para(
      run("A link to ") +
        `<w:hyperlink r:id="rIdLink">${run("example.com", '<w:color w:val="0563C1"/>')}</w:hyperlink>` +
        run(", and one that must not run: ") +
        `<w:hyperlink r:id="rIdScript">${run("a script link")}</w:hyperlink>.`,
    ),
    para(run("Things that must stay inert"), "Heading2"),
    para(run('<script>document.title = "UNSAFE: a script in a document ran"</script>')),
    para(run('<img src="x" onerror="document.title=\'UNSAFE\'">')),
    para(run("A picture from the internet, which must not load:") + drawing("rIdRemote", "r:link", "Remote")),
  ].join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} ${R}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  zip.file("word/media/stripes.png", picture);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// PowerPoint

const P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const shape = (paragraphs: string[], placeholder?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr>${
    placeholder ? `<p:ph type="${placeholder}"/>` : ""
  }</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs
    .map((text) => `<a:p><a:r><a:rPr lang="en-GB"/><a:t>${xmlText(text)}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;
const picture = (relation: string, name: string, attribute = "r:embed") =>
  `<p:pic><p:nvPicPr><p:cNvPr id="3" name="${name}" descr="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip ${attribute}="${relation}"/></p:blipFill><p:spPr/></p:pic>`;
const slide = (shapes: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
const relations = (entries: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;

function pptx(first: Buffer, second: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  const slides = [
    slide(
      shape(["Hako on the phone"], "ctrTitle") +
        shape(["A deck the mock agent made", "Three slides, two pictures"], "subTitle"),
    ),
    slide(
      shape(["What the box holds"], "title") +
        shape(["Terminals you can type into", "Files you can copy, move and preview", "Source control"]) +
        picture("rIdStripes", "Amber stripes"),
    ),
    slide(
      shape(["Things that must stay inert"], "title") +
        shape(['<script>document.title = "UNSAFE: a script in a slide ran"</script>']) +
        picture("rIdRemote", "A picture from the internet", "r:link") +
        `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(["Text inside a group"])}${picture("rIdSand", "Sand stripes")}</p:grpSp>`,
    ),
  ];
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides
      .map(
        (_, index) =>
          `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
      )
      .join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    relations(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>',
    ),
  );
  // The order in the list is the order of the slides, whatever their file names say.
  const order = [1, 3, 2];
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P}><p:sldIdLst>${order
      .map((number, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${number}"/>`)
      .join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    relations(
      [1, 2, 3]
        .map(
          (number) =>
            `<Relationship Id="rIdSlide${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${number}.xml"/>`,
        )
        .join(""),
    ),
  );
  // Slide 2 in the files is shown third.
  zip.file("ppt/slides/slide1.xml", slides[0]);
  zip.file("ppt/slides/slide3.xml", slides[1]);
  zip.file("ppt/slides/slide2.xml", slides[2]);
  zip.file(
    "ppt/slides/_rels/slide3.xml.rels",
    relations(
      '<Relationship Id="rIdStripes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/stripes.png"/>',
    ),
  );
  zip.file(
    "ppt/slides/_rels/slide2.xml.rels",
    relations(
      '<Relationship Id="rIdRemote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/tracker.png" TargetMode="External"/><Relationship Id="rIdSand" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sand.png"/>',
    ),
  );
  zip.file("ppt/media/stripes.png", first);
  zip.file("ppt/media/sand.png", second);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// Spreadsheets

function workbook(): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  const months = ["January", "February", "March", "April", "May", "June"];
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Month", "Boxes", "Price", "Total"],
      ...months.map((month, index) => [month, 10 + index * 3, 4.5, (10 + index * 3) * 4.5]),
      ["Sum", { f: "SUM(B2:B7)" }, null, { f: "SUM(D2:D7)" }],
    ]),
    "Sales",
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Role", "Note"],
      ["Ege", "Owner", "Uses the phone"],
      ["Mock", "Agent", "<script>document.title='UNSAFE'</script>"],
    ]),
    "People",
  );
  return book;
}

function longSheet(rows: number): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Row", "Value"],
      ...Array.from({ length: rows }, (_, index) => [index + 1, (index * 7) % 101]),
    ]),
    "Long",
  );
  return book;
}

function csv(rows: number, separator: string): string {
  const lines = [["id", "name", "city", "note"].join(separator)];
  const cities = ["Istanbul", "Berlin", "Lisbon", "Kyoto"];
  for (let index = 1; index <= rows; index++) {
    lines.push(
      [index, `Person ${index}`, cities[index % 4], index % 5 === 0 ? '"quoted, with a comma"' : ""].join(
        separator,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

// Zips

/** Sets the "encrypted" flag on every entry, which is what a zip with a password has. */
function markEncrypted(zip: Buffer): Buffer {
  const out = Buffer.from(zip);
  for (let at = 0; at < out.length - 4; at++) {
    const signature = out.readUInt32LE(at);
    if (signature === 0x04034b50) out.writeUInt16LE(out.readUInt16LE(at + 6) | 1, at + 6);
    if (signature === 0x02014b50) out.writeUInt16LE(out.readUInt16LE(at + 8) | 1, at + 8);
  }
  return out;
}

async function zips(root: string): Promise<void> {
  const make = (fill: (zip: JSZip) => void) => {
    const zip = new JSZip();
    fill(zip);
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
  };
  write(
    root,
    "Downloads/zips/photos.zip",
    await make((zip) => {
      zip.file("photos/amber.png", stripes(64, 64, [AMBER, INK]));
      zip.file("photos/sand.png", stripes(64, 64, [SAND, INK]));
      zip.file("photos/notes/where.txt", "Taken on the balcony.\n");
      zip.file("__MACOSX/photos/._amber.png", "resource fork");
      zip.file("photos/.DS_Store", "Finder's");
    }),
  );
  const escaping = await make((zip) => {
    zip.file("inside.txt", "fine\n");
    zip.file("evil.txt", "should never be written\n");
  });
  // JSZip tidies names when it writes them, so the escaping one is spelt into the bytes afterwards:
  // "evil.txt" becomes "../e.txt", which has the same length.
  write(
    root,
    "Downloads/zips/escapes-its-folder.zip",
    Buffer.from(escaping.toString("latin1").replaceAll("evil.txt", "../e.txt"), "latin1"),
  );
  write(
    root,
    "Downloads/zips/link-outside.zip",
    await make((zip) => {
      zip.file("readme.txt", "This zip holds a link that points out of its folder.\n");
      zip.file("escape", "../../../etc/passwd", { unixPermissions: 0o120777 });
    }),
  );
  write(
    root,
    "Downloads/zips/locked.zip",
    markEncrypted(await make((zip) => zip.file("secret.txt", "behind a password\n"))),
  );
  write(root, "Downloads/zips/not-really.zip", "This is plain text with a .zip name.\n");
}

/** A project whose zip leaves out what can be made again: dependencies, builds, git's own files. */
function heavyProject(root: string): void {
  const project = "Downloads/project-with-heavy-folders";
  write(root, `${project}/README.md`, "# A project\n\nIts zip leaves out the heavy folders.\n");
  write(root, `${project}/src/main.ts`, 'console.log("hello");\n');
  write(root, `${project}/.git/HEAD`, "ref: refs/heads/main\n");
  write(root, `${project}/node_modules/left-pad/index.js`, "module.exports = (s) => s;\n");
  write(root, `${project}/.venv/pyvenv.cfg`, "home = /usr/bin\n");
  write(root, `${project}/target/CACHEDIR.TAG`, "Signature: 8a477f597d28d172789f06886806bc55\n");
  write(root, `${project}/target/debug/app`, "a build\n");
  // A folder called target that is not a build's output stays in.
  write(root, `${project}/docs/target/aim.md`, "# Where we are going\n");
}

export async function createDocumentFixture(root: string): Promise<void> {
  const amber = stripes(240, 90, [AMBER, INK]);
  const sand = stripes(240, 90, [SAND, INK]);
  const folder = "Documents/Previews";
  write(root, `${folder}/report-20-pages.pdf`, pdf(20));
  write(root, `${folder}/two-pages.pdf`, pdf(2));
  write(root, `${folder}/letter.docx`, await docx(amber));
  write(root, `${folder}/deck.pptx`, await pptx(amber, sand));
  const book = workbook();
  write(root, `${folder}/budget.xlsx`, XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  write(root, `${folder}/budget.ods`, XLSX.write(book, { type: "buffer", bookType: "ods" }));
  write(root, `${folder}/budget.xls`, XLSX.write(book, { type: "buffer", bookType: "biff8" }));
  write(
    root,
    `${folder}/long-sheet.xlsx`,
    XLSX.write(longSheet(2600), { type: "buffer", bookType: "xlsx" }),
  );
  write(root, `${folder}/people.csv`, csv(40, ","));
  write(root, `${folder}/people.tsv`, csv(40, "\t"));
  // Over the 2 MB that opens as text, so it is fetched whole before it is shown.
  write(root, `${folder}/big-table.csv`, csv(60_000, ","));
  write(root, `${folder}/broken.docx`, "Not a Word document at all.\n");
  await zips(root);
  heavyProject(root);
}
