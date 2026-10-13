import type { GitBranch, GitRepo } from "@shared/protocol";
import {
  CheckIcon,
  CloudIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  LockIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentType,
  type FormEvent,
  memo,
  type ReactNode,
  useDeferredValue,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { GitProblem } from "@/components/git/states";
import { MacOffline } from "@/components/mac-offline";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { baseName } from "@/lib/files/paths";
import { checkBranchName, filterBranches, localNameOf, timeAgo } from "@/lib/git/branches";
import { branchLabel } from "@/lib/git/repos";
import { type SwitchTarget, useActivity, useBranches, useRepo } from "@/lib/git/store";
import { useConnection, useWide } from "@/lib/hooks";
import { navigate, routes } from "@/lib/route";
import { useVisibleViewport } from "@/lib/terminal/viewport";
import { cn } from "@/lib/utils";

// A placeholder is drawn in the muted colour, which on a sheet is the colour of the sheet itself.
const SURFACE = "flex flex-col gap-0 overflow-hidden [--muted:var(--input)]";

type BranchPickerProps = {
  repoPath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the branch that was chosen, or the name of one to make. */
  onPick: (repo: GitRepo, target: SwitchTarget) => void;
};

/** Where a repository's branch is changed: a sheet on a phone, a dialog where there is room for one. */
export function BranchPicker({ repoPath, open, onOpenChange, onPick }: BranchPickerProps) {
  const wide = useWide();
  const repo = useRepo(repoPath);
  if (wide) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn(SURFACE, "h-[min(40rem,calc(100dvh-4rem))] p-0 sm:max-w-lg")}>
          {repo ? (
            <Picker
              key={repo.path}
              repo={repo}
              open={open}
              Title={DialogTitle}
              Description={DialogDescription}
              onPick={onPick}
              onClose={() => onOpenChange(false)}
            />
          ) : (
            <DialogTitle className="p-4">Switch branch</DialogTitle>
          )}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn(
          SURFACE,
          "mx-auto max-w-lg overscroll-contain rounded-t-2xl border-x outline-none data-[side=bottom]:h-[min(40rem,calc(var(--vv-height)-2.5rem))]",
          // The sheet hangs from the bottom of the visible part of the page, not of the page, so
          // that a name is typed and the list is filtered above the keyboard.
          "top-[calc(var(--vv-pinned-top)+var(--vv-height))] [transform:translateY(-100%)] data-[side=bottom]:bottom-auto",
        )}
      >
        {repo ? (
          <Picker
            key={repo.path}
            repo={repo}
            open={open}
            Title={SheetTitle}
            Description={SheetDescription}
            onPick={onPick}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <SheetTitle className="p-4">Switch branch</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  );
}

type PickerProps = {
  repo: GitRepo;
  open: boolean;
  Title: ComponentType<{ children: ReactNode; className?: string }>;
  Description: ComponentType<{ children: ReactNode; className?: string }>;
  onPick: (repo: GitRepo, target: SwitchTarget) => void;
  onClose: () => void;
};

