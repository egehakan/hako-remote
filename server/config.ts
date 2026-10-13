import path from "node:path";

export type Config = {
  ownerEmail: string;
  initialPassword: string | null;
  agentKey: string;
  sessionSecret: string;
  origins: string[];
  secureCookies: boolean;
  dataDir: string;
  port: number;
  clientDir: string;
};

function required(env: NodeJS.ProcessEnv, name: string, minLength = 1): string {
  const value = env[name]?.trim() ?? "";
  if (value.length < minLength) {
    throw new Error(
      minLength > 1 ? `${name} must be set to at least ${minLength} characters` : `${name} must be set`,
    );
  }
  return value;
}

export function parseOrigins(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter((item) => item.length > 0)
    .map((item) => new URL(item).origin);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  const origins = parseOrigins(env.PUBLIC_ORIGIN ?? `http://localhost:${port}`);
  if (origins.length === 0) throw new Error("PUBLIC_ORIGIN must list at least one origin");
  return {
    ownerEmail: required(env, "HAKO_OWNER_EMAIL").toLowerCase(),
    initialPassword: env.HAKO_INITIAL_PASSWORD?.length ? env.HAKO_INITIAL_PASSWORD : null,
    agentKey: required(env, "HAKO_AGENT_KEY", 24),
    sessionSecret: required(env, "HAKO_SESSION_SECRET", 24),
    origins,
    secureCookies: origins.every((origin) => origin.startsWith("https://")),
    dataDir: path.resolve(env.DATA_DIR ?? "./.data"),
    port,
    clientDir: path.resolve(env.CLIENT_DIR ?? "./dist"),
  };
}
