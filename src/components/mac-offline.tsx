import { BoxMark } from "@/components/box-mark";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** What a list shows in place of its contents while Hako on the Mac is not connected. */
export function MacOffline() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia>
          <BoxMark state="dark" className="h-16" />
        </EmptyMedia>
        <EmptyTitle>Hako isn’t connected</EmptyTitle>
        <EmptyDescription>
          Your Mac is asleep, off the network, or Hako is closed. Open Hako on the Mac and this page
          picks it up by itself.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