function Picker({ repo, open, Title, Description, onPick, onClose }: PickerProps) {
  useVisibleViewport();
  const { link, agent } = useConnection();
  const offline = link === "open" && agent?.online === false;
  // Asked for while the picker is open, and again each time it opens.
  const { data, error, reload } = useBranches(open ? repo.path : null);
  const activity = useActivity(repo.path);
  const busy = activity?.state === "running";
  const [filter, setFilter] = useState("");
  const [naming, setNaming] = useState(false);
  const needle = useDeferredValue(filter);

  const branches = data?.branches ?? null;
  const groups = useMemo(() => filterBranches(branches ?? [], needle), [branches, needle]);
  const localNames = useMemo(
    () => (branches ?? []).filter((branch) => branch.kind === "local").map((branch) => branch.name),
    [branches],
  );
  const typed = filter.trim();
  const matching = groups.local.length + groups.remote.length;
  const exact = typed !== "" && (branches ?? []).some((branch) => branch.name === typed);
  const unsupported = error?.code === "not_supported";

  const pick = (target: SwitchTarget) => {
    onPick(repo, target);
    onClose();
  };

  return (
    <>
      <header className="flex shrink-0 flex-col gap-0.5 px-4 pt-4 pr-12 pb-3">
        <Title className="font-heading text-base font-medium text-foreground">Switch branch</Title>
        <Description className="truncate text-sm text-muted-foreground">
          {repo.name} is {repo.branch === null ? "" : "on "}
          <span className="font-mono text-[0.8125rem] text-foreground" translate="no">
            {branchLabel(repo)}
          </span>
        </Description>
      </header>

      {offline ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t">
          <MacOffline />
        </div>
      ) : branches !== null && !unsupported ? (
        <>
          {naming ? (
            <NewBranchForm
              repo={repo}
              initial={exact ? "" : typed}
              taken={localNames}
              busy={busy}
              onCancel={() => setNaming(false)}
              onCreate={(name) => pick({ branch: name, kind: "new" })}
            />
          ) : (
            <>
              <div className="relative shrink-0 px-4 pb-3">
                <SearchIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute top-3 left-7 size-4 text-faint"
                />
                <input
                  type="text"
                  inputMode="search"
                  enterKeyHint="search"
                  name="branch-filter"
                  aria-label="Filter branches"
                  placeholder="Filter branches…"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-input/30 pr-10 pl-9 font-mono text-base outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 wide:text-sm"
                />
                {filter !== "" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-1 right-5"
                    aria-label="Clear the filter"
                    onClick={() => setFilter("")}
                  >
                    <XIcon />
                  </Button>
                ) : null}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => setNaming(true)}
                className="flex min-h-12 w-full shrink-0 items-center gap-3 border-y px-4 text-left text-lid outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:opacity-50"
              >
                <span className="flex size-6 shrink-0 items-center justify-center">
                  <GitBranchPlusIcon aria-hidden="true" className="size-5" />
                </span>
                <span className="min-w-0 truncate text-[0.9375rem] font-medium">
                  {typed !== "" && !exact ? (
                    <>
                      New branch{" "}
                      <span className="font-mono text-[0.875rem]" translate="no">
                        {typed}
                      </span>
                    </>
                  ) : (
                    "New branch"
                  )}
                </span>
              </button>
            </>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {error ? (
              <p className="px-4 pt-3 text-[0.8125rem] leading-5 text-muted-foreground">
                Couldn’t refresh from your Mac. These are the branches as they were last read.
              </p>
            ) : null}
            {busy ? (
              <p className="px-4 pt-3 text-[0.8125rem] leading-5 text-muted-foreground">
                Git is busy in {repo.name}. Branches can be switched when it has finished.
              </p>
            ) : null}
            {data?.detached && data.head !== null ? (
              <p className="px-4 pt-3 text-[0.8125rem] leading-5 text-muted-foreground">
                HEAD is detached at{" "}
                <span className="font-mono text-xs text-foreground" translate="no">
                  {data.head.slice(0, 7)}
                </span>
                , on no branch. Switching to a branch leaves that commit where it is.
              </p>
            ) : null}
            {branches.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
                No branches yet: {repo.name} has no commit. The first commit makes{" "}
                <span className="font-mono text-[0.8125rem]" translate="no">
                  {data?.current ?? "the first one"}
                </span>
                .
              </p>
            ) : matching === 0 ? (
              <p className="px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
                No branch matches “{typed}”.
              </p>
            ) : (
              <>
                <BranchGroup title="On your Mac" branches={groups.local}>
                  {(branch) => (
                    <BranchRow
                      key={branch.name}
                      branch={branch}
                      current={branch.name === data?.current}
                      disabled={busy}
                      onPick={pick}
                      onClose={onClose}
                    />
                  )}
                </BranchGroup>
                <BranchGroup title="Only on the remote" branches={groups.remote}>
                  {(branch) => (
                    <BranchRow
                      key={branch.name}
                      branch={branch}
                      current={false}
                      disabled={busy}
                      onPick={pick}
                      onClose={onClose}
                    />
                  )}
                </BranchGroup>
                {data?.truncated ? (
                  <p className="px-4 py-3 text-[0.75rem] leading-5 text-faint">
                    Only the 500 branches with the newest commits are listed.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </>
      ) : error ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t">
          <GitProblem error={error} what="branches">
            {unsupported ? null : (
              <Button variant="secondary" size="touch" onClick={reload}>
                Try again
              </Button>
            )}
          </GitProblem>
        </div>
      ) : (
        <BranchSkeleton />
      )}
    </>
  );
}

type BranchGroupProps = {
  title: string;
  branches: readonly GitBranch[];
  children: (branch: GitBranch) => ReactNode;
};

function BranchGroup({ title, branches, children }: BranchGroupProps) {
  if (branches.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="sticky top-0 z-10 bg-popover px-4 pt-3.5 pb-1.5 text-[0.8125rem] font-normal text-muted-foreground">
        {title}
      </h3>
      <ul className="divide-y border-y">{branches.map(children)}</ul>
    </section>
  );
}

type BranchRowProps = {
  branch: GitBranch;
  current: boolean;
  disabled: boolean;
  onPick: (target: SwitchTarget) => void;
  onClose: () => void;
};

const BranchRow = memo(function BranchRow({
  branch,
  current,
  disabled,
  onPick,
  onClose,
}: BranchRowProps) {
  const held = branch.worktree !== null;
  const remote = branch.kind === "remote";
  const Icon = current ? CheckIcon : held ? LockIcon : remote ? CloudIcon : GitBranchIcon;
  const layout = "flex min-h-[3.75rem] w-full scroll-mt-10 items-center gap-3 px-4 py-2 text-left";
  // A repository can have hundreds of branches; the ones off screen are not laid out.
  const lazy = "[contain-intrinsic-size:auto_3.75rem] [content-visibility:auto]";
  const contents = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <Icon
          aria-hidden="true"
          className={cn(
            "size-[1.125rem]",
            current ? "text-amber" : remote ? "text-remote" : "text-muted-foreground",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate font-mono text-sm leading-5",
              current && "font-bold text-lid",
              held && "text-muted-foreground",
            )}
            translate="no"
          >
            {branch.name}
          </span>
          {current ? (
            <span className="shrink-0 text-[0.6875rem] leading-5 text-faint">current</span>
          ) : null}
          <span className="min-w-0 flex-1" />
          <time
            dateTime={new Date(branch.time).toISOString()}
            className="shrink-0 text-[0.6875rem] leading-5 text-faint"
          >
            {timeAgo(branch.time)}
          </time>
        </span>
        {held ? (
          <span className="text-[0.75rem] leading-4 text-muted-foreground">
            Checked out in the worktree{" "}
            <span className="font-mono text-[0.6875rem]" translate="no">
              {baseName(branch.worktree ?? "")}
            </span>
            , so it can’t be checked out here too.
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2 text-[0.75rem] leading-4 text-muted-foreground">
            {branch.ahead !== null && branch.ahead > 0 ? (
              <span className="shrink-0 font-mono text-[0.6875rem] text-foreground">
                <span aria-hidden="true">↑{branch.ahead}</span>
                <span className="sr-only">{branch.ahead} to push</span>
              </span>
            ) : null}
            {branch.behind !== null && branch.behind > 0 ? (
              <span className="shrink-0 font-mono text-[0.6875rem] text-foreground">
                <span aria-hidden="true">↓{branch.behind}</span>
                <span className="sr-only">{branch.behind} to pull</span>
              </span>
            ) : null}
            <span className="min-w-0 truncate">
              {remote ? `Makes ${localNameOf(branch.name)} here, following it` : branch.subject}
            </span>
          </span>
        )}
      </span>
    </>
  );

  if (held) {
    return (
      <li className={cn("flex items-center", lazy)}>
        <div className={cn(layout, "min-w-0 flex-1")} aria-disabled="true">
          {contents}
        </div>
        <Button
          variant="ghost"
          size="lg"
          className="mr-2 shrink-0 text-foreground"
          onClick={() => {
            onClose();
            navigate(routes.repo(branch.worktree ?? ""));
          }}
        >
          Open worktree
        </Button>
      </li>
    );
  }
  if (current) {
    return (
      <li className={cn(layout, lazy)} aria-current="true">
        {contents}
      </li>
    );
  }
  return (
    <li className={lazy}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick({ branch: branch.name, kind: branch.kind })}
        className={cn(
          layout,
          "outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset disabled:opacity-50",
        )}
      >
        {contents}
      </button>
    </li>
  );
});

