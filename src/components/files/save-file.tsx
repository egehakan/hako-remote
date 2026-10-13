import { DownloadIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { formatSize } from "@/lib/files/format";
import { parentOf } from "@/lib/files/paths";
import { useConnection } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { isTouchDevice } from "@/lib/terminal/prefs";
import { saveToDevice } from "@/lib/transfers/actions";
import { useTransferSupport } from "@/lib/transfers/store";

/** What the action is called: a phone is "your phone", and anything else is not. */
export const SAVE_LABEL = isTouchDevice() ? "Save to phone" : "Save to this computer";

export type Saving = {
  /** False while saving cannot be started, and `reason` says why. */
  possible: boolean;
  reason: string | null;
};

/** Whether a file of `size` bytes can be fetched from the Mac right now. */
export function useSaving(size: number | null): Saving {
  const { link, agent } = useConnection();
  const support = useTransferSupport();
  if (support.state === "no") return { possible: false, reason: NEEDS_NEWER_HAKO };
  if (link !== "open" || agent?.online !== true) {
    return { possible: false, reason: "Your Mac is offline." };
  }
  if (size !== null && size > support.limits.maxBytes) {
    return {
      possible: false,
      reason: `Over the ${formatSize(support.limits.maxBytes)} limit for saving from here.`,
    };
  }
  return { possible: true, reason: null };
}

export type MenuFile = { path: string; name: string; size: number };

type FileMenuProps = {
  file: MenuFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** What can be done with one file of a folder's list, without opening it. */
export function FileMenu({ file, open, onOpenChange }: FileMenuProps) {
  const saving = useSaving(file?.size ?? null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-lg gap-0 rounded-t-2xl border-x pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle className="truncate font-mono" translate="no">
            {file?.name ?? "File"}
          </SheetTitle>
          {file ? (
            <SheetDescription className="truncate font-mono text-xs leading-5" translate="no">
              {tildify(parentOf(file.path) ?? "/")}
            </SheetDescription>
          ) : null}
        </SheetHeader>
        {file ? (
          <div className="flex flex-col border-t">
            <button
              type="button"
              disabled={!saving.possible}
              onClick={() => {
                onOpenChange(false);
                saveToDevice(file.path, file.name, file.size);
              }}
              className="flex min-h-14 w-full items-center gap-3.5 px-4 py-2 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:text-muted-foreground"
            >
              <DownloadIcon className="size-5 shrink-0" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-base font-medium">{SAVE_LABEL}</span>
                <span className="text-[0.8125rem] leading-5 text-muted-foreground">
                  {saving.reason ?? formatSize(file.size)}
                </span>
              </span>
            </button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
