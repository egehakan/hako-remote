import { CircleCheckIcon, LogOutIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { DetailHeader } from "@/components/detail-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { api, describeWait } from "@/lib/api";

const MIN_PASSWORD_LENGTH = 10;

type Problem = { field: "current" | "next" | "form"; message: string };

export function AccountScreen({ email, onLoggedOut }: { email: string; onLoggedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [changed, setChanged] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const current = String(data.get("current") ?? "");
    const next = String(data.get("next") ?? "");
    setChanged(false);
    const focus = (name: "current" | "next") =>
      form.querySelector<HTMLInputElement>(`[name=${name}]`)?.focus();
    if (next.length < MIN_PASSWORD_LENGTH) {
      setProblem({ field: "next", message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
      focus("next");
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.changePassword(current, next);
    setBusy(false);
    if (result.ok) {
      form.reset();
      setChanged(true);
      return;
    }
    switch (result.error.kind) {
      case "invalid_credentials":
        setProblem({ field: "current", message: "That isn’t your current password." });
        focus("current");
        break;
      case "weak_password":
        setProblem({ field: "next", message: result.error.message });
        focus("next");
        break;
      case "locked":
        setProblem({
          field: "form",
          message: `Too many wrong passwords. Try again ${describeWait(result.error.retryAfterSeconds)}.`,
        });
        break;
      case "unauthorized":
        onLoggedOut();
        break;
      case "network":
        setProblem({ field: "form", message: "Can’t reach the server. Check your connection." });
        break;
      case "server":
        setProblem({
          field: "form",
          message: "The server couldn’t change the password. Try again.",
        });
        break;
    }
  }

  async function logOut() {
    setLoggingOut(true);
    await api.logout();
    onLoggedOut();
  }

  return (
    <>
      <DetailHeader title="Account" back={false} />
      <div className="flex max-w-md flex-col gap-8 px-safe py-6 wide:px-6">
        <div>
          <p className="text-sm text-muted-foreground">Signed in as</p>
          <p className="font-medium break-all">{email}</p>
        </div>

        <form onSubmit={changePassword} noValidate>
          <FieldGroup>
            <h2 className="text-base font-semibold">Change password</h2>
            <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
            <Field data-invalid={problem?.field === "current" || undefined}>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input
                id="current-password"
                name="current"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={problem?.field === "current" || undefined}
              />
              {problem?.field === "current" ? <FieldError>{problem.message}</FieldError> : null}
            </Field>
            <Field data-invalid={problem?.field === "next" || undefined}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                name="next"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                aria-invalid={problem?.field === "next" || undefined}
                aria-describedby="new-password-help"
              />
              {problem?.field === "next" ? (
                <FieldError id="new-password-help">{problem.message}</FieldError>
              ) : (
                <FieldDescription id="new-password-help">
                  At least {MIN_PASSWORD_LENGTH} characters. Anyone with this password gets a shell
                  on your Mac, so make it long.
                </FieldDescription>
              )}
            </Field>
            {problem?.field === "form" ? (
              <Alert variant="destructive">
                <AlertDescription>{problem.message}</AlertDescription>
              </Alert>
            ) : null}
            {changed ? (
              <Alert>
                <CircleCheckIcon className="text-settled" />
                <AlertDescription>
                  Password changed. Every other device was signed out.
                </AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" size="touch" disabled={busy} className="self-start">
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Change password
            </Button>
          </FieldGroup>
        </form>

        <Separator />

        <Button
          variant="outline"
          size="touch"
          className="self-start"
          disabled={loggingOut}
          onClick={() => void logOut()}
        >
          {loggingOut ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <LogOutIcon data-icon="inline-start" />
          )}
          Log out
        </Button>
      </div>
    </>
  );
}
