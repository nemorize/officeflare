import { useEffect, useRef, useState, type FormEvent } from "react";
import { PasswordField } from "../components/password-field";
import { Link, Navigate, useLocation } from "react-router";
import {
  Button,
  Field,
  Fieldset,
  Form,
  Icon,
  OfficeflareMark,
  Select,
  SelectPopup,
  TextField,
  useNotifications,
} from "@/components/ui";
import {
  AuthError,
  changePassword,
  login,
  recoverMfa,
  verifyMfa,
  type LoginResult,
  type MfaChallenge,
  type PasswordChallenge,
} from "../lib/auth";
import { sessions, useSession } from "../lib/session";
import { SessionStorageError } from "../lib/session-manager";
import { returnToWorkspace } from "../lib/profile";
import { WorkspaceLoading } from "../components/workspace-loading";

type Step =
  | { kind: "login" }
  | { kind: "mfa"; challenge: MfaChallenge }
  | { kind: "password_reset"; challenge: PasswordChallenge };

const headings = {
  login: ["Sign in to Officeflare", "Enter your email and password."],
  mfa: ["Two-factor authentication", "Enter a code from your authenticator app."],
  password_reset: ["Change password", "Set a new password to sign in."],
} as const;

export function LoginPage() {
  const notify = useNotifications();
  const authSession = useSession();
  const location = useLocation();
  const [step, setStep] = useState<Step>({ kind: "login" });
  const restoring = authSession.status === "loading" || authSession.status === "unavailable";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [methodId, setMethodId] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [title, description] = headings[step.kind];

  useEffect(() => {
    document.title = `${step.kind === "login" ? "Sign in" : title} · Officeflare`;
    if (step.kind !== "login") heading.current?.focus();
  }, [step.kind, title]);

  function startOver() {
    setStep({ kind: "login" });
    setPassword("");
    setNewPassword("");
    setConfirmation("");
    setCode("");
    setError("");
    setRecovery(false);
  }

  async function accept(result: LoginResult) {
    setPassword("");
    setCode("");
    setNewPassword("");
    setConfirmation("");
    setError("");
    if ("next" in result) {
      if (result.next === "mfa") {
        setMethodId(result.methods[0]?.id ?? "");
        setRecovery(result.methods.length === 0);
        setStep({ kind: "mfa", challenge: result });
      } else {
        setStep({ kind: "password_reset", challenge: result });
      }
    } else {
      await sessions.accept(result, email);
      setStep({ kind: "login" });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");

    if (
      (step.kind === "mfa" || step.kind === "password_reset") &&
      step.challenge.expires_at * 1000 <= Date.now()
    ) {
      startOver();
      setError("The verification request has expired. Sign in again.");
      return;
    }
    if (step.kind === "password_reset") {
      const length = [...newPassword].length;
      if (length < 15 || length > 128 || new TextEncoder().encode(newPassword).length > 512) {
        setError("Your new password must contain 15–128 characters.");
        return;
      }
      if (newPassword !== confirmation) {
        setError("The passwords do not match.");
        return;
      }
    }

    inFlight.current = true;
    setBusy(true);
    try {
      switch (step.kind) {
        case "login":
          await accept(await login(email, password));
          break;
        case "mfa":
          await accept(
            await (recovery
              ? recoverMfa(step.challenge.challenge_token, code)
              : verifyMfa(step.challenge.challenge_token, methodId, code.trim())),
          );
          break;
        case "password_reset":
          await accept(await changePassword(step.challenge.challenge_token, newPassword));
          break;
      }
    } catch (failure) {
      if (failure instanceof SessionStorageError) {
        notify.error(failure.message);
      } else if (failure instanceof AuthError) {
        if (failure.status === 429) notify.error("Too many requests. Try again later.");
        else if (failure.status === 401 && step.kind === "login")
          setError("Check your email and password.");
        else if (failure.status === 401 && step.kind === "mfa")
          setError(
            "The code is incorrect or the verification request has expired. Check the code and try again.",
          );
        else if (failure.status === 401 && step.kind === "password_reset") {
          startOver();
          setError("The verification request has expired. Sign in again.");
        } else if (failure.status === 400) setError("Check the information you entered.");
        else notify.error("Unable to complete your request. Try again later.");
      } else {
        notify.error("Unable to connect to the server. Check your connection and try again.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (authSession.session) return <Navigate to={returnToWorkspace(location.state?.from)} replace />;
  if (restoring)
    return (
      <WorkspaceLoading
        error={authSession.error}
        onRetry={() => {
          void sessions.restore();
        }}
      />
    );

  return (
    <div className="login-page">
      <header className="login-header">
        <Link to="/login" className="login-brand">
          <OfficeflareMark />
          Officeflare
        </Link>
      </header>
      <main className="login-content">
        <section className="login-card" aria-labelledby="login-heading">
          <div className="login-symbol">
            <Icon name={step.kind === "mfa" ? "shield" : "user"} width="20" height="20" />
          </div>
          <h1 id="login-heading" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          {(description || (step.kind === "mfa" && recovery)) && (
            <p>
              {step.kind === "mfa" && recovery
                ? "Enter one of your saved recovery codes."
                : description}
            </p>
          )}

          <Form onSubmit={submit} aria-busy={busy}>
            <Fieldset.Root disabled={busy} aria-labelledby="login-heading">
              {step.kind === "login" && (
                <>
                  <TextField
                    id="email"
                    name="email"
                    label="Email"
                    type="email"
                    autoComplete="username"
                    required
                    maxLength={254}
                    value={email}
                    onValueChange={setEmail}
                  />
                  <PasswordField
                    id="password"
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    autoComplete="current-password"
                  />
                </>
              )}

              {step.kind === "mfa" && (
                <>
                  {!recovery && step.challenge.methods.length > 1 && (
                    <Field.Root name="method">
                      <Select.Root
                        items={step.challenge.methods.map((method, index) => ({
                          value: method.id,
                          label: method.name || `Authenticator app ${index + 1}`,
                        }))}
                        value={methodId}
                        onValueChange={(value) => {
                          setMethodId(value ?? "");
                          setCode("");
                          setError("");
                        }}
                      >
                        <Select.Label>Authentication method</Select.Label>{" "}
                        <Select.Trigger id="method">
                          <Select.Value />
                        </Select.Trigger>
                        <SelectPopup>
                          <Select.List>
                            {step.challenge.methods.map((method, index) => (
                              <Select.Item key={method.id} value={method.id}>
                                <Select.ItemText>
                                  {method.name || `Authenticator app ${index + 1}`}
                                </Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.List>
                        </SelectPopup>
                      </Select.Root>
                    </Field.Root>
                  )}
                  <TextField
                    key={recovery ? "recovery" : "totp"}
                    id="code"
                    name="code"
                    label={recovery ? "Recovery code" : "Authentication code"}
                    type="text"
                    autoComplete="one-time-code"
                    inputMode={recovery ? "text" : "numeric"}
                    pattern={recovery ? undefined : "[0-9]{6}"}
                    maxLength={recovery ? 64 : 6}
                    placeholder={recovery ? "Enter a recovery code" : "6-digit code"}
                    description={
                      recovery
                        ? "Each recovery code can only be used once."
                        : "Find the code in your authenticator app."
                    }
                    required
                    value={code}
                    onValueChange={setCode}
                  />
                </>
              )}

              {step.kind === "password_reset" && (
                <>
                  <PasswordField
                    id="new-password"
                    label="New password"
                    value={newPassword}
                    onChange={setNewPassword}
                    autoComplete="new-password"
                    describedBy="password-hint"
                  />
                  <p id="password-hint">Use 15–128 characters.</p>
                  <PasswordField
                    id="confirm-password"
                    label="New password confirmation"
                    value={confirmation}
                    onChange={setConfirmation}
                    autoComplete="new-password"
                  />
                </>
              )}

              {authSession.error && <p role="alert">{authSession.error}</p>}
              {error && (
                <p role="alert" className="ui-inline-alert">
                  <Icon name="info" />
                  <span>{error}</span>
                </p>
              )}

              <p>
                <Button type="submit" variant="primary" size="lg" className="login-submit">
                  {busy
                    ? "Processing…"
                    : step.kind === "login"
                      ? "Sign in"
                      : step.kind === "mfa"
                        ? "Verify"
                        : "Change password and sign in"}
                </Button>
              </p>

              {step.kind === "mfa" && step.challenge.methods.length > 0 && (
                <p>
                  <Button
                    type="button"
                    variant="ghost"
                    className="login-secondary"
                    onClick={() => {
                      setRecovery(!recovery);
                      setCode("");
                      setError("");
                    }}
                  >
                    {recovery ? "Use an authenticator code" : "Use a recovery code"}
                  </Button>
                </p>
              )}
              {(step.kind === "mfa" || step.kind === "password_reset") && (
                <p>
                  <Button
                    type="button"
                    variant="ghost"
                    className="login-secondary"
                    onClick={startOver}
                  >
                    Start over
                  </Button>
                </p>
              )}
            </Fieldset.Root>
          </Form>

          {step.kind === "login" && (
            <p className="login-help">
              Contact your organization administrator if you need an account or have forgotten your
              password.
            </p>
          )}
        </section>
      </main>
      <footer className="login-footer">Officeflare · Your workspace, connected.</footer>
    </div>
  );
}