type NewBranchFormProps = {
  repo: GitRepo;
  initial: string;
  taken: readonly string[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (name: string) => void;
};

function NewBranchForm({ repo, initial, taken, busy, onCancel, onCreate }: NewBranchFormProps) {
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const noteId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const check = checkBranchName(name, taken);
    if (!check.ok) {
      setProblem(check.reason);
      field.current?.focus();
      return;
    }
    onCreate(check.name);
  };

  return (
    <form onSubmit={submit} className="flex shrink-0 flex-col gap-3 border-y px-4 py-3">
      <FieldGroup>
        <Field data-invalid={problem !== null || undefined}>
          <FieldLabel htmlFor={fieldId}>Name of the new branch</FieldLabel>
          <Input
            ref={field}
            id={fieldId}
            name="branch-name"
            value={name}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            placeholder="feature/…"
            aria-invalid={problem !== null || undefined}
            aria-describedby={noteId}
            className="font-mono text-foreground"
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape leaves the name, not the whole picker.
              event.stopPropagation();
              onCancel();
            }}
          />
          {problem !== null ? (
            <FieldError id={noteId}>{problem}</FieldError>
          ) : (
            <FieldDescription id={noteId}>
              {repo.head === null ? (
                "It starts where this repository does: there is no commit yet."
              ) : (
                <>
                  It starts at the commit you are on,{" "}
                  <span className="font-mono text-xs" translate="no">
                    {repo.head.slice(0, 7)}
                  </span>
                  , and your changes come along.
                </>
              )}
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" size="touch" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="touch" className="min-w-0 flex-1" disabled={busy}>
          <GitBranchPlusIcon data-icon="inline-start" />
          <span className="truncate">Create and switch</span>
        </Button>
      </div>
    </form>
  );
}

const WIDTHS = ["w-24", "w-40", "w-32", "w-44", "w-28"];

function BranchSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-t"
      aria-busy="true"
      aria-label="Loading the branches"
    >
      {WIDTHS.map((width) => (
        <div key={width} className="flex h-[3.75rem] items-center gap-3 px-4">
          <Skeleton className="size-5 rounded" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={`h-3.5 ${width}`} />
            <Skeleton className="h-2.5 w-36" />
          </div>
        </div>
      ))}
    </div>
  );
}
