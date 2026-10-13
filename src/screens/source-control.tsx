import { GitBranchIcon } from "lucide-react";
import { DetailHeader } from "@/components/detail-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** Holds the place of source control until it is built. */
export function SourceControlScreen() {
  return (
    <>
      <DetailHeader title="Source control" back={false} />
      <Empty className="py-20">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle>Coming next</EmptyTitle>
          <EmptyDescription>
            The repositories in your folders will be listed here, with what changed in each, the
            diffs, and commit, push and pull.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  );
}
