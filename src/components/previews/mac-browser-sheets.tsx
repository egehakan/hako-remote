import type {
  BrowserDialog,
  BrowserFileChooser,
  BrowserPicker,
  BrowserTab,
  PickerOption,
} from "@shared/browser";
import {
  CheckIcon,
  CircleAlertIcon,
  DownloadIcon,
  FileUpIcon,
  GlobeIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import type { DownloadItem, DownloadPhase } from "@/lib/browser/downloads";
import { formatSize } from "@/lib/files/format";
import { handOver } from "@/lib/transfers/actions";
import { describeTransferFailure, fraction } from "@/lib/transfers/describe";
import type { Transfer } from "@/lib/transfers/queue";
import { sourceOf, transfers, useTransfers, useTransferSupport } from "@/lib/transfers/store";
import { cn } from "@/lib/utils";

/** The page's `alert`, `confirm`, `prompt` or "leave this page?", answered from the phone. */
export function PageDialog({
  dialog,
  origin,
  onReply,
}: {
  dialog: BrowserDialog | null;
  /** Whose dialog it is, as a browser names it. */
  origin: string;
  onReply: (accept: boolean, text: string) => void;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (dialog) setText(dialog.default);
  }, [dialog]);
  const kind = dialog?.kind ?? "alert";
  const leaving = kind === "beforeunload";
  return (
    <AlertDialog
      open={dialog !== null}
      onOpenChange={(open) => {
        // Escape, or a tap outside: a browser takes that as Cancel (and OK for an alert).
        if (!open && dialog) onReply(kind === "alert", "");
      }}
    >
      <AlertDialogContent initialFocus={kind === "prompt" ? field : ok}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onReply(true, text);
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {leaving ? "Leave this page?" : origin ? `${origin} says` : "The page says"}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words whitespace-pre-wrap">
              {leaving
                ? "Changes you made on the page may not be saved."
                : dialog?.message || "(no message)"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {kind === "prompt" ? (
            <Input
              ref={field}
              name="prompt"
              aria-label="Answer"
              autoComplete="off"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          ) : null}
          <AlertDialogFooter>
            {kind !== "alert" ? (
              <AlertDialogCancel size="touch" type="button" onClick={() => onReply(false, "")}>
                {leaving ? "Stay" : "Cancel"}
              </AlertDialogCancel>
            ) : null}
            <AlertDialogAction ref={ok} size="touch" type="submit">
              {leaving ? "Leave" : "OK"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const VALUE_LABELS: Record<string, string> = {
  date: "Date",
  time: "Time",
  "datetime-local": "Date and time",
  month: "Month",
  week: "Week",
  color: "Colour",
};

/** A `<select>`, or a date, time or colour field of the page, with the phone's own picker. */
export function PickerSheet({
  picker,
  onReply,
}: {
  picker: BrowserPicker | null;
  onReply: (values: string[] | null) => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!picker) return;
    if (picker.kind === "select") {
      setChosen(picker.options.filter((option) => option.selected).map((option) => option.value));
    } else {
      setValue(picker.value);
    }
  }, [picker]);

  const groups = useMemo(() => {
    if (picker?.kind !== "select") return [];
    const list: { label: string | null; options: PickerOption[] }[] = [];
    for (const option of picker.options) {
      const label = option.group ?? null;
      const last = list[list.length - 1];
      if (last && last.label === label) last.options.push(option);
      else list.push({ label, options: [option] });
    }
    return list;
  }, [picker]);

  const multiple = picker?.kind === "select" && picker.multiple;
  return (
    <Sheet open={picker !== null} onOpenChange={(open) => !open && onReply(null)}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[80dvh] max-w-lg gap-0 rounded-t-2xl border-x pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>
            {picker?.kind === "select"
              ? multiple
                ? "Choose any"
                : "Choose one"
              : `Choose a ${VALUE_LABELS[picker?.kind ?? "date"]?.toLowerCase() ?? "value"}`}
          </SheetTitle>
          <SheetDescription>
            {picker?.kind === "select"
              ? "The page’s list, as the Mac has it. Your choice is set on the page there."
              : "Your choice is set in the page’s field on the Mac."}
          </SheetDescription>
        </SheetHeader>
        {picker?.kind === "select" ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto border-y">
              {groups.map((group, index) => (
                <section
                  key={`${group.label ?? ""}-${index}`}
                  aria-label={group.label ?? undefined}
                >
                  {group.label ? (
                    <h3 className="px-4 pt-3 pb-1 text-[0.8125rem] text-muted-foreground">
                      {group.label}
                    </h3>
                  ) : null}
                  <ul className="px-2 py-1">
                    {group.options.map((option) => {
                      const on = chosen.includes(option.value);
                      return (
                        <li key={option.value}>
                          <button
                            type="button"
                            role={multiple ? "checkbox" : "radio"}
                            aria-checked={on}
                            disabled={option.disabled}
                            onClick={() => {
                              if (multiple) {
                                setChosen(
                                  on
                                    ? chosen.filter((item) => item !== option.value)
                                    : [...chosen, option.value],
                                );
                              } else {
                                onReply([option.value]);
                              }
                            }}
                            className={cn(
                              "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-[0.9375rem] outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40",
                              on && "bg-secondary",
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">{option.label || " "}</span>
                            <CheckIcon
                              className={cn("size-4 shrink-0 text-lid", !on && "invisible")}
                            />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
            {multiple ? (
              <div className="flex justify-end px-4 pt-3">
                <Button size="touch" onClick={() => onReply(chosen)}>
                  Done
                </Button>
              </div>
            ) : null}
          </>
        ) : picker ? (
          <form
            className="flex flex-col gap-3 px-4"
            onSubmit={(event) => {
              event.preventDefault();
              onReply([value]);
            }}
          >
            <label className="flex flex-col gap-1.5 text-[0.8125rem] text-muted-foreground">
              {VALUE_LABELS[picker.kind]}
              <input
                type={picker.kind}
                name="value"
                value={value}
                min={picker.min ?? undefined}
                max={picker.max ?? undefined}
                step={picker.step ?? undefined}
                onChange={(event) => setValue(event.target.value)}
                className={cn(
                  "h-11 w-full rounded-lg border border-input bg-input/30 px-3 text-base text-foreground outline-none [color-scheme:dark] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                  picker.kind === "color" && "p-1",
                )}
              />
            </label>
            <Button size="touch" type="submit">
              Set
            </Button>
          </form>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

const ACCEPT_WORDS: Record<string, string> = {
  "image/*": "pictures",
  "video/*": "videos",
  "audio/*": "sound files",
};

/** What the page's `accept` asks for, in words. */
function acceptLabel(accept: string): string | null {
  const parts = accept
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const words = parts.map((part) => ACCEPT_WORDS[part] ?? part);
  return `The page takes ${words.join(", ")}.`;
}

type ChooserFile = { name: string; transferId: number };

/**
 * The page's file input: files from the phone go to the uploads area on the Mac, and the page then
 * gets them as if they had been picked there.
 */
export function FileChooserSheet({
  chooser,
  bid,
  onReply,
}: {
  chooser: BrowserFileChooser | null;
  bid: number | null;
  onReply: (paths: string[]) => void;
}) {
  const group = `browser:${bid ?? "none"}`;
  const items = useTransfers(group);
  const support = useTransferSupport();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<ChooserFile[]>([]);
  const replied = useRef(false);

  useEffect(() => {
    if (!chooser) return;
    replied.current = false;
    setFiles([]);
  }, [chooser]);

  const mine = files.map((file) => items.find((item) => item.id === file.transferId) ?? null);
  const finished = files.length > 0 && mine.every((item) => item?.state === "done");
  const failed = mine.find((item) => item?.state === "failed") ?? null;

  useEffect(() => {
    if (!finished || replied.current) return;
    replied.current = true;
    const paths = mine.map((item) => item?.uploaded?.path ?? "").filter(Boolean);
    for (const file of files) transfers.dismiss(file.transferId);
    onReply(paths);
  }, [finished, mine, files, onReply]);

  const cancel = () => {
    if (replied.current) return;
    replied.current = true;
    for (const file of files) transfers.cancel(file.transferId);
    transfers.drop(group);
    onReply([]);
  };

  const pick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const picked = [...list].slice(0, chooser?.multiple ? undefined : 1);
    setFiles(
      picked.map((file) => ({
        name: file.name,
        transferId: transfers.addUpload({
          group,
          source: sourceOf(file),
          destination: { kind: "uploads" },
          name: file.name,
        }),
      })),
    );
  };

  const busy = files.length > 0 && !finished;
  return (
    <Sheet open={chooser !== null} onOpenChange={(open) => !open && cancel()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[80dvh] max-w-lg gap-3 rounded-t-2xl border-x px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="px-0 pr-10">
          <SheetTitle>
            {chooser?.multiple ? "Give the page files" : "Give the page a file"}
          </SheetTitle>
          <SheetDescription>
            {support.state === "no"
              ? "The Hako on your Mac can’t take files from this phone yet. Update it and try again."
              : `What you choose goes to the uploads area on your Mac, and the page gets it from there. ${acceptLabel(chooser?.accept ?? "") ?? ""}`}
          </SheetDescription>
        </SheetHeader>
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          multiple={chooser?.multiple ?? false}
          accept={chooser?.accept || undefined}
          onChange={(event) => {
            pick(event.target.files);
            event.target.value = "";
          }}
        />
        {files.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {files.map((file, index) => (
              <UploadRow key={file.transferId} name={file.name} item={mine[index]} />
            ))}
          </ul>
        ) : null}
        {failed ? (
          <p className="flex items-start gap-2 text-[0.8125rem] text-destructive">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            {describeTransferFailure(failed, support.limits.maxBytes)}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="touch"
            className="min-w-0 flex-1"
            disabled={support.state === "no" || busy}
            onClick={() => {
              if (failed) {
                for (const file of files) transfers.cancel(file.transferId);
                setFiles([]);
              }
              input.current?.click();
            }}
          >
            {busy ? <Spinner data-icon="inline-start" /> : <FileUpIcon data-icon="inline-start" />}
            {busy ? "Sending to your Mac…" : files.length > 0 ? "Choose again" : "Choose…"}
          </Button>
          <Button size="touch" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function UploadRow({ name, item }: { name: string; item: Transfer | null }) {
  const progress = item ? fraction(item) : null;
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.875rem]">{name}</span>
        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full",
              item?.state === "failed" ? "bg-destructive" : "bg-lid",
            )}
            style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
          />
        </span>
      </span>
      {item?.state === "done" ? (
        <CheckIcon aria-label="Sent" className="size-4 shrink-0 text-settled" />
      ) : item?.state === "failed" ? (
        <CircleAlertIcon aria-label="Failed" className="size-4 shrink-0 text-destructive" />
      ) : (
        <Spinner className="size-4 shrink-0" />
      )}
    </li>
  );
}

/** The tabs of the session on the Mac: the page's own pop-ups and new tabs among them. */
export function TabsSheet({
  open,
  onOpenChange,
  tabs,
  onSwitch,
  onClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: BrowserTab[];
  onSwitch: (tab: string) => void;
  onClose: (tab: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[80dvh] max-w-lg gap-0 rounded-t-2xl border-x pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>Tabs</SheetTitle>
          <SheetDescription>
            Links that open a new tab, and pop-ups such as a sign-in window, open here. Closing one
            goes back to the tab that opened it.
          </SheetDescription>
        </SheetHeader>
        <ul className="min-h-0 flex-1 overflow-y-auto border-y px-2 py-1">
          {tabs.map((tab) => (
            <li key={tab.id} className="flex items-center gap-1">
              <button
                type="button"
                aria-current={tab.active ? "page" : undefined}
                onClick={() => {
                  onSwitch(tab.id);
                  onOpenChange(false);
                }}
                className={cn(
                  "flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                  tab.active && "bg-secondary",
                )}
              >
                <GlobeIcon
                  className={cn("size-4 shrink-0", tab.active ? "text-lid" : "text-faint")}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] leading-5">
                    {tab.title || "Untitled"}
                  </span>
                  <span className="block truncate font-mono text-[0.75rem] leading-4 text-muted-foreground">
                    {displayUrl(tab.url)}
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 text-muted-foreground"
                aria-label={`Close ${tab.title || "tab"}`}
                onClick={() => onClose(tab.id)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

/** An address as the address field shows it: without `http://`, and without a lone `/`. */
export function displayUrl(url: string): string {
  if (url === "about:blank") return url;
  return url.replace(/^http:\/\//, "").replace(/^([^/]+)\/$/, "$1");
}

const BROWSER_DOWNLOADS = "browser-downloads";

const UNFINISHED: Record<Exclude<DownloadPhase, "done">, string> = {
  progress: "Downloading on your Mac…",
  cancelled: "Cancelled on your Mac",
  failed: "The download failed on your Mac",
  stalled: "The download did not finish on your Mac",
};

/**
 * Files the page downloaded on the Mac. Each can be fetched to this phone through the same
 * transfer the Files screen uses.
 */
export function DownloadsBar({
  items,
  onDismiss,
}: {
  items: DownloadItem[];
  onDismiss: (id: number) => void;
}) {
  const transfersNow = useTransfers(BROWSER_DOWNLOADS);
  const support = useTransferSupport();
  const [fetching, setFetching] = useState<Record<number, number>>({});
  if (items.length === 0) return null;
  return (
    <section aria-label="Downloads" className="shrink-0 border-t bg-card">
      <ul className="divide-y">
        {items.slice(-3).map((item) => {
          const transferId = fetching[item.id];
          const transfer =
            transferId === undefined
              ? null
              : (transfersNow.find((entry) => entry.id === transferId) ?? null);
          const progress = transfer ? fraction(transfer) : null;
          const save = () => {
            if (transfer?.state === "done") {
              void handOver(transfer.id);
              return;
            }
            const id = transfers.addDownload({
              group: BROWSER_DOWNLOADS,
              path: item.path,
              name: item.name,
              size: item.size >= 0 ? item.size : null,
              onDone: (done) => void handOver(done.id),
            });
            setFetching((before) => ({ ...before, [item.id]: id }));
          };
          const done = item.phase === "done";
          const broken = item.phase === "failed" || item.phase === "stalled";
          return (
            <li key={item.id} className="flex items-center gap-2 px-safe py-2">
              {broken ? (
                <CircleAlertIcon className="size-4 shrink-0 text-destructive" />
              ) : (
                <DownloadIcon
                  className={cn(
                    "size-4 shrink-0",
                    item.phase === "cancelled" ? "text-muted-foreground" : "text-lid",
                  )}
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.875rem] leading-5">{item.name}</span>
                <span className="block truncate text-[0.75rem] leading-4 text-muted-foreground">
                  {item.phase !== "done"
                    ? UNFINISHED[item.phase]
                    : transfer?.state === "failed"
                      ? describeTransferFailure(transfer, support.limits.maxBytes)
                      : transfer?.delivered
                        ? "Saved"
                        : transfer && progress !== null && transfer.state !== "done"
                          ? `Fetching ${Math.round(progress * 100)}%`
                          : `${item.size >= 0 ? `${formatSize(item.size)}, ` : ""}on your Mac`}
                </span>
              </span>
              {done && !transfer?.delivered ? (
                <Button
                  size="sm"
                  variant={transfer?.state === "done" ? "default" : "secondary"}
                  disabled={
                    support.state === "no" ||
                    (transfer !== null && transfer.state !== "done" && transfer.state !== "failed")
                  }
                  onClick={save}
                >
                  {transfer && transfer.state !== "done" && transfer.state !== "failed" ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  Save to phone
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground"
                aria-label={`Dismiss ${item.name}`}
                onClick={() => {
                  if (transfer) transfers.dismiss(transfer.id);
                  onDismiss(item.id);
                }}
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
