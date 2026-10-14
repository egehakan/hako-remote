import { CheckIcon, MonitorSmartphoneIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  CUSTOM_MAX,
  CUSTOM_MIN,
  clampDimension,
  VIEWPORTS,
  type ViewChoice,
  type ViewportPreset,
} from "@/lib/previews/viewports";
import { cn } from "@/lib/utils";

type ViewportSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choice: ViewChoice;
  onChoose: (choice: ViewChoice) => void;
  /** The width the page reports for itself, in CSS pixels, when it has said. */
  pageWidth: number | null;
};

const GROUPS: ViewportPreset["group"][] = ["Phones", "Tablets", "Computers"];

/** Which browser shows the page, and at what size. */
export function ViewportSheet({
  open,
  onOpenChange,
  choice,
  onChoose,
  pageWidth,
}: ViewportSheetProps) {
  const [width, setWidth] = useState(String(choice.custom.width));
  const [height, setHeight] = useState(String(choice.custom.height));

  const pick = (viewport: string) => {
    onChoose({ ...choice, viewport, zoom: null });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] max-w-lg gap-0 overflow-y-auto rounded-t-2xl border-x pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>Viewport</SheetTitle>
          <SheetDescription>
            A fixed size shows the page exactly as wide as that device and scales it down to fit
            here. Fit fills the space this screen has.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-3">
          <p className="pb-1.5 text-[0.8125rem] text-muted-foreground">Shown in</p>
          <div className="flex items-center gap-3 rounded-lg border border-lid/50 bg-secondary px-3 py-2.5">
            <MonitorSmartphoneIcon className="size-5 shrink-0 text-lid" />
            <span className="min-w-0 flex-1">
              <span className="block text-[0.9375rem] leading-5 font-medium">Phone browser</span>
              <span className="block text-[0.8125rem] leading-5 text-muted-foreground">
                The page runs in this browser, served by the dev server on your Mac.
              </span>
            </span>
            <CheckIcon className="size-4 text-lid" aria-label="Chosen" />
          </div>
        </div>

        <ul className="px-2" aria-label="Sizes">
          <Choice
            label="Fit"
            detail={pageWidth ? `${pageWidth} px wide here` : "As wide as this screen allows"}
            chosen={choice.viewport === "fit"}
            onClick={() => pick("fit")}
          />
        </ul>
        {GROUPS.map((group) => (
          <section key={group} aria-label={group}>
            <h3 className="px-4 pt-3 pb-1 text-[0.8125rem] text-muted-foreground">{group}</h3>
            <ul className="px-2">
              {VIEWPORTS.filter((item) => item.group === group).map((item) => (
                <Choice
                  key={item.id}
                  label={item.name}
                  detail={`${item.width} × ${item.height}`}
                  chosen={choice.viewport === item.id}
                  onClick={() => pick(item.id)}
                />
              ))}
            </ul>
          </section>
        ))}

        <section aria-label="Custom size" className="px-4 pt-3">
          <h3 className="pb-1.5 text-[0.8125rem] text-muted-foreground">Custom</h3>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const custom = {
                width: clampDimension(Number(width), choice.custom.width),
                height: clampDimension(Number(height), choice.custom.height),
              };
              setWidth(String(custom.width));
              setHeight(String(custom.height));
              onChoose({ ...choice, viewport: "custom", custom, rotated: false, zoom: null });
              onOpenChange(false);
            }}
          >
            <Dimension label="Width" value={width} onChange={setWidth} />
            <span aria-hidden="true" className="pb-2.5 text-faint">
              ×
            </span>
            <Dimension label="Height" value={height} onChange={setHeight} />
            <Button
              type="submit"
              variant={choice.viewport === "custom" ? "default" : "secondary"}
              className="h-10 px-4"
            >
              Use
            </Button>
          </form>
          <p className="pt-1.5 text-[0.75rem] text-faint">
            {CUSTOM_MIN} to {CUSTOM_MAX} CSS pixels each way.
          </p>
        </section>
      </SheetContent>
    </Sheet>
  );
}

function Choice({
  label,
  detail,
  chosen,
  onClick,
}: {
  label: string;
  detail: string;
  chosen: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={chosen}
        onClick={onClick}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
          chosen && "bg-secondary",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-[0.9375rem]">{label}</span>
        <span className="font-mono text-[0.75rem] text-muted-foreground tabular-nums">
          {detail}
        </span>
        <CheckIcon className={cn("size-4 shrink-0 text-lid", !chosen && "invisible")} />
      </button>
    </li>
  );
}

function Dimension({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-[0.75rem] text-muted-foreground">
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={CUSTOM_MIN}
        max={CUSTOM_MAX}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-lg border border-input bg-input/30 px-2.5 font-mono text-base text-foreground tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </label>
  );
}
