import type { GitRepo } from "@shared/protocol";
import { GitCommitHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  branchLabel,
  explainFailure,
  isUnpublished,
  plural,
  summarizeFiles,
} from "@/lib/git/repos";
import {
  commit,
  commitDrafts,
  type GitError,
  gitPrefs,
  useGitPrefs,
  useRepo,
  useRepoStatus,
} from "@/lib/git/store";
import { useVisibleViewport } from "@/lib/terminal/viewport";
import { joinPath } from "@/lib/files/paths";
import { routes } from "@/lib/route";
import { parseConflictMarkerMessage } from "@shared/git";
import { cn } from "@/lib/utils";

type CommitSheetProps = {
  repoPath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the commit exists, with whether it should be pushed now. */
  onCommitted: (repo: GitRepo, thenPush: boolean) => void;
};

/** Where a commit message is written. It stays above the keyboard, and keeps the text if it fails. */
export function CommitSheet({ repoPath, open, onOpenChange, onCommitted }: CommitSheetProps) {
  const repo = useRepo(repoPath);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn(
          "mx-auto max-h-[calc(var(--vv-height)-0.75rem)] max-w-lg gap-0 overflow-y-auto overscroll-contain rounded-t-2xl border-x",
          // The sheet hangs from the bottom of the visible part of the page, not of the page.
          "top-[calc(var(--vv-pinned-top)+var(--vv-height))] [transform:translateY(-100%)] data-[side=bottom]:bottom-auto",
        )}
      >
        {repo !== null ? (
          <CommitForm
            // A different repository is a different message.
            key={repo.path}
            repo={repo}
            onCancel={() => onOpenChange(false)}
            onCommitted={onCommitted}
          />
        ) : (
          <SheetHeader className="pr-12">
            <SheetTitle>Commit</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

type CommitFormProps = {
  repo: GitRepo;
  onCancel: () => void;
  onCommitted: (repo: GitRepo, thenPush: boolean) => void;
};

function CommitForm({ repo, onCancel, onCommitted }: CommitFormProps) {
  const keyboardOpen = useVisibleViewport();
  const status = useRepoStatus(repo.path);
  const { pushAfterCommit } = useGitPrefs();
  const [message, setMessage] = useState(() => commitDrafts.get(repo.path));
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<GitError | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const messageId = useId();
  const errorId = useId();
  const pushId = useId();

  const merge = status.data?.merge;
  const merging = repo.operation === "merge";
  // The message git prepared for the merge goes in once, unless something was written already.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !merge?.message) return;
    prefilled.current = true;
    setMessage((written) => (written.trim() === "" ? merge.message : written));
  }, [merge]);

  const files = status.data?.files ?? null;
  const count = files?.length ?? repo.changed;
  const conflicts = files?.filter((file) => file.status === "conflicted").length ?? 0;
  const unpublished = isUnpublished(repo);
  const canPush = repo.branch !== null;
  const thenPush = canPush && pushAfterCommit;
  const explained = failure ? explainFailure("commit", failure.code, failure.message) : null;
  const marked = failure?.code === "conflict" ? parseConflictMarkerMessage(failure.message) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (message.trim() === "") {
      setEmpty(true);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    const outcome = await commit(repo.path, message);
    setBusy(false);
    if (!outcome.ok) {
      setFailure(outcome.error);
      return;
    }
    commitDrafts.set(repo.path, "");
    onCommitted(outcome.result.repo, thenPush);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col">
      <SheetHeader className="pr-12">
        <SheetTitle>
          {merging ? "Commit merge into" : "Commit to"}{" "}
          <span className="font-mono text-[0.9375rem]" translate="no">
            {branchLabel(repo)}
          </span>
        </SheetTitle>
        <SheetDescription>
          {count === 0 ? (
            <>
              This concludes the {repo.operation ?? "merge"} in {repo.name}.
            </>
          ) : (
            <>
              All {plural(count, "changed file")} in {repo.name}
              {files && files.length > 0 ? ` (${summarizeFiles(files)})` : ""}. There is no choosing
              among them here.
            </>
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-3 px-4 pb-4">
        {conflicts > 0 ? (
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>{plural(conflicts, "file")} still in conflict</AlertTitle>
            <AlertDescription>
              {merge !== undefined
                ? `Your Mac won’t commit while ${conflicts === 1 ? "it still holds" : "they still hold"} conflict markers. Resolve ${conflicts === 1 ? "it" : "them"} in Files first.`
                : `Committing records ${conflicts === 1 ? "it as it is" : "them as they are"}, conflict markers and all.`}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={messageId} className="text-[0.8125rem] font-medium">
            Message
          </label>
          <Textarea
            ref={field}
            id={messageId}
            name="message"
            rows={4}
            value={message}
            placeholder="What changed, and why…"
            autoComplete="off"
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            enterKeyHint="enter"
            disabled={busy}
            aria-invalid={empty || undefined}
            aria-describedby={empty ? errorId : undefined}
            className="max-h-[11.5rem] min-h-[6.5rem] rounded-xl px-3.5 py-3 text-base leading-6 md:text-base"
            onChange={(event) => {
              setMessage(event.target.value);
              commitDrafts.set(repo.path, event.target.value);
              if (event.target.value.trim() !== "") setEmpty(false);
            }}
          />
          {empty ? (
            <p id={errorId} role="alert" className="text-[0.8125rem] text-destructive">
              A commit needs a message. Say what changed.
            </p>
          ) : null}
        </div>

        <label
          htmlFor={pushId}
          className={cn("flex min-h-11 items-center gap-3", !canPush && "opacity-60")}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[0.9375rem] font-medium">
              {unpublished ? "Publish the branch after committing" : "Push after committing"}
            </span>
            {canPush ? null : (
              <span className="text-[0.8125rem] text-muted-foreground">
                HEAD is detached, so there is no branch to push.
              </span>
            )}
          </span>
          <Switch
            id={pushId}
            checked={thenPush}
            disabled={!canPush || busy}
            onCheckedChange={(checked) => gitPrefs.set({ pushAfterCommit: checked })}
          />
        </label>

        {failure && explained ? (
          <Alert variant="destructive">
            <AlertTitle>{explained.title}</AlertTitle>
            <AlertDescription>
              {explained.hint ? <p>{explained.hint}</p> : null}
              {marked ? (
                <ul className="mt-1 flex flex-col text-foreground" aria-label="Files with markers">
                  {marked.paths.map((path) => (
                    <li key={path}>
                      <a
                        href={routes.file(joinPath(repo.path, path))}
                        className="flex min-h-10 items-center gap-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] underline-offset-4 hover:underline"
                        translate="no"
                        onClick={onCancel}
                      >
                        {path}
                      </a>
                    </li>
                  ))}
                  {marked.more > 0 ? (
                    <li className="text-xs leading-5 text-muted-foreground">
                      and {marked.more} more
                    </li>
                  ) : null}
                </ul>
              ) : failure.message ? (
                <pre className="mt-1 max-h-40 overflow-y-auto font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
                  {failure.message}
                </pre>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div
          className={cn(
            "flex gap-2 pt-1",
            // The keyboard covers the home indicator, so its inset is only needed without one.
            keyboardOpen ? "" : "pb-[max(0rem,calc(env(safe-area-inset-bottom)-0.5rem))]",
          )}
        >
          <Button type="button" variant="secondary" size="touch" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="touch" className="min-w-0 flex-1" disabled={busy}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <GitCommitHorizontalIcon data-icon="inline-start" />
            )}
            <span className="truncate">
              {busy
                ? "Committing…"
                : merging
                  ? `Commit merge${thenPush ? (unpublished ? " and publish" : " and push") : ""}`
                  : count === 0
                    ? "Commit"
                    : `Commit ${plural(count, "file")}${thenPush ? (unpublished ? " and publish" : " and push") : ""}`}
            </span>
          </Button>
        </div>
      </div>
    </form>
  );
}
