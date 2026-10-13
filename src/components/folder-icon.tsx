import type { Folder } from "@shared/protocol";
import { FolderIcon as DefaultFolderIcon } from "lucide-react";

// The keys the desktop app can send as `material:<key>`; each has a file in /folder-icons.
const MATERIAL_KEYS = new Set([
  "folder-project", "folder-src", "folder-app", "folder-api", "folder-server", "folder-client",
  "folder-core", "folder-lib", "folder-packages", "folder-components", "folder-ui", "folder-views",
  "folder-layout", "folder-config", "folder-environment", "folder-scripts", "folder-tools",
  "folder-utils", "folder-docs", "folder-test", "folder-benchmark", "folder-debug", "folder-log",
  "folder-database", "folder-migrations", "folder-docker", "folder-kubernetes", "folder-terraform",
  "folder-ci", "folder-git", "folder-github", "folder-gitlab", "folder-cloudflare", "folder-vercel",
  "folder-supabase", "vercel",
]);

/** A folder's own icon, or a plain folder in the folder's colour when it has none we can draw. */
export function FolderIcon({ folder }: { folder: Pick<Folder, "icon" | "color"> }) {
  const icon = folder.icon ?? "";
  if (icon.startsWith("text:") && icon.length > 5) {
    return (
      <span aria-hidden="true" className="flex size-6 items-center justify-center text-lg leading-none">
        {icon.slice(5)}
      </span>
    );
  }
  if (icon.startsWith("material:") && MATERIAL_KEYS.has(icon.slice(9))) {
    return (
      <img
        src={`/folder-icons/${icon.slice(9)}.svg`}
        alt=""
        width={24}
        height={24}
        className="size-6"
      />
    );
  }
  return (
    <DefaultFolderIcon
      aria-hidden="true"
      className="size-6 text-muted-foreground"
      style={folder.color ? { color: folder.color } : undefined}
    />
  );
}
