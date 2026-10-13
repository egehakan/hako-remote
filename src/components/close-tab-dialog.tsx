import type { Tab } from "@shared/protocol";
import { useRef } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type CloseTabDialogProps = {
  /** The tab in question. It stays set while the dialog animates out. */
  tab: Tab | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (tab: Tab) => void;
};

function consequence(tab: Tab): string {
  const terminals = tab.panes.filter((pane) => pane.kind === "terminal").length;
  const agents = tab.panes.filter((pane) => pane.agent?.status === "working").length;
  if (agents > 0) return "An agent is still working in it. Closing the tab stops it.";
  if (terminals > 1) return `Its ${terminals} terminals end, along with anything running in them.`;
  return "Its terminal ends, along with anything running in it.";
}

/** Asks before closing a tab on the Mac. Cancel holds the focus, so Return and Space keep the tab. */
export function CloseTabDialog({ tab, open, onCancel, onConfirm }: CloseTabDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog
      open={open && tab !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>Close “{tab?.title}” on your Mac?</AlertDialogTitle>
          <AlertDialogDescription>{tab ? consequence(tab) : null}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} size="touch">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="touch"
            onClick={() => {
              if (tab) onConfirm(tab);
            }}
          >
            Close tab
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
