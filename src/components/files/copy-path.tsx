import { CheckIcon, ClipboardCopyIcon, CornerDownRightIcon, EllipsisIcon } from "lucide-react";
import { type ComponentType, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { copyNotices, copyText } from "@/lib/clipboard";
import { relativePathFor, shortenMiddle } from "@/lib/files/copy-path";
import { useRoots } from "@/lib/files/store";
import { homeDirectory, tildify } from "@/lib/paths";

export const COPY_PATH_LABEL = "Copy path";
export const COPY_RELATIVE_PATH_LABEL = "Copy relative path";

/** Copies a path, whole or relative to its root, from a tap. */
export function usePathCopy() {
  const { data } = useRoots();
  const roots = data?.roots ?? [];
  return {
    copyPath: (path: string) => copyText(path),
    copyRelativePath: (path: string) =>
      copyText(relativePathFor(path, roots, data?.home ?? homeDirectory())),
  };
}

const SHOWN_MS = 2400;

/** Says what was copied, or offers the text to copy by hand when the browser would not. */
export function CopyNotice() {
  const notice = useSyncExternalStore(copyNotices.subscribe, copyNotices.getSnapshot);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice?.copied) return;
    const timer = window.setTimeout(() => copyNotices.dismiss(notice.id), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectAll = () => {
    const input = field.current;
    if (!input) return;
    input.focus();
    // iOS ignores select() on a read-only field; a range it takes.
    input.setSelectionRange(0, input.value.length);
  };

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.75rem)] z-50 flex justify-center px-4"
      >
        {notice?.copied ? (
          <p className="flex max-w-full items-center gap-2 rounded-full border bg-popover px-3.5 py-2 text-[0.8125rem] leading-5 text-popover-foreground shadow-lg">
            <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-lid" />
            <span className="shrink-0 font-medium">Copied</span>
            <span className="min-w-0 truncate font-mono text-muted-foreground" translate="no">
              {shortenMiddle(notice.text, 40)}
            </span>
          </p>
        ) : null}
      </div>
      <Sheet
        open={notice !== null && !notice.copied}
        onOpenChange={(open) => {
          if (!open && notice) copyNotices.dismiss(notice.id);
        }}
      >
        <SheetContent
          side="bottom"
          className="mx-auto max-w-lg rounded-t-2xl border-x px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          initialFocus={field}
        >
          <SheetHeader className="px-0 pr-10">
            <SheetTitle>Copy it by hand</SheetTitle>
            <SheetDescription>
              This browser did not let the page copy. Select the path and copy it.
            </SheetDescription>
          </SheetHeader>
          <Input
            ref={field}
            readOnly
            name="copy-path"
            autoComplete="off"
            spellCheck={false}
            value={notice?.text ?? ""}
            aria-label="Path"
            className="font-mono text-[0.9375rem]"
            translate="no"
            onFocus={(event) =>
              event.currentTarget.setSelectionRange(0, event.currentTarget.value.length)
            }
          />
          <Button size="touch" variant="secondary" onClick={selectAll}>
            Select all
          </Button>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The open file's menu: its path to copy, whole or relative to its root. */
export function PathMenuButton({ path, name }: { path: string; name: string }) {
  const [open, setOpen] = useState(false);
  const { copyPath, copyRelativePath } = usePathCopy();
  const run = (copy: (path: string) => void) => () => {
    setOpen(false);
    copy(path);
  };
  return (
    <>
      <Button
        variant="ghost"
        size="icon-touch"
        className="size-11"
        aria-label="More for this file"
        onClick={() => setOpen(true)}
      >
        <EllipsisIcon />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-w-lg gap-0 rounded-t-2xl border-x pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="pr-12">
            <SheetTitle className="truncate font-mono" translate="no">
              {name}
            </SheetTitle>
            <SheetDescription className="truncate font-mono text-xs leading-5" translate="no">
              {tildify(path)}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col border-t pt-1">
            <MenuAction icon={ClipboardCopyIcon} label={COPY_PATH_LABEL} onClick={run(copyPath)} />
            <MenuAction
              icon={CornerDownRightIcon}
              label={COPY_RELATIVE_PATH_LABEL}
              onClick={run(copyRelativePath)}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

type MenuActionProps = {
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  label: string;
  onClick: () => void;
};

function MenuAction({ icon: Icon, label, onClick }: MenuActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-13 w-full items-center gap-3.5 px-4 py-1.5 text-left text-base font-medium outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}
