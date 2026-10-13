import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/route";

/** The bar over a detail view. On a phone it carries the way back to the workspace. */
export function DetailHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-1 border-b bg-background/95 pt-safe pr-[max(1rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))] backdrop-blur wide:pl-5">
      <Button
        variant="ghost"
        size="icon-touch"
        className="wide:hidden"
        aria-label="Back to the workspace"
        nativeButton={false}
        render={<a href={routes.workspace} />}
      >
        <ChevronLeftIcon />
      </Button>
      <h1 className="min-w-0 flex-1 truncate py-4 text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
        {title}
      </h1>
      {children}
    </header>
  );
}
