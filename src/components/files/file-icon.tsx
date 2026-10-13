import { isDirectory } from "@shared/files";
import type { FsEntry } from "@shared/protocol";
import {
  FileBracesIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSymlinkIcon,
  FileTextIcon,
  FileXIcon,
  FolderIcon,
  FolderSymlinkIcon,
} from "lucide-react";
import { imageMime } from "@shared/files";
import { languageOf } from "@/lib/files/language";
import { cn } from "@/lib/utils";

type Kind = Pick<FsEntry, "name" | "kind" | "target">;

/** One of a handful of shapes: enough to tell a folder, code, prose, data and a picture apart. */
export function FileKindIcon({ entry, className }: { entry: Kind; className?: string }) {
  const classes = cn("size-5 shrink-0", className);
  if (isDirectory(entry)) {
    const Icon = entry.kind === "symlink" ? FolderSymlinkIcon : FolderIcon;
    return <Icon aria-hidden="true" className={cn(classes, "text-amber")} />;
  }
  if (entry.kind === "other" || (entry.kind === "symlink" && entry.target !== "file")) {
    return <FileXIcon aria-hidden="true" className={cn(classes, "text-faint")} />;
  }
  if (entry.kind === "symlink") {
    return <FileSymlinkIcon aria-hidden="true" className={cn(classes, "text-muted-foreground")} />;
  }
  if (imageMime(entry.name) !== null) {
    return <FileImageIcon aria-hidden="true" className={cn(classes, "text-muted-foreground")} />;
  }
  const language = languageOf(entry.name);
  const Icon =
    language === "text"
      ? FileIcon
      : language === "markdown"
        ? FileTextIcon
        : language === "json" || language === "yaml" || language === "toml"
          ? FileBracesIcon
          : FileCodeIcon;
  return <Icon aria-hidden="true" className={cn(classes, "text-muted-foreground")} />;
}
