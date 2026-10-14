import {
  AppWindowIcon,
  FolderIcon,
  GitBranchIcon,
  SquareTerminalIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { BoxMark } from "@/components/box-mark";
import { useConnection } from "@/lib/hooks";
import { usePreviews } from "@/lib/previews/store";
import { type Area, routes } from "@/lib/route";
import { cn } from "@/lib/utils";

type Item = {
  area: Area;
  label: string;
  short: string;
  icon: ComponentType<{ className?: string }>;
};

const ITEMS: Item[] = [
  { area: "terminals", label: "Terminals", short: "Terminals", icon: SquareTerminalIcon },
  { area: "files", label: "Files", short: "Files", icon: FolderIcon },
  { area: "git", label: "Source control", short: "Source", icon: GitBranchIcon },
  { area: "previews", label: "Previews", short: "Previews", icon: AppWindowIcon },
  { area: "account", label: "Account", short: "Account", icon: UserRoundIcon },
];

type PrimaryNavProps = {
  area: Area;
  /** Where each area was last left, so coming back to one returns there. */
  resume: Partial<Record<Area, string>>;
  /** A terminal or an open file takes the whole screen of a phone, the bar included. */
  hiddenOnPhone: boolean;
};

const HOME: Record<Area, string> = {
  previews: routes.previews,
  terminals: routes.workspace,
  files: routes.files,
  git: routes.git,
  account: routes.account,
};

/** The app's areas: a bar under the thumb on a phone, a rail down the left side on a wide screen. */
export function PrimaryNav({ area, resume, hiddenOnPhone }: PrimaryNavProps) {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const { previews } = usePreviews();
  const running = online
    ? (previews ?? []).filter((preview) => preview.status === "running").length
    : 0;
  return (
    <nav
      aria-label="Areas"
      className={cn(
        "shrink-0 bg-background narrow:order-last narrow:grid narrow:grid-cols-5 narrow:border-t narrow:pr-[env(safe-area-inset-right)] narrow:pb-[env(safe-area-inset-bottom)] narrow:pl-[env(safe-area-inset-left)]",
        "wide:flex wide:min-h-0 wide:w-[4.75rem] wide:flex-col wide:items-stretch wide:gap-1 wide:border-r wide:px-1.5 wide:pt-[max(0.75rem,env(safe-area-inset-top))] wide:pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        hiddenOnPhone && "narrow:hidden",
      )}
    >
      <span
        className="mb-3 flex justify-center narrow:hidden"
        title={online ? "Hako is connected" : "Hako is not connected"}
      >
        <BoxMark state={online ? "lit" : "dark"} className="h-8" />
      </span>
      {ITEMS.map((item) => {
        const active = item.area === area;
        const Icon = item.icon;
        return (
          <a
            key={item.area}
            // A second tap on the area you are in goes to its start, as a tab bar does.
            href={active ? HOME[item.area] : (resume[item.area] ?? HOME[item.area])}
            aria-current={active ? "page" : undefined}
            aria-label={
              item.area === "previews" && running > 0
                ? `${item.label}, ${running} running`
                : item.label
            }
            className={cn(
              "relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg text-[0.6875rem] leading-none font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset wide:min-h-[3.75rem]",
              active ? "text-lid" : "text-muted-foreground hover:text-foreground",
              active && "wide:bg-secondary",
              item.area === "account" && "wide:mt-auto",
            )}
          >
            {active ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-amber wide:hidden"
              />
            ) : null}
            <span className="relative">
              <Icon className="size-[1.375rem]" />
              {item.area === "previews" && running > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-settled px-1 text-center font-mono text-[0.625rem] leading-4 font-bold text-background tabular-nums"
                >
                  {running}
                </span>
              ) : null}
            </span>
            <span aria-hidden="true" className="wide:hidden">
              {item.label}
            </span>
            <span aria-hidden="true" className="narrow:hidden">
              {item.short}
            </span>
          </a>
        );
      })}
    </nav>
  );
}
