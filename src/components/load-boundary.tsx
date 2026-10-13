import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Catches a screen whose code could not be fetched, which is what happens to a page left open
 * across an update of the app: the files it would ask for are no longer on the server.
 */
export class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>This screen couldn’t load</EmptyTitle>
          <EmptyDescription>
            Hako Remote was probably updated while this page was open. Reloading fetches the new
            version.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="touch" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
}
