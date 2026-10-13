import { UserRoundIcon } from "lucide-react";
import { BoxMark } from "@/components/box-mark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnection } from "@/lib/hooks";
import { routes } from "@/lib/route";

/** Who is on the other end: the Mac's name when Hako is connected, or why there is nothing to show. */
export function MacHeader() {
  const { link, agent } = useConnection();
  const reconnecting = link === "retrying";
  const pending = !reconnecting && (link !== "open" || agent === null);
  const online = link === "open" && agent?.online === true;

  let title = "Mac offline";
  let detail = "Waiting for Hako on your Mac";
  if (reconnecting) {
    title = "Reconnecting…";
    detail = "Lost the connection to the relay";
  } else if (online) {
    title = agent.name ?? agent.hostname ?? "Your Mac";
    detail = [agent.version ? `Hako ${agent.version}` : "Hako", agent.name ? agent.hostname : null]
      .filter(Boolean)
      .join(" on ");
  }

  return (
    <header className="flex shrink-0 items-center gap-3 border-b px-safe pt-safe">
      <div className="flex min-w-0 flex-1 items-center gap-3 py-3">
        <BoxMark
          state={online ? "lit" : reconnecting || pending ? "seeking" : "dark"}
          className="h-10"
        />
        {pending ? (
          <div className="flex flex-col gap-1.5" aria-busy="true" aria-label="Connecting">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        ) : (
          <div className="min-w-0" role="status" aria-live="polite">
            <h1 className="truncate text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">
              {title}
            </h1>
            <p className="truncate text-[0.8125rem] leading-5 text-muted-foreground">{detail}</p>
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-touch"
        aria-label="Account"
        nativeButton={false}
        render={<a href={routes.account} />}
      >
        <UserRoundIcon />
      </Button>
    </header>
  );
}
