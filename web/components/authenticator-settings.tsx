import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useEffect, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  CheckboxLabel,
  Button,
  Checkbox,
  Dialog,
  DialogPopup,
  Fieldset,
  Form,
  Icon,
  TextField,
  useNotifications,
} from "@/components/ui";
import { useSession, sessions } from "../lib/session";
import { ApiError, api, errorMessage } from "../lib/api";
import { SessionStorageError } from "../lib/session-manager";
import {
  authenticatorKey,
  createMfaClient,
  type AuthenticatorMethod,
  type AuthenticatorSetup,
  type ReauthenticationGrant,
} from "../lib/mfa";
import { ReauthenticationDialog } from "./reauthentication-dialog";

type Action =
  | { kind: "start"; name: string }
  | { kind: "activate"; setup: AuthenticatorSetup; code: string }
  | { kind: "remove"; method: AuthenticatorMethod }
  | { kind: "recovery" };

export function AuthenticatorSettings() {
  const notify = useNotifications();
  const auth = useSession();
  const [methods, setMethods] = useState<AuthenticatorMethod[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState(t("componentsAuthenticatorSettings.authenticatorApp"));
  const [setup, setSetup] = useState<AuthenticatorSetup | null>(null);
  const [code, setCode] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedCodes, setSavedCodes] = useState(false);
  const [error, setError] = useState("");
  const [timestamp, setTimestamp] = useState(Date.now());
  const email = auth.session?.email ?? "";
  const active = methods.filter((method) => method.status === "active");
  const capacity = methods.filter((method) => method.status !== "expired").length;
  const expired = setup !== null && setup.setup_expires_at * 1000 <= timestamp;
  const client = createMfaClient({
    api,
    acceptSession: (result, address) => sessions.accept(result, address),
    email: () => email,
  });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReady(false);
    void Promise.all([
      api<{ methods: AuthenticatorMethod[] }>("/api/me/mfa/methods", { signal: controller.signal }),
      api<{ remaining: number }>("/api/me/mfa/recovery-codes", { signal: controller.signal }),
    ])
      .then(([result, codes]) => {
        if (controller.signal.aborted) return;
        setMethods(result.methods);
        setRemaining(codes.remaining);
        setReady(true);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, email]);

  useEffect(() => {
    if (!setup) return;
    setTimestamp(Date.now());
    const interval = window.setInterval(() => setTimestamp(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [setup]);

  function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!name.trim() || name.trim().length > 100) {
      setError(t("componentsAuthenticatorSettings.enterAnAuthenticatorNameWithUpTo100Characters"));
      return;
    }
    setAction({ kind: "start", name: name.trim() });
  }

  function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!setup || expired) {
      setError(
        t("componentsAuthenticatorSettings.thisSetupHasExpiredRemoveThePendingAuthenticatorAnd"),
      );
      return;
    }
    if (!/^[0-9]{6}$/.test(code.trim())) {
      setError(t("componentsAuthenticatorSettings.enterTheSixDigitCodeFromYourNewAuthenticator"));
      return;
    }
    setAction({ kind: "activate", setup, code: code.trim() });
  }

  async function perform(grant: ReauthenticationGrant) {
    if (!action) return;
    setError("");
    try {
      switch (action.kind) {
        case "start": {
          const result = await client.start(grant, action.name);
          setSetup(result);
          setCode("");
          setTimestamp(Date.now());
          break;
        }
        case "activate":
          await client.activate(grant, action.setup, action.code);
          setSetup(null);
          setCode("");
          notify.success(
            t("componentsAuthenticatorSettings.otpIsEnabledOtherSessionsHaveBeenSignedOut"),
          );
          break;
        case "remove":
          await client.remove(grant, action.method.id);
          if (setup?.method_id === action.method.id) {
            setSetup(null);
            setCode("");
          }
          notify.success(
            t(
              "componentsAuthenticatorSettings.theAuthenticatorHasBeenRemovedOtherSessionsHaveBeen",
            ),
          );
          break;
        case "recovery": {
          const result = await client.recoveryCodes(grant);
          setRecoveryCodes(result.recovery_codes);
          setSavedCodes(false);
          notify.success(
            t("componentsAuthenticatorSettings.newRecoveryCodesHaveBeenGeneratedPreviousCodesAre"),
          );
          break;
        }
      }
      setRevision((value) => value + 1);
    } catch (failure) {
      notify.error(
        failure instanceof SessionStorageError
          ? failure.message
          : failure instanceof ApiError && failure.status === 401
            ? action.kind === "activate"
              ? t(
                  "componentsAuthenticatorSettings.theNewAuthenticatorCodeIsIncorrectOrVerificationExpired",
                )
              : t("componentsAuthenticatorSettings.verificationExpiredVerifyYourIdentityAgain")
            : failure instanceof ApiError
              ? errorMessage(failure)
              : failure instanceof Error
                ? failure.message
                : errorMessage(failure),
      );
    } finally {
      setAction(null);
    }
  }

  function downloadCodes() {
    const url = URL.createObjectURL(
      new Blob(
        [
          t("componentsAuthenticatorSettings.officeflareRecoveryCodesKeepTheseCodesInASafe", {
            join: recoveryCodes.join("\n"),
          }),
        ],
        { type: "text/plain;charset=utf-8" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "officeflare-recovery-codes.txt";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const title =
    action?.kind === "activate"
      ? t("componentsAuthenticatorSettings.enableOtp")
      : action?.kind === "remove"
        ? t("componentsAuthenticatorSettings.removeAuthenticator")
        : action?.kind === "recovery"
          ? t("componentsAuthenticatorSettings.generateRecoveryCodes")
          : t("componentsAuthenticatorSettings.registerAnAuthenticator");
  const description =
    action?.kind === "activate"
      ? t("componentsAuthenticatorSettings.confirmYourIdentityToEnableYourNewAuthenticatorOther")
      : action?.kind === "remove"
        ? t("componentsAuthenticatorSettings.confirmYourIdentityToRemoveOtherSessionsWillBe", {
            value1:
              action.method.status === "active" && active.length === 1
                ? t(
                    "componentsAuthenticatorSettings.removingYourLastAuthenticatorTurnsOffOtpAndInvalidates",
                  )
                : "",
            value2: action.method.name || t("componentsAuthenticatorSettings.thisAuthenticator"),
          })
        : action?.kind === "recovery"
          ? t(
              "componentsAuthenticatorSettings.confirmYourIdentityToGenerateTenRecoveryCodesPrevious",
            )
          : t("componentsAuthenticatorSettings.enterYourCurrentPasswordToCreateAQrCode");

  return (
    <section className="account-panel account-mfa-panel" aria-labelledby="account-mfa-title">
      <div className="account-panel-header account-mfa-header">
        <div>
          <h2 id="account-mfa-title">
            {t("componentsAuthenticatorSettings.twoFactorAuthenticationOtp")}
          </h2>
          <p>{t("componentsAuthenticatorSettings.useACodeFromYourAuthenticatorAppWhenYou")}</p>
        </div>
        {ready && (
          <span className="account-mfa-status" data-enabled={active.length > 0}>
            {active.length > 0
              ? t("common.enabled")
              : t("componentsAuthenticatorSettings.notEnabled")}
          </span>
        )}
      </div>
      {loading && (
        <p className="account-loading" role="status">
          {t("componentsAuthenticatorSettings.loadingAuthenticators")}
        </p>
      )}
      {error && (
        <p className="account-notice" data-error role="alert">
          <Icon name="info" />
          {error}
        </p>
      )}
      {ready && (
        <>
          {methods.length > 0 && (
            <ul className="account-authenticator-list">
              {methods.map((method) => (
                <li key={method.id}>
                  <span className="account-session-icon">
                    <Icon name="shield" />
                  </span>
                  <div>
                    <strong>
                      {method.name || t("componentsAuthenticatorSettings.authenticatorApp")}
                    </strong>
                    <p>
                      {method.status === "active"
                        ? t("common.active")
                        : method.status === "pending"
                          ? t("componentsAuthenticatorSettings.awaitingVerification")
                          : t("componentsAuthenticatorSettings.setupExpired")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    disabled={loading || action !== null}
                    onClick={() => {
                      setError("");
                      setAction({ kind: "remove", method });
                    }}
                  >
                    {t("common.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {setup ? (
            <div className="account-otp-setup">
              <h3>{t("componentsAuthenticatorSettings.connectYourAuthenticator")}</h3>
              {expired ? (
                <p className="account-notice" data-error role="alert">
                  {t(
                    "componentsAuthenticatorSettings.thisQrCodeHasExpiredRemoveThePendingAuthenticator",
                  )}
                </p>
              ) : (
                <>
                  <p>
                    {t("componentsAuthenticatorSettings.scanThisQrCodeInYourAuthenticatorAppOr", {
                      toLocaleTimeString: new Date(
                        setup.setup_expires_at * 1000,
                      ).toLocaleTimeString("en", {
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    })}
                  </p>
                  <div className="account-otp-qr">
                    <QRCodeSVG
                      value={setup.provisioning_uri}
                      size={204}
                      marginSize={4}
                      level="M"
                      title={t("componentsAuthenticatorSettings.authenticatorSetupQrCode")}
                    />
                  </div>
                  <TextField
                    label={t("componentsAuthenticatorSettings.setupKey")}
                    value={authenticatorKey(setup.provisioning_uri)}
                    readOnly
                    autoComplete="off"
                    font="mono"
                  />
                  <Form onSubmit={verify} className="account-otp-form">
                    <Fieldset.Root disabled={action !== null || loading}>
                      <TextField
                        label={t("componentsAuthenticatorSettings.codeFromYourNewAuthenticator")}
                        name="new_authenticator_code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        maxLength={6}
                        required
                        value={code}
                        onValueChange={setCode}
                      />
                      <div className="account-actions">
                        <Button type="submit" variant="primary">
                          {t("componentsAuthenticatorSettings.verifyAndEnableOtp")}
                        </Button>
                      </div>
                    </Fieldset.Root>
                  </Form>
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={action !== null}
                onClick={() => {
                  setSetup(null);
                  setCode("");
                }}
              >
                {t("componentsAuthenticatorSettings.hideSetup")}
              </Button>
              <p className="account-verification-hint">
                {t(
                  "componentsAuthenticatorSettings.otpStaysDisabledForThisAuthenticatorUntilYouVerify",
                )}
              </p>
            </div>
          ) : (
            <Form onSubmit={begin} className="account-otp-form">
              <Fieldset.Root disabled={loading || action !== null || capacity >= 5}>
                <TextField
                  label={t("componentsAuthenticatorSettings.authenticatorName")}
                  name="authenticator_name"
                  required
                  maxLength={100}
                  value={name}
                  onValueChange={setName}
                  description={t(
                    "componentsAuthenticatorSettings.chooseANameToRecognizeThisDevice",
                  )}
                />
                <div className="account-actions">
                  <Button type="submit" variant="primary">
                    <Icon name="plus" />
                    {t("componentsAuthenticatorSettings.registerAuthenticator")}
                  </Button>
                </div>
              </Fieldset.Root>
              {capacity >= 5 && (
                <p className="account-verification-hint">
                  {t("componentsAuthenticatorSettings.youCanHaveUpToFiveActiveOrPending")}
                </p>
              )}
            </Form>
          )}
          {active.length > 0 && (
            <div className="account-recovery-section">
              <div>
                <h3>{t("componentsAuthenticatorSettings.recoveryCodes")}</h3>
                <p>
                  <LocalizedMessage
                    id="componentsAuthenticatorSettings.keepThemSomewhereSafeInCaseYouLoseYour"
                    values={{
                      value1:
                        remaining > 0
                          ? t("componentsAuthenticatorSettings.unusedCodesRemaining", {
                              remaining: remaining,
                            })
                          : t("componentsAuthenticatorSettings.noRecoveryCodesSavedYet"),
                    }}
                  />
                </p>
              </div>
              <Button
                type="button"
                disabled={loading || action !== null}
                onClick={() => {
                  setError("");
                  setAction({ kind: "recovery" });
                }}
              >
                {remaining > 0
                  ? t("componentsAuthenticatorSettings.replaceRecoveryCodes")
                  : t("componentsAuthenticatorSettings.generateRecoveryCodes")}
              </Button>
            </div>
          )}
        </>
      )}
      <ReauthenticationDialog
        open={action !== null}
        title={title}
        description={description}
        confirmLabel={
          action?.kind === "start" ? t("componentsAuthenticatorSettings.createQrCode") : title
        }
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        onVerified={perform}
      />
      <Dialog.Root
        open={recoveryCodes.length > 0}
        onOpenChange={(open) => {
          if (!open && savedCodes) {
            setRecoveryCodes([]);
            setSavedCodes(false);
          }
        }}
      >
        <DialogPopup>
          <Dialog.Title>{t("componentsAuthenticatorSettings.saveYourRecoveryCodes")}</Dialog.Title>
          <Dialog.Description>
            {t("componentsAuthenticatorSettings.theseCodesAreShownOnlyOnceEachCodeCan")}
          </Dialog.Description>
          <ul className="account-recovery-codes">
            {recoveryCodes.map((value) => (
              <li key={value}>
                <code>{value}</code>
              </li>
            ))}
          </ul>
          <Button type="button" onClick={downloadCodes}>
            {t("componentsAuthenticatorSettings.downloadCodes")}
          </Button>
          <CheckboxLabel className="account-recovery-confirm">
            <Checkbox.Root
              checked={savedCodes}
              onCheckedChange={(checked) => setSavedCodes(checked)}
            >
              <Checkbox.Indicator>
                <Icon name="check" width="12" height="12" />
              </Checkbox.Indicator>
            </Checkbox.Root>
            {t("componentsAuthenticatorSettings.iSavedMyRecoveryCodes")}
          </CheckboxLabel>
          <div className="account-actions">
            <Button
              type="button"
              variant="primary"
              disabled={!savedCodes}
              onClick={() => {
                setRecoveryCodes([]);
                setSavedCodes(false);
              }}
            >
              {t("common.done")}
            </Button>
          </div>
        </DialogPopup>
      </Dialog.Root>
    </section>
  );
}
