import { useSyncExternalStore } from "react";

export type Route =
  | { name: "workspace" }
  | { name: "tab"; tabId: string }
  /** One live terminal, by session id, so a link or a notification can open it directly. */
  | { name: "terminal"; sessionId: string }
  | { name: "account" };

function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "account") return { name: "account" };
  if (path.startsWith("tab/")) return { name: "tab", tabId: decodeURIComponent(path.slice(4)) };
  if (path.startsWith("t/") && path.length > 2) {
    return { name: "terminal", sessionId: decodeURIComponent(path.slice(2)) };
  }
  return { name: "workspace" };
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

const getHash = () => window.location.hash;

export function useRoute(): Route {
  return parse(useSyncExternalStore(subscribe, getHash));
}

export const routes = {
  workspace: "#/",
  account: "#/account",
  tab: (tabId: string) => `#/tab/${encodeURIComponent(tabId)}`,
  terminal: (sessionId: string) => `#/t/${encodeURIComponent(sessionId)}`,
};

export function navigate(hash: string, options: { replace?: boolean } = {}): void {
  if (window.location.hash === hash) return;
  if (options.replace) {
    window.location.replace(hash);
  } else {
    window.location.hash = hash;
  }
}
