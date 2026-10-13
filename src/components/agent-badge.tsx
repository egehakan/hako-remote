import type { AgentState } from "@shared/protocol";
import { CheckIcon, HandIcon, LoaderIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const LABELS: Record<AgentState["status"], string> = {
  working: "Working",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
};

export function agentLabel(agent: AgentState): string {
  return `${agent.name}: ${LABELS[agent.status].toLowerCase()}`;
}

/** What a coding agent in a terminal is doing. The label carries the state; colour only repeats it. */
export function AgentBadge({ agent }: { agent: AgentState }) {
  return (
    <Badge variant={agent.status} title={agentLabel(agent)}>
      {agent.status === "working" ? (
        <LoaderIcon data-icon="inline-start" className="motion-safe:animate-working" />
      ) : agent.status === "waiting" ? (
        <HandIcon data-icon="inline-start" />
      ) : agent.status === "done" ? (
        <CheckIcon data-icon="inline-start" />
      ) : (
        <XIcon data-icon="inline-start" />
      )}
      {LABELS[agent.status]}
    </Badge>
  );
}
