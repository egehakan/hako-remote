import { useCallback, useEffect, useState } from "react";
import { BoxMark } from "@/components/box-mark";
import { api } from "@/lib/api";
import { relay } from "@/lib/connection";
import { clearFiles } from "@/lib/files/store";
import { clearGit } from "@/lib/git/store";
import { notifications } from "@/lib/notifications";
import { navigate, routes } from "@/lib/route";
import { workspaceStore } from "@/lib/workspace";
import { LoginScreen } from "@/screens/login";
import { Shell } from "@/screens/shell";

type Auth = { state: "checking" } | { state: "anonymous" } | { state: "signed-in"; email: string };

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: "checking" });

  const signedOut = useCallback(() => {
    relay.stop();
    workspaceStore.clear();
    clearFiles();
    clearGit();
    navigate(routes.workspace, { replace: true });
    setAuth({ state: "anonymous" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.me().then((result) => {
      if (cancelled) return;
      setAuth(
        result.ok ? { state: "signed-in", email: result.value.email } : { state: "anonymous" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signedIn = auth.state === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    relay.onUnauthorized = signedOut;
    relay.start();
    notifications.start();
    return () => {
      relay.stop();
      notifications.stop();
    };
  }, [signedIn, signedOut]);

  if (auth.state === "checking") {
    return (
      <div
        className="flex h-full items-center justify-center"
        aria-busy="true"
        aria-label="Loading…"
      >
        <BoxMark state="seeking" className="h-14" />
      </div>
    );
  }
  if (auth.state === "anonymous") {
    return <LoginScreen onLoggedIn={(email) => setAuth({ state: "signed-in", email })} />;
  }
  return <Shell email={auth.email} onLoggedOut={signedOut} />;
}
