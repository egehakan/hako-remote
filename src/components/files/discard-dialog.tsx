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

type DiscardDialogProps = {
  open: boolean;
  fileName: string;
  onStay: () => void;
  onDiscard: () => void;
};

/** Asks before unsaved text is thrown away. Stay holds the focus, so Return and Space keep it. */
export function DiscardDialog({ open, fileName, onStay, onDiscard }: DiscardDialogProps) {
  const stayRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onStay();
      }}
    >
      <AlertDialogContent initialFocus={stayRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            Your changes to {fileName} have not been saved to your Mac. Leaving discards them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={stayRef} size="touch">
            Stay
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" size="touch" onClick={onDiscard}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
