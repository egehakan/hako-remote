import { type FormEvent, useState } from "react";
import { BoxMark } from "@/components/box-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type ApiError, api, describeWait } from "@/lib/api";

function explain(error: ApiError): { title: string; detail: string } {
  switch (error.kind) {
    case "invalid_credentials": {
      const left = error.remaining;
      const tries = left === null ? "" : left === 1 ? " 1 try left." : ` ${left} tries left.`;
      return { title: "Wrong email or password", detail: `Check both and try again.${tries}` };
    }
    case "locked":
      return {
        title: "Too many wrong tries",
        detail: `Logging in is blocked for this email. Try again ${describeWait(error.retryAfterSeconds)}.`,
      };
    case "network":
      return { title: "Can’t reach the server", detail: "Check your connection and try again." };
    case "weak_password":
    case "unauthorized":
    case "server":
      return { title: "Couldn’t log in", detail: "The server had a problem. Try again." };
  }
}

export function LoginScreen({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function logIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    const result = await api.login(
      String(data.get("email") ?? ""),
      String(data.get("password") ?? ""),
    );
    setBusy(false);
    if (result.ok) {
      onLoggedIn(result.value.email);
      return;
    }
    setError(result.error);
    if (result.error.kind === "invalid_credentials") {
      form.querySelector<HTMLInputElement>("[name=password]")?.select();
    }
  }

  const problem = error ? explain(error) : null;
  const badCredentials = error?.kind === "invalid_credentials";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-10 px-safe pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="flex items-end gap-4">
        <BoxMark className="h-16" />
        <div className="pb-0.5">
          <h1 className="text-4xl leading-none font-semibold tracking-[-0.03em]">Hako</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your Mac’s terminal, from here.</p>
        </div>
      </div>

      <form onSubmit={logIn}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              aria-invalid={badCredentials || undefined}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-invalid={badCredentials || undefined}
            />
          </Field>
          {problem ? (
            <Alert variant="destructive">
              <AlertTitle>{problem.title}</AlertTitle>
              <AlertDescription>{problem.detail}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" size="touch" disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Log in
          </Button>
        </FieldGroup>
      </form>
    </main>
  );
}
