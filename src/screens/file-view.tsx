import { isImageMime } from "@shared/files";
import type { FsReadResult, FsWriteParams, FsWriteResult } from "@shared/protocol";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  DownloadIcon,
  FileDigitIcon,
  PencilIcon,
  RefreshCwIcon,
  ScaleIcon,
  SearchIcon,
  UnplugIcon,
  WrapTextIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiscardDialog } from "@/components/files/discard-dialog";
import { EditBar } from "@/components/files/edit-bar";
import { FindBar } from "@/components/files/find-bar";
import { ImageView } from "@/components/files/image-view";
import { SAVE_LABEL, useSaving } from "@/components/files/save-file";
import { FsProblem } from "@/components/files/states";
import { TransferTray } from "@/components/files/transfer-tray";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { relay } from "@/lib/connection";
import { CodeEditor } from "@/lib/files/editor";
import { formatSize } from "@/lib/files/format";
import { type LanguageId, languageLabel, languageOf } from "@/lib/files/language";
import { loadLanguage } from "@/lib/files/language-loader";
import { baseName, parentOf } from "@/lib/files/paths";
import { detectLineEnding, type SaveOutcome, SaveGuard } from "@/lib/files/save";
import {
  filesPrefs,
  type FsError,
  refreshListing,
  toFsError,
  useFilesPrefs,
} from "@/lib/files/store";
import { useConnection, useWide } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { IOS } from "@/lib/platform";
import { navigate, type Route, routes, setNavigationBlocker } from "@/lib/route";
import { isTouchDevice } from "@/lib/terminal/prefs";
import { saveToDevice } from "@/lib/transfers/actions";
import { useVisibleViewport } from "@/lib/terminal/viewport";
import { cn } from "@/lib/utils";

const MarkdownView = lazy(() => import("@/components/files/markdown-view"));

type Loaded =
  | { state: "loading" }
  | { state: "ready"; result: FsReadResult; readAt: number }
  | { state: "error"; error: FsError };

/** One file on the Mac: read, shown as what it is, and for text, edited and saved. */
export default function FileView({ path }: { path: string }) {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const keyboardOpen = useVisibleViewport();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [reloading, setReloading] = useState(false);
  const shownOnce = useRef(false);

  const read = useCallback(async () => {
    setReloading(true);
    try {
      const result = await relay.request<FsReadResult>("fs.read", { path });
      // Read again, so the folder's size and time for this file may be out of date too.
      if (shownOnce.current) refreshListing(parentOf(path) ?? "/");
      shownOnce.current = true;
      setLoaded({ state: "ready", result, readAt: Date.now() });
    } catch (failure) {
      const error = toFsError(failure);
      // A link may have guessed wrong about what is at the end of a path.
      if (error.code === "is_a_directory") navigate(routes.dir(path), { replace: true });
      // A file already on screen is worth more than the news that it could not be read again.
      else setLoaded((before) => (before.state === "ready" ? before : { state: "error", error }));
    } finally {
      setReloading(false);
    }
  }, [path]);

  const pending = loaded.state !== "ready";
  useEffect(() => {
    if (online && pending) void read();
  }, [online, pending, read]);

  const name = baseName(path);
  const directory = parentOf(path) ?? "/";
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  if (loaded.state === "ready" && loaded.result.kind === "text") {
    return (
      <TextFile
        // A fresh read is a fresh document: the editor starts over from what the Mac has now.
        key={loaded.readAt}
        path={path}
        content={loaded.result.content}
        mtime={loaded.result.mtime}
        size={loaded.result.size}
        online={online}
        keyboardOpen={keyboardOpen}
        reloading={reloading}
        onReload={read}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <FileHeader name={name} directory={directory}>
        {loaded.state === "ready" ? (
          <SaveButton
            path={path}
            name={name}
            size={loaded.result.size}
            onUnavailable={setSaveNotice}
          />
        ) : null}
      </FileHeader>
      {saveNotice ? <SaveNotice text={saveNotice} onDismiss={() => setSaveNotice(null)} /> : null}
      {loaded.state === "loading" ? (
        link === "open" && agent?.online === false ? (
          <FileNotice
            icon={UnplugIcon}
            title="Hako isn’t connected"
            detail="This file opens by itself when Hako on your Mac is back."
          />
        ) : (
          <div
            className="flex flex-col gap-2.5 px-safe py-4"
            aria-busy="true"
            aria-label="Loading the file"
          >
            {["w-3/5", "w-4/5", "w-2/5", "w-3/4", "w-1/2", "w-2/3"].map((width) => (
              <Skeleton key={width} className={cn("h-3.5", width)} />
            ))}
          </div>
        )
      ) : loaded.state === "error" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FsProblem error={loaded.error} what="file">
            {loaded.error.code === "not_supported" ? null : (
              <Button variant="secondary" size="touch" onClick={() => void read()}>
                Try again
              </Button>
            )}
          </FsProblem>
        </div>
      ) : loaded.result.kind === "image" ? (
        <ImageFile name={name} result={loaded.result} />
      ) : loaded.result.kind === "too_large" ? (
        <FileNotice
          icon={ScaleIcon}
          title="Too large to open here"
          detail={`${name} is ${formatSize(loaded.result.size)}. ${
            loaded.result.limit > 2 * 1024 * 1024 ? "Pictures" : "Text files"
          } open up to ${formatSize(loaded.result.limit)}; open this one on your Mac.`}
        >
          <SaveOffer path={path} name={name} size={loaded.result.size} />
        </FileNotice>
      ) : (
        <FileNotice
          icon={FileDigitIcon}
          title="Not a text file"
          detail={`${name} holds ${formatSize(loaded.result.size)} of binary data, or text that is not UTF-8, which can’t be shown or edited here.`}
        >
          <SaveOffer path={path} name={name} size={loaded.result.size} />
        </FileNotice>
      )}
      {/* Beside the list, the list shows the transfers. */}
      <TransferTray className="wide:hidden" />
    </div>
  );
}

