// The relay's HTTP API (docs/protocol.md, "HTTP API").

export type ApiError =
  | { kind: "invalid_credentials"; remaining: number | null }
  | { kind: "locked"; retryAfterSeconds: number }
  | { kind: "weak_password"; message: string }
  | { kind: "unauthorized" }
  | { kind: "network" }
  | { kind: "server"; status: number };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

async function call<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const data = await response.json().catch(() => null);
  if (response.ok) return { ok: true, value: data as T };

  const code = typeof data?.error === "string" ? data.error : "";
  if (code === "invalid_credentials") {
    const remaining = typeof data.remaining === "number" ? data.remaining : null;
    return { ok: false, error: { kind: "invalid_credentials", remaining } };
  }
  if (code === "locked") {
    const retryAfterSeconds = typeof data.retry_after === "number" ? data.retry_after : 15 * 60;
    return { ok: false, error: { kind: "locked", retryAfterSeconds } };
  }
  if (code === "weak_password") {
    return { ok: false, error: { kind: "weak_password", message: String(data.message ?? "") } };
  }
  if (response.status === 401) return { ok: false, error: { kind: "unauthorized" } };
  return { ok: false, error: { kind: "server", status: response.status } };
}

export const api = {
  me: () => call<{ email: string }>("/api/me"),
  login: (email: string, password: string) =>
    call<{ email: string }>("/api/login", { email, password }),
  logout: () => call<{ ok: true }>("/api/logout", {}),
  changePassword: (current: string, next: string) =>
    call<{ ok: true }>("/api/password", { current, next }),
};

/** "in 14 minutes", "in 1 minute", "in 40 seconds". */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `in ${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
}
