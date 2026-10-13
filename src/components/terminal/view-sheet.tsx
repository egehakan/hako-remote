import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import type { Size } from "@/lib/terminal/session";

type ViewSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The terminal's size right now. */
  size: Size;
  fitPhone: boolean;
  onFitPhoneChange: (fit: boolean) => void;
  fitError: string | null;
  /** The magnification as shown to the owner, such as "100%" or "12 px". */
  zoomLabel: string;
  onZoom: (direction: 1 | -1 | 0) => void;
  canZoomOut: boolean;
  canZoomIn: boolean;
};

/** Size and zoom: whose size the terminal has, and how large its text is drawn here. */
export function ViewSheet({
  open,
  onOpenChange,
  size,
  fitPhone,
  onFitPhoneChange,
  fitError,
  zoomLabel,
  onZoom,
  canZoomOut,
  canZoomIn,
}: ViewSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-lg gap-0 rounded-t-2xl border-x pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>Size and zoom</SheetTitle>
          <SheetDescription>
            The terminal is{" "}
            <span className="font-mono text-foreground" translate="no">
              {size.cols} × {size.rows}
            </span>{" "}
            right now, {fitPhone ? "sized for this screen" : "the size it has on your Mac"}.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col divide-y border-y">
          <label className="flex min-h-16 items-center gap-4 px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base font-medium">Fit to phone</span>
              <span className="text-[0.8125rem] leading-5 text-muted-foreground">
                {fitPhone
                  ? "Your Mac’s terminal is resized to this screen. It gets its own size back when you leave or turn this off."
                  : "Resizes the terminal on your Mac to this screen, so text is readable without zooming. Off, you see the Mac’s size, scaled down."}
              </span>
            </span>
            <Switch checked={fitPhone} onCheckedChange={onFitPhoneChange} />
          </label>

          <div className="flex min-h-16 items-center gap-2 px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base font-medium">Text size</span>
              <span className="font-mono text-[0.8125rem] leading-5 text-muted-foreground">
                {zoomLabel}
              </span>
            </span>
            <Button variant="ghost" className="h-11 px-3 text-sm" onClick={() => onZoom(0)}>
              Reset
            </Button>
            <Button
              variant="secondary"
              size="icon-touch"
              aria-label="Smaller text"
              disabled={!canZoomOut}
              onClick={() => onZoom(-1)}
            >
              <MinusIcon />
            </Button>
            <Button
              variant="secondary"
              size="icon-touch"
              aria-label="Larger text"
              disabled={!canZoomIn}
              onClick={() => onZoom(1)}
            >
              <PlusIcon />
            </Button>
          </div>
        </div>

        {fitError ? (
          <p role="alert" className="px-4 pt-3 text-sm text-destructive">
            {fitError}
          </p>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