type SaveProps = { path: string; name: string; size: number };

/**
 * The header's way to fetch the open file. While that cannot be done the button still answers a
 * tap, with the reason, since a greyed-out icon on a phone explains nothing.
 */
function SaveButton({
  path,
  name,
  size,
  onUnavailable,
}: SaveProps & { onUnavailable: (reason: string) => void }) {
  const saving = useSaving(size);
  return (
    <Button
      variant="ghost"
      size="icon-touch"
      className={cn("size-11", !saving.possible && "opacity-45")}
      aria-label={SAVE_LABEL}
      aria-disabled={!saving.possible}
      title={saving.reason ?? SAVE_LABEL}
      onClick={() => {
        if (saving.possible) saveToDevice(path, name, size);
        else if (saving.reason) onUnavailable(saving.reason);
      }}
    >
      <DownloadIcon />
    </Button>
  );
}

/** The same, spelt out, for a file that cannot be shown: fetching it is all there is to do. */
function SaveOffer({ path, name, size }: SaveProps) {
  const saving = useSaving(size);
  return (
    <>
      <Button
        variant="secondary"
        size="touch"
        disabled={!saving.possible}
        onClick={() => saveToDevice(path, name, size)}
      >
        <DownloadIcon data-icon="inline-start" />
        {SAVE_LABEL}
      </Button>
      {saving.reason ? <p className="text-muted-foreground">{saving.reason}</p> : null}
    </>
  );
}

function SaveNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <Banner tone="quiet" icon={DownloadIcon}>
      <p>{text}</p>
      <Button variant="ghost" className="mt-1 h-9 px-2.5" onClick={onDismiss}>
        Dismiss
      </Button>
    </Banner>
  );
}

type FileHeaderProps = {
  name: string;
  directory: string;
  /** Replaces the directory under the name: what state an edit is in. */
  status?: React.ReactNode;
  children?: React.ReactNode;
};

function FileHeader({ name, directory, status, children }: FileHeaderProps) {
  return (
    <header className="flex shrink-0 items-center gap-0.5 border-b pt-safe pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.125rem,env(safe-area-inset-left))] wide:pl-4">
      <Button
        variant="ghost"
        size="icon-touch"
        className="size-11 wide:hidden"
        aria-label="Back to the folder"
        nativeButton={false}
        render={<a href={routes.dir(directory)} />}
      >
        <ChevronLeftIcon />
      </Button>
      <div className="flex min-h-12 min-w-0 flex-1 flex-col justify-center px-1.5 py-1">
        <h1 className="truncate font-mono text-[0.9375rem] leading-5 font-bold" translate="no">
          {name}
        </h1>
        <p
          className="truncate text-[0.6875rem] leading-4 text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {status ?? (
            <span className="font-mono" translate="no">
              {tildify(directory)}
            </span>
          )}
        </p>
      </div>
      {children}
    </header>
  );
}

