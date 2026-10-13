import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

type SectionHeaderProps = {
  open: boolean;
  onToggle: () => void;
  label: ReactNode;
  /** What sits at the far end of the line: a count, or a sign that the section is loading. */
  aside?: ReactNode;
};

/**
 * The line a section of a repository's screen folds by. It stays at the top of the screen while its
 * section scrolls under it.
 */
export function SectionHeader({ open, onToggle, label, aside }: SectionHeaderProps) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <h2 className="sticky top-0 z-10 bg-background">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-2 pt-1.5 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] text-left text-[0.8125rem] font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <Chevron aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {aside}
      </button>
    </h2>
  );
}
