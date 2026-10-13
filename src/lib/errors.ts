import { RpcFailure } from "./connection";

/** Says what went wrong with a request to the Mac, and what to do about it. */
export function describeFailure(error: unknown): string {
  if (!(error instanceof RpcFailure)) return "Something went wrong. Try again.";
  switch (error.code) {
    case "agent_offline":
      return "Your Mac went offline before this finished.";
    case "timeout":
      return "Your Mac didn’t answer. Try again.";
    case "disconnected":
      return "Not connected right now. Try again in a moment.";
    case "not_found":
      return "That tab is no longer open on your Mac.";
    case "not_supported":
      return "The Hako on your Mac can’t do this yet. Update it and try again.";
    case "bad_request":
    case "failed":
    case "not_a_directory":
    case "is_a_directory":
    case "permission_denied":
    case "conflict":
    case "too_large":
    case "git_failed":
    case "busy":
      return error.message || "Your Mac couldn’t do that.";
  }
}
