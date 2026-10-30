import { t } from "../../shared/i18n/index.ts";
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
  login: [t("routesLogin.signInToOfficeflare"), t("routesLogin.enterYourEmailAndPassword")],
  mfa: [
    t("routesLogin.twoFactorAuthentication"),
    t("routesLogin.enterACodeFromYourAuthenticatorApp"),
  ],
  password_reset: [t("routesLogin.changePassword"), t("routesLogin.setANewPasswordToSignIn")],
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
    document.title = t("routesLogin.officeflare", {
      value1: step.kind === "login" ? t("routesLogin.signIn") : title,
    });
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
      setError(t("routesLogin.theVerificationRequestHasExpiredSignInAgain"));
      return;
    }
    if (step.kind === "password_reset") {
      const length = [...newPassword].length;
      if (length < 15 || length > 128 || new TextEncoder().encode(newPassword).length > 512) {
        setError(t("routesLogin.yourNewPasswordMustContain15128Characters"));
        return;
      }
      if (newPassword !== confirmation) {
        setError(t("routesLogin.thePasswordsDoNotMatch"));
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
        if (failure.status === 429) notify.error(t("routesLogin.tooManyRequestsTryAgainLater"));
        else if (failure.status === 401 && step.kind === "login")
          setError(t("routesLogin.checkYourEmailAndPassword"));
        else if (failure.status === 401 && step.kind === "mfa")
          setError(t("routesLogin.theCodeIsIncorrectOrTheVerificationRequestHas"));
        else if (failure.status === 401 && step.kind === "password_reset") {
          startOver();
          setError(t("routesLogin.theVerificationRequestHasExpiredSignInAgain"));
        } else if (failure.status === 400) setError(t("routesLogin.checkTheInformationYouEntered"));
        else notify.error(t("routesLogin.unableToCompleteYourRequestTryAgainLater"));
      } else {
        notify.error(t("routesLogin.unableToConnectToTheServerCheckYourConnection"));
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
          {t("common.officeflare")}
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
                ? t("routesLogin.enterOneOfYourSavedRecoveryCodes")
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
                    label={t("common.email")}
                    type="email"
                    autoComplete="username"
                    required
                    maxLength={254}
                    value={email}
                    onValueChange={setEmail}
                  />
                  <PasswordField
                    id="password"
                    label={t("common.password")}
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
                          label:
                            method.name || t("routesLogin.authenticatorApp", { value1: index + 1 }),
                        }))}
                        value={methodId}
                        onValueChange={(value) => {
                          setMethodId(value ?? "");
                          setCode("");
                          setError("");
                        }}
                      >
                        <Select.Label>{t("routesLogin.authenticationMethod")}</Select.Label>{" "}
                        <Select.Trigger id="method">
                          <Select.Value />
                        </Select.Trigger>
                        <SelectPopup>
                          <Select.List>
                            {step.challenge.methods.map((method, index) => (
                              <Select.Item key={method.id} value={method.id}>
                                <Select.ItemText>
                                  {method.name ||
                                    t("routesLogin.authenticatorApp", { value1: index + 1 })}
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
                    label={
                      recovery ? t("routesLogin.recoveryCode") : t("routesLogin.authenticationCode")
                    }
                    type="text"
                    autoComplete="one-time-code"
                    inputMode={recovery ? "text" : "numeric"}
                    pattern={recovery ? undefined : "[0-9]{6}"}
                    maxLength={recovery ? 64 : 6}
                    placeholder={
                      recovery ? t("routesLogin.enterARecoveryCode") : t("routesLogin.6DigitCode")
                    }
                    description={
                      recovery
                        ? t("routesLogin.eachRecoveryCodeCanOnlyBeUsedOnce")
                        : t("routesLogin.findTheCodeInYourAuthenticatorApp")
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
                    label={t("routesLogin.newPassword")}
                    value={newPassword}
                    onChange={setNewPassword}
                    autoComplete="new-password"
                    describedBy="password-hint"
                  />
                  <p id="password-hint">{t("routesLogin.use15128Characters")}</p>
                  <PasswordField
                    id="confirm-password"
                    label={t("routesLogin.newPasswordConfirmation")}
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
                    ? t("common.processing")
                    : step.kind === "login"
                      ? t("routesLogin.signIn")
                      : step.kind === "mfa"
                        ? t("routesLogin.verify")
                        : t("routesLogin.changePasswordAndSignIn")}
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
                    {recovery
                      ? t("routesLogin.useAnAuthenticatorCode")
                      : t("routesLogin.useARecoveryCode")}
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
                    {t("routesLogin.startOver")}
                  </Button>
                </p>
              )}
            </Fieldset.Root>
          </Form>

          {step.kind === "login" && (
            <p className="login-help">
              {t("routesLogin.contactYourOrganizationAdministratorIfYouNeedAnAccount")}
            </p>
          )}
        </section>
      </main>
      <footer className="login-footer">{t("routesLogin.officeflareYourWorkspaceConnected")}</footer>
    </div>
  );
}
