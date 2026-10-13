import type { GitFile, GitRepo } from "@shared/protocol";
import { createContext, type ReactNode, use, useCallback, useMemo, useState } from "react";
import { CommitSheet } from "@/components/git/commit-sheet";
import { DiscardDialog } from "@/components/git/discard-dialog";
import { MoreSheet } from "@/components/git/more-sheet";
import { OutputSheet } from "@/components/git/output-sheet";
import { discard, pull, push } from "@/lib/git/store";
import { useConnection } from "@/lib/hooks";
import { navigate, routes } from "@/lib/route";

export type GitUi = {
  /** False while there is nobody to send a command to. */
  canAct: boolean;
  askCommit: (repo: GitRepo) => void;
  /** Asks before throwing away one file's changes, or with `null` every change in the repository. */
  askDiscard: (repo: GitRepo, file: GitFile | null) => void;
  showMore: (repo: GitRepo) => void;
  showOutput: (repo: GitRepo) => void;
  push: (repo: GitRepo) => void;
  pull: (repo: GitRepo) => void;
};

const GitUiContext = createContext<GitUi | null>(null);

export function useGitUi(): GitUi {
  const ui = use(GitUiContext);
  if (ui === null) throw new Error("useGitUi needs a GitUiProvider above it");
  return ui;
}

type Discarding = { repo: GitRepo; file: GitFile | null };

/**
 * Owns the sheets and the dialog of source control, so that every row and every screen opens the
 * same ones. Each keeps what it was opened for while it slides away.
 */
export function GitUiProvider({ children }: { children: ReactNode }) {
  const { link, agent } = useConnection();
  const canAct = link === "open" && agent?.online === true;
  const [committing, setCommitting] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [discarding, setDiscarding] = useState<Discarding | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  const showOutput = useCallback((repo: GitRepo) => {
    setOutput(repo.path);
    setOutputOpen(true);
  }, []);

  // A command that failed says why at once; nothing is tried a second time by itself.
  const runPush = useCallback(
    (repo: GitRepo) => {
      void push(repo).then((outcome) => {
        if (!outcome.ok) showOutput(repo);
      });
    },
    [showOutput],
  );
  const runPull = useCallback(
    (repo: GitRepo) => {
      void pull(repo).then((outcome) => {
        if (!outcome.ok) showOutput(repo);
      });
    },
    [showOutput],
  );

  const confirmDiscard = useCallback(
    ({ repo, file }: Discarding) => {
      setDiscardOpen(false);
      void discard(repo.path, file).then((outcome) => {
        if (!outcome.ok) {
          showOutput(repo);
          return;
        }
        // The diff that was open is of a file that has nothing left to show.
        const open = file === null ? null : routes.diff(repo.path, file.path);
        if (open !== null && window.location.hash === open) {
          navigate(routes.repo(repo.path), { replace: true });
        }
      });
    },
    [showOutput],
  );

  const ui = useMemo<GitUi>(
    () => ({
      canAct,
      askCommit: (repo) => {
        setCommitting(repo.path);
        setCommitOpen(true);
      },
      askDiscard: (repo, file) => {
        setDiscarding({ repo, file });
        setDiscardOpen(true);
      },
      showMore: (repo) => {
        setMore(repo.path);
        setMoreOpen(true);
      },
      showOutput,
      push: runPush,
      pull: runPull,
    }),
    [canAct, showOutput, runPush, runPull],
  );

  return (
    <GitUiContext value={ui}>
      {children}
      <CommitSheet
        repoPath={committing}
        open={commitOpen}
        onOpenChange={setCommitOpen}
        onCommitted={(repo, thenPush) => {
          setCommitOpen(false);
          if (thenPush) runPush(repo);
        }}
      />
      <MoreSheet repoPath={more} open={moreOpen} onOpenChange={setMoreOpen} />
      <OutputSheet repoPath={output} open={outputOpen} onOpenChange={setOutputOpen} />
      <DiscardDialog
        target={discarding}
        open={discardOpen}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={confirmDiscard}
      />
    </GitUiContext>
  );
}