type FileNoticeProps = {
  icon: React.ComponentType;
  title: string;
  detail: string;
  /** What can still be done with the file. */
  children?: React.ReactNode;
};

function FileNotice({ icon: Icon, title, detail, children }: FileNoticeProps) {
  return (
    <Empty className="min-h-0 py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-3 border-b py-1 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] font-mono text-[0.6875rem] text-muted-foreground wide:pl-5">
      {children}
    </div>
  );
}

type ImageFileProps = { name: string; result: Extract<FsReadResult, { kind: "image" }> };

function ImageFile({ name, result }: ImageFileProps) {
  const [dimensions, setDimensions] = useState<string | null>(null);
  if (!isImageMime(result.mime)) {
    return (
      <FileNotice
        icon={FileDigitIcon}
        title="Not a picture this app can show"
        detail={`Your Mac sent ${name} as ${result.mime}.`}
      />
    );
  }
  return (
    <>
      <Strip>
        <span>{result.mime.slice(6).replace("+xml", "").toUpperCase()}</span>
        {dimensions ? <span>{dimensions}</span> : null}
        <span>{formatSize(result.size)}</span>
      </Strip>
      <div className="min-h-0 flex-1">
        <ImageView
          // An <img> runs nothing inside the file, which matters for an SVG.
          src={`data:${result.mime};base64,${result.data}`}
          name={name}
          onSize={(width, height) => setDimensions(`${width} × ${height}`)}
        />
      </div>
    </>
  );
}

function saveFailure(outcome: Extract<SaveOutcome, { kind: "failed" }>): string {
  switch (outcome.code) {
    case "agent_offline":
    case "disconnected":
      return "Not saved: your Mac is offline. Your text is still here; save again when it is back.";
    case "timeout":
      return "Not saved: your Mac didn’t answer. Your text is still here; try again.";
    case "not_found":
      return "Not saved: this file no longer exists on your Mac, and saving from here can’t create it.";
    case "too_large":
      return "Not saved: the text is over 2 MB, the most that can be saved from here.";
    case "not_supported":
      return "Not saved: the Hako on your Mac can’t save files from here yet. Update it and try again.";
    default:
      return outcome.message
        ? `Not saved. Your Mac said: ${outcome.message}`
        : "Not saved: your Mac couldn’t write the file. Your text is still here.";
  }
}

const writeFile = (params: FsWriteParams) => relay.request<FsWriteResult>("fs.write", params);

type TextFileProps = {
  path: string;
  content: string;
  mtime: number;
  size: number;
  online: boolean;
  keyboardOpen: boolean;
  reloading: boolean;
  onReload: () => Promise<void>;
};

