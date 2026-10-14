import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

export function Working({ label }: { label: string }) {
  return (
    <div
      className="flex flex-1 items-center justify-center gap-2 py-14 text-sm text-muted-foreground"
      role="status"
    >
      <Spinner />
      {label}
    </div>
  );
}

/** Says a preview could not be drawn, and offers what else there is. */
export function PreviewFailed({ reason, fallback }: { reason: string; fallback: ReactNode }) {
  return (
    <Empty className="min-h-0 py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CircleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>Couldn’t show a preview</EmptyTitle>
        <EmptyDescription>{reason}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{fallback}</EmptyContent>
    </Empty>
  );
}
