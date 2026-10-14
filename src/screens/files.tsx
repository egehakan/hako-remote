import { FileTextIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { FilesBrowser } from "@/components/files/browser";
import { LoadBoundary } from "@/components/load-boundary";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { parentOf } from "@/lib/files/paths";
import { useWide } from "@/lib/hooks";
import type { Route } from "@/lib/route";
import { cn } from "@/lib/utils";

// The file view brings the editor with it, which browsing folders does not need.
const FileView = lazy(() => import("@/screens/file-view"));

type FilesRoute = Extract<Route, { name: "files" | "dir" | "file" }>;

/** Files: the folders of the Mac on one side, and the file that was opened on the other. */
export function FilesArea({ route }: { route: FilesRoute }) {
  const wide = useWide();
  const routeFile = route.name === "file" ? route.path : null;
  // Beside the list, a file stays open while the folders around it are browsed.
  const [kept, setKept] = useState(routeFile);
  if (routeFile !== null && routeFile !== kept) setKept(routeFile);
  const shown = routeFile ?? (wide ? kept : null);
  const browsing =
    route.name === "dir" ? route.path : route.name === "file" ? parentOf(route.path) : null;

  return (
    <>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col narrow:flex-1",
          routeFile !== null && "narrow:hidden",
        )}
      >
        <FilesBrowser path={browsing} selectedFile={shown} />
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 wide:border-l",
          // On a phone an open file follows the visible part of the page, above the keyboard.
          shown !== null ? "visible-pane h-(--vv-height) overflow-hidden" : "min-h-0 narrow:hidden",
        )}
      >
        {shown !== null ? (
          <LoadBoundary>
            <Suspense fallback={<FileLoading />}>
              <FileView
                key={shown}
                path={shown}
                line={route.name === "file" && route.path === shown ? route.line : null}
              />
            </Suspense>
          </LoadBoundary>
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileTextIcon />
              </EmptyMedia>
              <EmptyTitle>Pick a file</EmptyTitle>
              <EmptyDescription>
                Text opens with syntax colours and can be edited and saved back to your Mac.
                Pictures open as pictures.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </>
  );
}

function FileLoading() {
  return (
    <div className="flex flex-col gap-2.5 px-safe py-6" aria-busy="true" aria-label="Loading…">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-3.5 w-3/5" />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3.5 w-2/5" />
    </div>
  );
}
