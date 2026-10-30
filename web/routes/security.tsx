import { t } from "../../shared/i18n/index.ts";
import { useRef, useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogPopup,
  Fieldset,
  Form,
  Icon,
  Select,
  SelectPopup,
  TextField,
  useNotifications,
} from "@/components/ui";
import { PasswordField } from "../components/password-field";
import { useAccount } from "../components/account-context";
import { ApiError, api, errorMessage } from "../lib/api";
import type { MfaChallenge, Session } from "../lib/auth";
import { validatePassword } from "../lib/profile";
import { sessions, useSession } from "../lib/session";
import { SessionStorageError } from "../lib/session-manager";
import { AuthenticatorSettings } from "../components/authenticator-settings";

interface Grant {
  reauthentication_token: string;
  expires_at: number;
}

export function SecurityPage() {
  const notify = useNotifications();
  const { reload } = useAccount();
  const auth = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [method, setMethod] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const inFlight = useRef(false);

  function cancelVerification() {
    if (inFlight.current) return;
    setChallenge(null);
    setCode("");
    setDialogError("");
    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
  }

  async function change(grant: Grant) {
    if (grant.expires_at * 1000 <= Date.now())
      throw new Error(t("routesSecurity.verificationExpiredEnterYourCurrentPasswordAndTryAgain"));
    const tokens = await api<Session>("/api/me/password", {
      method: "PUT",
      token: grant.reauthentication_token,
      body: { new_password: password },
    });
    await sessions.accept(tokens, auth.session?.email ?? "");
    setPassword("");
    setCurrentPassword("");
    setConfirmation("");
    setChallenge(null);
    setCode("");
    setDialogError("");
    notify.success(t("routesSecurity.yourPasswordHasBeenChangedOtherSessionsHaveBeen"));
    await reload().catch(() => {});
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    try {
      validatePassword(password, confirmation);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("routesSecurity.checkYourPassword"));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await api<Grant | MfaChallenge>("/api/auth/reauthenticate", {
        method: "POST",
        retryAuth: false,
        body: { password: currentPassword },
      });
      setCurrentPassword("");
      if ("next" in result) {
        setChallenge(result);
        setMethod(result.methods[0]?.id ?? "");
        setRecovery(result.methods.length === 0);
        setDialogError("");
        setCode("");
      } else await change(result);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401)
        setError(t("routesSecurity.checkYourCurrentPasswordAndTryAgain"));
      else
        notify.error(
          failure instanceof SessionStorageError ? failure.message : errorMessage(failure),
        );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || inFlight.current) return;
    if (challenge.expires_at * 1000 <= Date.now()) {
      cancelVerification();
      setError(t("routesSecurity.verificationExpiredEnterYourCurrentPasswordAndTryAgain"));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setDialogError("");
    try {
      const grant = await api<Grant>(recovery ? "/api/auth/mfa/recovery" : "/api/auth/mfa/verify", {
        method: "POST",
        token: challenge.challenge_token,
        body: recovery ? { recovery_code: code.trim() } : { method_id: method, code: code.trim() },
      });
      await change(grant);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401)
        setDialogError(t("routesSecurity.theCodeIsIncorrectOrVerificationHasExpiredCheck"));
      else
        notify.error(
          failure instanceof SessionStorageError ? failure.message : errorMessage(failure),
        );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="account-page">
      <header className="account-page-header">
        <h1>{t("routesSecurity.security")}</h1>
        <p>{t("routesSecurity.keepYourAccountSecure")}</p>
      </header>
      <section className="account-panel">
        <div className="account-panel-header">
          <h2>{t("common.password")}</h2>
          <p>{t("routesSecurity.use15128CharactersChangingYourPasswordSignsOut")}</p>
        </div>
        <Form onSubmit={submit} aria-busy={busy}>
          <Fieldset.Root disabled={busy}>
            <PasswordField
              id="current-password"
              label={t("routesSecurity.currentPassword")}
              value={currentPassword}
              onChange={setCurrentPassword}
              autoComplete="current-password"
            />
            <PasswordField
              id="account-new-password"
              label={t("routesSecurity.newPassword")}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
            />
            <PasswordField
              id="account-confirm-password"
              label={t("routesSecurity.confirmNewPassword")}
              value={confirmation}
              onChange={setConfirmation}
              autoComplete="new-password"
            />
          </Fieldset.Root>
          {error && (
            <p className="account-notice" data-error role="alert">
              <Icon name="info" />
              {error}
            </p>
          )}
          <div className="account-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? t("routesSecurity.verifying") : t("routesSecurity.changePassword")}
            </Button>
          </div>
        </Form>
      </section>
      <AuthenticatorSettings />
      <Dialog.Root
        open={challenge !== null}
        onOpenChange={(open) => {
          if (!open) cancelVerification();
        }}
      >
        <DialogPopup>
          <Dialog.Title>{t("routesSecurity.verifyYourIdentity")}</Dialog.Title>
          <Dialog.Description>
            {recovery
              ? t("routesSecurity.enterASavedRecoveryCodeToChangeYourPassword")
              : t("routesSecurity.enterACodeFromYourAuthenticatorAppToChange")}
          </Dialog.Description>
          <Form onSubmit={verify} className="account-dialog-form" aria-busy={busy}>
            <Fieldset.Root disabled={busy}>
              {!recovery && challenge && challenge.methods.length > 1 && (
                <Select.Root
                  items={challenge.methods.map((item, index) => ({
                    value: item.id,
                    label: item.name || t("routesSecurity.authenticatorApp", { value1: index + 1 }),
                  }))}
                  value={method}
                  onValueChange={(value) => {
                    setMethod(value ?? "");
                    setCode("");
                    setDialogError("");
                  }}
                >
                  <Select.Label>{t("routesSecurity.authenticationMethod")}</Select.Label>
                  <Select.Trigger>
                    <Select.Value />
                  </Select.Trigger>
                  <SelectPopup>
                    <Select.List>
                      {challenge.methods.map((item, index) => (
                        <Select.Item key={item.id} value={item.id}>
                          <Select.ItemText>
                            {item.name ||
                              t("routesSecurity.authenticatorApp", { value1: index + 1 })}
                          </Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </SelectPopup>
                </Select.Root>
              )}
              <TextField
                key={recovery ? "recovery" : "authenticator"}
                label={
                  recovery
                    ? t("routesSecurity.recoveryCode")
                    : t("routesSecurity.authenticationCode")
                }
                name="code"
                autoComplete="one-time-code"
                inputMode={recovery ? "text" : "numeric"}
                pattern={recovery ? undefined : "[0-9]{6}"}
                maxLength={recovery ? 64 : 6}
                required
                value={code}
                onValueChange={setCode}
              />
              {dialogError && (
                <p className="account-notice" data-error role="alert">
                  {dialogError}
                </p>
              )}
              {challenge && challenge.methods.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setRecovery(!recovery);
                    setCode("");
                    setDialogError("");
                  }}
                >
                  {recovery
                    ? t("routesSecurity.useAnAuthenticatorCode")
                    : t("routesSecurity.useARecoveryCode")}
                </Button>
              )}
              <div className="account-actions">
                <Button type="button" onClick={cancelVerification}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" variant="primary">
                  {busy
                    ? t("routesSecurity.verifying")
                    : t("routesSecurity.verifyAndChangePassword")}
                </Button>
              </div>
            </Fieldset.Root>
          </Form>
        </DialogPopup>
      </Dialog.Root>
    </section>
  );
}
