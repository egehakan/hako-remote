import { escapePathForPaste } from "@shared/transfers";
import {
  CheckIcon,
  CircleAlertIcon,
  ImageIcon,
  ImagePlusIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Spinner } from "@/components/ui/spinner";
import { describeTransferFailure, fraction } from "@/lib/transfers/describe";
import { ImageProblem, prepareImage } from "@/lib/transfers/image";
import type { Transfer } from "@/lib/transfers/queue";
import {
  attachGroup,
  sourceOf,
  transfers,
  useTransfers,
  useTransferSupport,
} from "@/lib/transfers/store";
import { cn } from "@/lib/utils";
import { keyClasses } from "./key-button";

/** A picture that is not on its way yet, or that arrived and could not be typed. */
type Held =
  | { id: number; name: string; state: "preparing" }
  | { id: number; name: string; state: "unreadable"; message: string }
  | { id: number; name: string; state: "untyped"; text: string };

const DONE_FOR_MS = 2_500;
const NOTE_FOR_MS = 7_000;

export type Attach = {
  /** What a tap on an attach button does: opens the phone's own choice of library, camera, files. */
  pick: () => void;
  /** False while the Hako on the Mac cannot take pictures. `pick` then says so instead. */
  available: boolean;
  /** The file input behind the buttons, to be rendered once. */
  picker: ReactNode;
  /** One chip for each picture on its way, to be rendered above the keys. */
  chips: ReactNode;
};

type AttachOptions = {
  sessionId: string;
  /**
   * Writes a picture's path where the owner is typing. False when it could not be written, which
   * leaves the picture on the Mac and the chip offering to try again.
   */
  insert: (text: string) => boolean;
};

/**
 * Pictures from the phone for the program in a terminal. Each is made into something Claude Code
 * takes, sent to the uploads area of the Mac, and its path is then pasted, in the order the
 * pictures were picked. Nothing is typed for a picture that did not arrive.
 */
