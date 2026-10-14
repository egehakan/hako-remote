import { InfoIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SHEET_COLUMN_LIMIT, SHEET_ROW_LIMIT } from "@/lib/files/preview";
import { cn } from "@/lib/utils";
import { PreviewFailed, Working } from "./preview-states";

export type SheetSource = { bytes: Uint8Array; name: string } | { text: string; name: string };

type Sheet = {
  name: string;
  rows: string[][];
  /** How many rows and columns the sheet really has, when more than are shown. */
  totalRows: number;
  totalColumns: number;
};

type SheetViewProps = { source: SheetSource; fallback: ReactNode };

/** Rows are added to the page this many at a time, as the table is scrolled. */
const ROWS_AT_A_TIME = 200;

function columnName(index: number): string {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

/** A spreadsheet or a CSV file as a table per sheet, the first rows of each. */
export default function SheetView({ source, fallback }: SheetViewProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const content = "text" in source ? source.text : source.bytes;
  const { name } = source;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const XLSX = await import("xlsx");
        const tsv = /\.tsv$/i.test(name);
        const delimited = tsv || /\.csv$/i.test(name);
        const options = { sheetRows: SHEET_ROW_LIMIT, dense: true, cellFormula: false } as const;
        // Text is read as UTF-8, as it is everywhere else in Files, rather than guessed at.
        const text =
          typeof content === "string"
            ? content
            : delimited
              ? new TextDecoder().decode(content)
              : null;
        const book =
          text !== null
            ? XLSX.read(text, { ...options, type: "string", ...(tsv ? { FS: "\t" } : {}) })
            : XLSX.read(content, { ...options, type: "array" });
        // A CSV read only in part says nothing of its length, so its lines are counted.
        let lines = 0;
        if (text !== null) {
          for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
          if (!text.endsWith("\n")) lines++;
        }
        const read = book.SheetNames.map((name): Sheet => {
          const sheet = book.Sheets[name];
          const shown = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
          const full = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1:A1");
          const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            raw: false,
            defval: "",
            blankrows: true,
          });
          return {
            name,
            rows: rows.map((row) =>
              row.slice(0, SHEET_COLUMN_LIMIT).map((cell) => (cell == null ? "" : String(cell))),
            ),
            totalRows: shown ? Math.max(full.e.r + 1, lines) : 0,
            totalColumns: shown ? full.e.c + 1 : 0,
          };
        });
        if (!cancelled) setSheets(read);
      } catch {
        if (!cancelled) {
          setProblem(
            "It doesn’t read as a spreadsheet. It may be damaged, or another kind of file under this name.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, name]);

  if (problem) return <PreviewFailed reason={problem} fallback={fallback} />;
  if (!sheets) return <Working label="Reading the sheets…" />;
  const sheet = sheets[Math.min(active, sheets.length - 1)];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sheets.length > 1 ? (
        <div
          role="tablist"
          aria-label="Sheets"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-safe py-1.5 [scrollbar-width:none]"
        >
          {sheets.map((one, index) => (
            <button
              key={`${one.name}\n${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              className={cn(
                "h-9 shrink-0 rounded-md px-3 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                index === active
                  ? "bg-accent font-medium text-lid"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {one.name}
            </button>
          ))}
        </div>
      ) : null}
      <SheetTable key={active} sheet={sheet} />
    </div>
  );
}

function SheetTable({ sheet }: { sheet: Sheet }) {
  const [shown, setShown] = useState(ROWS_AT_A_TIME);
  const sentinel = useRef<HTMLTableRowElement>(null);
  const columns = sheet.rows.reduce((most, row) => Math.max(most, row.length), 0);
  const cutRows = sheet.totalRows > sheet.rows.length;
  const cutColumns = sheet.totalColumns > SHEET_COLUMN_LIMIT;

  // More rows join the table as its end comes into view.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || shown >= sheet.rows.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown((before) => before + ROWS_AT_A_TIME);
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown, sheet.rows.length]);

  if (sheet.rows.length === 0) {
    return (
      <p className="px-safe py-10 text-center text-sm text-muted-foreground">
        This sheet is empty.
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      {cutRows || cutColumns ? (
        <p className="sticky left-0 flex items-center gap-2 border-b px-safe py-2 text-[0.8125rem] leading-5 text-muted-foreground">
          <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
          {cutRows
            ? `The first ${SHEET_ROW_LIMIT.toLocaleString()} rows of ${sheet.totalRows.toLocaleString()}`
            : null}
          {cutRows && cutColumns ? "; " : null}
          {cutColumns
            ? `the first ${SHEET_COLUMN_LIMIT} columns of ${sheet.totalColumns.toLocaleString()}`
            : null}
          . Open it on your Mac for the rest.
        </p>
      ) : null}
      <table
        className="border-separate border-spacing-0 font-mono text-xs leading-5"
        translate="no"
      >
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 min-w-10 border-r border-b bg-card px-2" />
            {Array.from({ length: columns }, (_, index) => (
              <th
                key={index}
                scope="col"
                className="sticky top-0 z-10 border-r border-b bg-card px-2 py-1 text-center font-normal text-muted-foreground"
              >
                {columnName(index)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.slice(0, shown).map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th
                scope="row"
                className="sticky left-0 z-10 border-r border-b bg-card px-2 text-right font-normal text-muted-foreground tabular-nums"
              >
                {rowIndex + 1}
              </th>
              {Array.from({ length: columns }, (_, column) => (
                <td
                  key={column}
                  className="max-w-[18rem] truncate border-r border-b px-2 py-1 whitespace-pre"
                  title={row[column] && row[column].length > 30 ? row[column] : undefined}
                >
                  {row[column] ?? ""}
                </td>
              ))}
            </tr>
          ))}
          {shown < sheet.rows.length ? (
            <tr ref={sentinel}>
              <td colSpan={columns + 1} className="px-2 py-3 text-muted-foreground">
                More rows…
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
