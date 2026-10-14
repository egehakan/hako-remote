import { AppWindowIcon } from "lucide-react";
import { PreviewList } from "@/components/previews/preview-list";
import { MacViewer } from "@/components/previews/mac-viewer";
import { PreviewViewer } from "@/components/previews/preview-viewer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { Route } from "@/lib/route";
import { cn } from "@/lib/utils";

type PreviewsRoute = Extract<Route, { name: "previews" | "preview" | "browse" }>;

/**
 * Previews: the apps the Mac runs for the owner to try, and one of them in a frame beside the list
 * (over it, on a phone).
 */
export default function PreviewsArea({ route }: { route: PreviewsRoute }) {
  const id = route.name === "preview" ? route.id : null;
  const open = route.name !== "previews";
  return (
    <>
      <div className={cn("flex min-h-0 min-w-0 flex-col narrow:flex-1", open && "narrow:hidden")}>
        <PreviewList selected={id} />
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 wide:border-l",
          // On a phone an open viewer follows the visible part of the page, above the keyboard.
          open ? "visible-pane h-(--vv-height) overflow-hidden" : "narrow:hidden",
        )}
      >
        {route.name === "browse" ? (
          <MacViewer
            key={route.url}
            target={{ url: route.url }}
            name={route.url}
            choiceKey="@browser"
          />
        ) : id !== null ? (
          <PreviewViewer key={id} id={id} />
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AppWindowIcon />
              </EmptyMedia>
              <EmptyTitle>Pick a preview</EmptyTitle>
              <EmptyDescription>
                It opens here in this browser, as a phone, a tablet or a computer would show it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </>
  );
}