export function useAttach({ sessionId, insert }: AttachOptions): Attach {
  const group = attachGroup(sessionId);
  const items = useTransfers(group);
  const support = useTransferSupport();
  const input = useRef<HTMLInputElement>(null);
  const [held, setHeld] = useState<Held[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const alive = useRef(false);
  const nextId = useRef(1);
  /** One picture is prepared at a time, so that they are sent in the order they were picked. */
  const preparing = useRef(Promise.resolve());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Leaving the terminal ends what was on its way to it: its path would have nowhere to go.
      transfers.drop(group);
    };
  }, [group]);

  useEffect(() => {
    if (note === null) return;
    const timer = window.setTimeout(() => setNote(null), NOTE_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [note]);

  const release = useCallback((id: number) => {
    setHeld((before) => before.filter((item) => item.id !== id));
  }, []);

  const arrived = useCallback((transfer: Transfer) => {
    if (!alive.current || !transfer.uploaded) return;
    const text = `${escapePathForPaste(transfer.uploaded.path)} `;
    if (insertRef.current(text)) {
      window.setTimeout(() => transfers.dismiss(transfer.id), DONE_FOR_MS);
    } else {
      transfers.dismiss(transfer.id);
      setHeld((before) => [
        ...before,
        { id: nextId.current++, name: transfer.name, state: "untyped", text },
      ]);
    }
  }, []);

  const add = (files: readonly File[]) => {
    for (const file of files) {
      const id = nextId.current++;
      setHeld((before) => [...before, { id, name: file.name, state: "preparing" }]);
      preparing.current = preparing.current.then(async () => {
        try {
          const prepared = await prepareImage(file);
          if (!alive.current) return;
          release(id);
          transfers.addUpload({
            group,
            source: sourceOf(prepared.blob),
            destination: { kind: "uploads" },
            name: prepared.name,
            onDone: arrived,
          });
        } catch (error) {
          const message =
            error instanceof ImageProblem
              ? error.message
              : `${file.name} could not be read on this device.`;
          setHeld((before) =>
            before.map((item) =>
              item.id === id ? { id, name: file.name, state: "unreadable", message } : item,
            ),
          );
        }
      });
    }
  };

  const pick = () => {
    if (support.state === "no") {
      setNote(
        "Update Hako on your Mac to attach pictures. The version running there can’t take them yet.",
      );
      return;
    }
    input.current?.click();
  };

  const retype = (item: Extract<Held, { state: "untyped" }>) => {
    if (insertRef.current(item.text)) release(item.id);
  };

  const picker = (
    <input
      ref={input}
      type="file"
      // Pictures only, which on an iPhone still offers the library, the camera and its files.
      accept="image/*"
      multiple
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
      onChange={(event) => {
        add(Array.from(event.target.files ?? []));
        // Emptied so that picking the same picture again is a change too.
        event.target.value = "";
      }}
    />
  );

  const shown = held.length > 0 || items.length > 0 || note !== null;
  const chips = shown ? (
    <ul
      aria-label="Pictures being attached"
      aria-live="polite"
      className="flex flex-wrap items-start gap-1.5 px-1 pt-1.5"
    >
      {note !== null ? (
        <Chip tone="plain" wide>
          <ImagePlusIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-lid" />
          <span className="min-w-0 flex-1 py-2 font-sans leading-4">{note}</span>
          <ChipButton label="Dismiss" onClick={() => setNote(null)}>
            <XIcon />
          </ChipButton>
        </Chip>
      ) : null}
      {held.map((item) =>
        item.state === "preparing" ? (
          <Chip key={`held-${item.id}`} tone="plain">
            <Spinner aria-label="Preparing" className="size-3.5 text-muted-foreground" />
            <ChipName name={item.name} />
            <span className="pr-2.5 text-muted-foreground">preparing…</span>
          </Chip>
        ) : item.state === "unreadable" ? (
          <Chip key={`held-${item.id}`} tone="error" wide>
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 py-2 font-sans leading-4">{item.message}</span>
            <ChipButton label="Dismiss" onClick={() => release(item.id)}>
              <XIcon />
            </ChipButton>
          </Chip>
        ) : (
          <Chip key={`held-${item.id}`} tone="error" wide>
            <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 py-2 font-sans leading-4">
              {item.name} is on your Mac, but this terminal isn’t connected, so its path was not
              typed.
            </span>
            <ChipButton text onClick={() => retype(item)}>
              Type it
            </ChipButton>
            <ChipButton label={`Forget ${item.name}`} onClick={() => release(item.id)}>
              <XIcon />
            </ChipButton>
          </Chip>
        ),
      )}
      {items.map((item) => (
        <TransferChip key={item.id} item={item} maxBytes={support.limits.maxBytes} />
      ))}
    </ul>
  ) : null;

  return { pick, available: support.state !== "no", picker, chips };
}

function TransferChip({ item, maxBytes }: { item: Transfer; maxBytes: number }) {
  const forget = () => {
    transfers.cancel(item.id);
    transfers.dismiss(item.id);
  };
  if (item.state === "failed") {
    const final = item.error?.code === "too_large" || item.error?.code === "not_supported";
    return (
      <Chip tone="error" wide>
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1 py-2 font-sans leading-4">
          {item.name} was not attached. {describeTransferFailure(item, maxBytes)}
        </span>
        {final ? null : (
          <ChipButton text onClick={() => transfers.retry(item.id)}>
            Try again
          </ChipButton>
        )}
        <ChipButton label={`Forget ${item.name}`} onClick={forget}>
          <XIcon />
        </ChipButton>
      </Chip>
    );
  }
  if (item.state === "done") {
    return (
      <Chip tone="done">
        <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
        <ChipName name={item.uploaded?.name ?? item.name} />
        <span className="pr-2.5">attached</span>
      </Chip>
    );
  }
  const part = fraction(item) ?? 0;
  const paused = item.state === "paused";
  return (
    <Chip tone="plain">
      {paused ? (
        <UnplugIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <ImageIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
      <ChipName name={item.name} />
      <span className="text-muted-foreground tabular-nums">
        {paused ? "waiting for your Mac" : `${Math.round(part * 100)}%`}
      </span>
      <ChipButton label={`Cancel attaching ${item.name}`} onClick={forget}>
        <XIcon />
      </ChipButton>
      <span
        role="progressbar"
        aria-label={`Sending ${item.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(part * 100)}
        className="absolute inset-x-0 bottom-0 h-0.5 bg-input/60"
      >
        <span
          className={cn(
            "block h-full origin-left transition-transform duration-200 ease-out",
            paused ? "bg-muted-foreground" : "bg-amber",
          )}
          style={{ transform: `scaleX(${part})` }}
        />
      </span>
    </Chip>
  );
}

const CHIP_TONES = {
  plain: "border-border bg-card",
  done: "border-settled/40 bg-card text-settled",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

function Chip({
  tone,
  wide = false,
  children,
}: {
  tone: keyof typeof CHIP_TONES;
  /** A chip that holds a sentence takes the whole row and as many lines as the sentence needs. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "relative flex max-w-full gap-2 overflow-hidden rounded-md border pl-2.5 font-mono text-xs",
        wide ? "min-h-9 w-full items-start" : "h-9 items-center",
        CHIP_TONES[tone],
      )}
    >
      {children}
    </li>
  );
}

function ChipName({ name }: { name: string }) {
  return (
    <span className="max-w-36 truncate" translate="no">
      {name}
    </span>
  );
}

function ChipButton({
  label,
  text = false,
  onClick,
  children,
}: {
  label?: string;
  /** A button with words in it, where the others hold an icon. */
  text?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "flex h-9 shrink-0 items-center justify-center rounded-md outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset [&_svg]:size-4",
        text
          ? "px-2 font-sans font-medium underline-offset-4 hover:underline"
          : "w-9 text-muted-foreground",
      )}
      // Stops the press from moving focus away from the terminal's text field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type AttachKeyProps = Omit<ComponentProps<"button">, "type" | "onClick"> & {
  attach: Pick<Attach, "pick" | "available">;
};

/**
 * The key bar's way to attach a picture. Unlike the other keys it acts on the click itself: a
 * browser opens its file picker only from within a click or a tap, and it need not repeat.
 */
export function AttachKey({ attach, className, disabled, ...props }: AttachKeyProps) {
  return (
    <button
      type="button"
      aria-label="Attach a picture"
      title="Attach a picture"
      disabled={disabled}
      aria-disabled={disabled || !attach.available}
      className={cn(keyClasses(), !attach.available && "opacity-40", className)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={attach.pick}
      {...props}
    >
      <ImagePlusIcon aria-hidden="true" />
    </button>
  );
}