function TextFile({
  path,
  content,
  mtime,
  size,
  online,
  keyboardOpen,
  reloading,
  onReload,
}: TextFileProps) {
  const name = baseName(path);
  const directory = parentOf(path) ?? "/";
  const [touch] = useState(isTouchDevice);
  const wide = useWide();
  const prefs = useFilesPrefs();
  const language = useMemo<LanguageId>(
    () => languageOf(name, content.slice(0, 120).split("\n", 1)[0]),
    [name, content],
  );
  const isMarkdown = language === "markdown";
  const wrap = prefs.wrap ?? (isMarkdown || language === "text");

  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  const [guard] = useState(() => new SaveGuard(path, mtime, writeFile));
  const [lineEnding] = useState(() => detectLineEnding(content));
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [bytes, setBytes] = useState(size);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [rendered, setRendered] = useState<string | null>(null);
  /** Where the owner was going when unsaved text stopped them: an address, or out of edit mode. */
  const [leaving, setLeaving] = useState<{ to: string | null } | null>(null);

  const save = useCallback(
    async (overwrite = false) => {
      if (!editor) return;
      const doc = editor.snapshot();
      setSaving(true);
      setProblem(null);
      const outcome = await guard.save(editor.text(lineEnding, doc), { overwrite });
      setSaving(false);
      switch (outcome.kind) {
        case "saved":
          editor.markSaved(doc);
          setBytes(outcome.size);
          refreshListing(directory);
          setConflict(false);
          setSavedOnce(true);
          break;
        case "conflict":
          setConflict(true);
          break;
        case "failed":
          setProblem(saveFailure(outcome));
          break;
        case "busy":
          break;
      }
    },
    [editor, guard, lineEnding, directory],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!host.current) return;
    const created = new CodeEditor(host.current, content, wrap, {
      onDirtyChange: setDirty,
      onFocusChange: () => {},
      onSave: () => void saveRef.current(),
    });
    setEditor(created);
    let cancelled = false;
    void loadLanguage(language).then((extension) => {
      if (!cancelled && extension) created.setLanguage(extension);
    });
    return () => {
      cancelled = true;
      created.destroy();
      setEditor(null);
    };
    // Built once per read: `wrap` is left out on purpose, and kept current by the effect below.
  }, [content, language]);

  useEffect(() => editor?.setWrap(wrap), [editor, wrap]);

  // Unsaved text holds navigation back until the owner has said what should happen to it.
  const wideRef = useRef(wide);
  wideRef.current = wide;
  useEffect(() => {
    if (!dirty) return;
    setNavigationBlocker({
      blocks: (next: Route) => {
        if (next.name === "file") return next.path !== path;
        // Beside the list, browsing folders leaves the file where it is.
        return !(wideRef.current && (next.name === "dir" || next.name === "files"));
      },
      onBlocked: (hash) => setLeaving({ to: hash }),
    });
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      setNavigationBlocker(null);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, path]);

  // An iPhone zooms the page when a field with small text takes focus, and stays zoomed. While
  // editing it may not; pinching still zooms there, which is why this is kept to iOS.
  useEffect(() => {
    if (!editing || !touch || !IOS) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const before = meta.content;
    meta.content = `${before}, maximum-scale=1`;
    return () => {
      meta.content = before;
    };
  }, [editing, touch]);

  const startEditing = () => {
    setRendered(null);
    setEditing(true);
    editor?.setEditing(true);
  };

  const stopEditing = () => {
    if (dirty) {
      setLeaving({ to: null });
      return;
    }
    setEditing(false);
    setConflict(false);
    setProblem(null);
    editor?.setEditing(false);
  };

  const discard = () => {
    const target = leaving?.to ?? null;
    setLeaving(null);
    setNavigationBlocker(null);
    editor?.revert();
    setConflict(false);
    setProblem(null);
    if (target !== null) {
      navigate(target);
    } else {
      setEditing(false);
      editor?.setEditing(false);
    }
  };

  const status = saving ? (
    "Saving…"
  ) : dirty ? (
    <span className="text-lid">Unsaved changes</span>
  ) : editing && savedOnce ? (
    <span className="text-settled">Saved to your Mac</span>
  ) : editing ? (
    "Editing. Nothing changed yet."
  ) : undefined;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f" &&
          rendered === null
        ) {
          event.preventDefault();
          setFinding(true);
        }
      }}
    >
      <FileHeader name={name} directory={directory} status={status}>
        {rendered === null ? (
          <Button
            variant="ghost"
            size="icon-touch"
            className={cn("size-11", finding && "text-lid")}
            aria-label="Find in this file"
            aria-pressed={finding}
            onClick={() => setFinding((open) => !open)}
          >
            <SearchIcon />
          </Button>
        ) : null}
        {editing ? (
          <>
            <Button
              className="h-9 px-3"
              disabled={!dirty || saving || !online || conflict}
              onClick={() => void save()}
            >
              {saving ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
            <Button variant="ghost" className="h-9 px-2.5" onClick={stopEditing}>
              Done
            </Button>
          </>
        ) : (
          <>
            <SaveButton path={path} name={name} size={bytes} onUnavailable={setSaveNotice} />
            <Button
              variant="ghost"
              size="icon-touch"
              className="size-11"
              aria-label="Edit this file"
              disabled={!editor}
              onClick={startEditing}
            >
              <PencilIcon />
            </Button>
          </>
        )}
      </FileHeader>

      <Strip>
        <span>{languageLabel(language)}</span>
        <span>{formatSize(bytes)}</span>
        {lineEnding === "\r\n" ? <span>CRLF</span> : null}
        <span className="flex-1" />
        {isMarkdown && !editing ? (
          <ToggleGroup
            aria-label="How to show this document"
            size="sm"
            spacing={0}
            value={[rendered === null ? "raw" : "rendered"]}
            onValueChange={(next) => {
              const choice = next[0];
              if (choice === "rendered") {
                setFinding(false);
                setRendered(editor ? editor.text("\n") : content);
              } else if (choice === "raw") {
                setRendered(null);
              }
            }}
          >
            <ToggleGroupItem value="raw" className="font-sans aria-pressed:text-lid">
              Raw
            </ToggleGroupItem>
            <ToggleGroupItem value="rendered" className="font-sans aria-pressed:text-lid">
              Rendered
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {rendered === null ? (
          <Toggle
            size="sm"
            aria-label="Wrap long lines"
            className="font-sans aria-pressed:text-lid"
            pressed={wrap}
            onPressedChange={(pressed) => filesPrefs.set({ wrap: pressed })}
          >
            <WrapTextIcon />
            Wrap
          </Toggle>
        ) : null}
        {!editing ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Read the file again from your Mac"
            disabled={reloading || !online}
            onClick={() => void onReload()}
          >
            <RefreshCwIcon className={cn(reloading && "motion-safe:animate-spin")} />
          </Button>
        ) : null}
      </Strip>

      {editing && !online ? (
        <Banner tone="quiet" icon={UnplugIcon}>
          Your Mac is offline. Keep writing; saving works again when it is back.
        </Banner>
      ) : null}
      {conflict ? (
        <Banner tone="warning" icon={CircleAlertIcon}>
          <p>
            <span className="font-medium">This file changed on your Mac after you opened it.</span>{" "}
            Nothing was saved, and your text is still here. Choose which version to keep.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="h-10 px-3"
              disabled={reloading || !online}
              onClick={() => void onReload()}
            >
              {reloading ? <Spinner data-icon="inline-start" /> : null}
              Reload and discard your edit
            </Button>
            <Button
              variant="destructive"
              className="h-10 px-3"
              disabled={saving || !online}
              onClick={() => void save(true)}
            >
              Overwrite the Mac’s version
            </Button>
          </div>
        </Banner>
      ) : null}
      {problem ? (
        <Banner tone="error" icon={CircleAlertIcon}>
          <p className="break-words">{problem}</p>
          <Button variant="ghost" className="mt-1 h-9 px-2.5" onClick={() => setProblem(null)}>
            Dismiss
          </Button>
        </Banner>
      ) : null}
      {saveNotice && !editing ? (
        <SaveNotice text={saveNotice} onDismiss={() => setSaveNotice(null)} />
      ) : null}
      {finding && editor && rendered === null ? (
        <FindBar editor={editor} onClose={() => setFinding(false)} />
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={host}
          className={cn("code-host absolute inset-0", rendered !== null && "invisible")}
          translate="no"
        />
        {rendered !== null ? (
          <div className="absolute inset-0">
            <Suspense fallback={null}>
              <MarkdownView source={rendered} directory={directory} />
            </Suspense>
          </div>
        ) : null}
      </div>

      <TransferTray className="wide:hidden" />
      {editing && touch && editor ? <EditBar editor={editor} keyboardOpen={keyboardOpen} /> : null}

      <DiscardDialog
        open={leaving !== null}
        fileName={name}
        onStay={() => setLeaving(null)}
        onDiscard={discard}
      />
    </div>
  );
}

type BannerProps = {
  tone: "quiet" | "warning" | "error";
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
};

const BANNER_TONES = {
  quiet: "border-border bg-card",
  warning: "border-amber/40 bg-[color-mix(in_oklab,var(--amber)_16%,var(--background))]",
  error: "border-destructive/40 bg-destructive/10",
} as const;

const BANNER_ICONS = {
  quiet: "text-muted-foreground",
  warning: "text-amber",
  error: "text-destructive",
} as const;

function Banner({ tone, icon: Icon, children }: BannerProps) {
  return (
    <div
      role={tone === "quiet" ? "status" : "alert"}
      className={cn(
        "flex shrink-0 items-start gap-2.5 border-b py-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] text-[0.8125rem] leading-5 wide:pl-5",
        BANNER_TONES[tone],
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", BANNER_ICONS[tone])} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
