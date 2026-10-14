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
  /** A VAPID key pair from the environment, in place of the one the database keeps. */
  vapidKeys: { publicKey: string; privateKey: string } | null;
  /** The contact a push service is given for this relay: a `mailto:` or an `https:` address. */
  vapidSubject: string;
  /** Where previews are served, or null when the app's address cannot have subdomains. */
  previews: PreviewAddressing | null;
};

/** `https://<id>.<domain><port>` is the origin of the preview `<id>`. */
export type PreviewAddressing = {
  /** Lower case, without a leading dot: `hako.example.com`. */
  domain: string;
  /** `https:` or `http:`, the app's own. */
  scheme: string;
  /** `:8787`, or "" for the scheme's default port; the app's own. */
  port: string;
};

function required(env: NodeJS.ProcessEnv, name: string, minLength = 1): string {
  const value = env[name]?.trim() ?? "";
  if (value.length < minLength) {
    throw new Error(
      minLength > 1
        ? `${name} must be set to at least ${minLength} characters`
        : `${name} must be set`,
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

function vapidKeysFrom(env: NodeJS.ProcessEnv): Config["vapidKeys"] {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  if (publicKey === "" && privateKey === "") return null;
  if (publicKey === "" || privateKey === "") {
    throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together, or not at all");
  }
  return { publicKey, privateKey };
}

function vapidSubjectFrom(env: NodeJS.ProcessEnv, ownerEmail: string): string {
  const subject = env.VAPID_SUBJECT?.trim() || `mailto:${ownerEmail}`;
  if (!/^(mailto:|https:\/\/)\S+$/.test(subject)) {
    throw new Error("VAPID_SUBJECT must be a mailto: or an https: address");
  }
  return subject;
}

function isIpAddress(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[");
}

/**
 * Previews live on subdomains of `PREVIEW_DOMAIN`, or of the host of the first `PUBLIC_ORIGIN`, with
 * that origin's scheme and port. An IP address has no subdomains, so it means no previews.
 */
export function previewAddressingFrom(
  env: NodeJS.ProcessEnv,
  appOrigin: string,
): PreviewAddressing | null {
  const url = new URL(appOrigin);
  const domain = (env.PREVIEW_DOMAIN?.trim() || url.hostname)
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (domain === "" || isIpAddress(domain) || !/^[a-z0-9.-]+$/.test(domain)) return null;
  // The preview cookie is set for the whole domain: one above the app's own host would hand it to
  // hosts that are not this relay's, and would make the app's host a name of a preview.
  const appHost = url.hostname.toLowerCase();
  if (domain !== appHost && !domain.endsWith(`.${appHost}`)) {
    throw new Error(
      `PREVIEW_DOMAIN must be ${appHost} or a domain under it, the host of the first PUBLIC_ORIGIN`,
    );
  }
  return { domain, scheme: url.protocol, port: url.port === "" ? "" : `:${url.port}` };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  const origins = parseOrigins(env.PUBLIC_ORIGIN ?? `http://localhost:${port}`);
  if (origins.length === 0) throw new Error("PUBLIC_ORIGIN must list at least one origin");
  const ownerEmail = required(env, "HAKO_OWNER_EMAIL").toLowerCase();
  return {
    ownerEmail,
    initialPassword: env.HAKO_INITIAL_PASSWORD?.length ? env.HAKO_INITIAL_PASSWORD : null,
    agentKey: required(env, "HAKO_AGENT_KEY", 24),
    sessionSecret: required(env, "HAKO_SESSION_SECRET", 24),
    origins,
    secureCookies: origins.every((origin) => origin.startsWith("https://")),
    dataDir: path.resolve(env.DATA_DIR ?? "./.data"),
    port,
    clientDir: path.resolve(env.CLIENT_DIR ?? "./dist"),
    vapidKeys: vapidKeysFrom(env),
    vapidSubject: vapidSubjectFrom(env, ownerEmail),
    previews: previewAddressingFrom(env, origins[0]),
  };
}
