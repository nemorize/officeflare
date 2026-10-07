import { useEffect, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button, Checkbox, Dialog, DialogPopup, Fieldset, Form, Icon, TextField, useNotifications } from "@/components/ui";
import { useSession, sessions } from "../lib/session";
import { ApiError, api, errorMessage } from "../lib/api";
import { SessionStorageError } from "../lib/session-manager";
import { authenticatorKey, createMfaClient, type AuthenticatorMethod, type AuthenticatorSetup, type ReauthenticationGrant } from "../lib/mfa";
import { ReauthenticationDialog } from "./reauthentication-dialog";

type Action = { kind: "start"; name: string } | { kind: "activate"; setup: AuthenticatorSetup; code: string }
  | { kind: "remove"; method: AuthenticatorMethod } | { kind: "recovery" };

export function AuthenticatorSettings() {
  const notify = useNotifications();
  const auth = useSession();
  const [methods, setMethods] = useState<AuthenticatorMethod[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState("Authenticator app");
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
  const client = createMfaClient({ api, acceptSession: (result, address) => sessions.accept(result, address), email: () => email });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setReady(false);
    void Promise.all([
      api<{ methods: AuthenticatorMethod[] }>("/api/me/mfa/methods", { signal: controller.signal }),
      api<{ remaining: number }>("/api/me/mfa/recovery-codes", { signal: controller.signal }),
    ]).then(([result, codes]) => {
      if (controller.signal.aborted) return;
      setMethods(result.methods); setRemaining(codes.remaining); setReady(true);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, email]);

  useEffect(() => {
    if (!setup) return;
    setTimestamp(Date.now());
    const interval = window.setInterval(() => setTimestamp(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [setup]);

  function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!name.trim() || name.trim().length > 100) { setError("Enter an authenticator name with up to 100 characters."); return; }
    setAction({ kind: "start", name: name.trim() });
  }

  function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!setup || expired) { setError("This setup has expired. Remove the pending authenticator and start again."); return; }
    if (!/^[0-9]{6}$/.test(code.trim())) { setError("Enter the six-digit code from your new authenticator."); return; }
    setAction({ kind: "activate", setup, code: code.trim() });
  }

  async function perform(grant: ReauthenticationGrant) {
    if (!action) return;
    setError("");
    try {
      switch (action.kind) {
        case "start": {
          const result = await client.start(grant, action.name);
          setSetup(result); setCode(""); setTimestamp(Date.now()); break;
        }
        case "activate":
          await client.activate(grant, action.setup, action.code);
          setSetup(null); setCode("");
          notify.success("OTP is enabled. Other sessions have been signed out. Save recovery codes below so you can sign in if you lose your authenticator."); break;
        case "remove":
          await client.remove(grant, action.method.id);
          if (setup?.method_id === action.method.id) { setSetup(null); setCode(""); }
          notify.success("The authenticator has been removed. Other sessions have been signed out."); break;
        case "recovery": {
          const result = await client.recoveryCodes(grant);
          setRecoveryCodes(result.recovery_codes); setSavedCodes(false);
          notify.success("New recovery codes have been generated. Previous codes are no longer valid. Other sessions have been signed out."); break;
        }
      }
      setRevision((value) => value + 1);
    } catch (failure) {
      notify.error(failure instanceof SessionStorageError ? failure.message : failure instanceof ApiError && failure.status === 401
        ? action.kind === "activate" ? "The new authenticator code is incorrect or verification expired. Enter a fresh code and try again."
          : "Verification expired. Verify your identity again."
        : failure instanceof ApiError ? errorMessage(failure) : failure instanceof Error ? failure.message : errorMessage(failure));
    } finally { setAction(null); }
  }

  function downloadCodes() {
    const url = URL.createObjectURL(new Blob([`Officeflare recovery codes\nKeep these codes in a safe place. Each code can be used once.\n\n${recoveryCodes.join("\n")}\n`], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "officeflare-recovery-codes.txt"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const title = action?.kind === "activate" ? "Enable OTP" : action?.kind === "remove" ? "Remove authenticator" : action?.kind === "recovery" ? "Generate recovery codes" : "Register an authenticator";
  const description = action?.kind === "activate" ? "Confirm your identity to enable your new authenticator. Other sessions will be signed out."
    : action?.kind === "remove" ? `${action.method.status === "active" && active.length === 1 ? "Removing your last authenticator turns off OTP and invalidates your recovery codes. " : ""}Confirm your identity to remove ${action.method.name || "this authenticator"}. Other sessions will be signed out.`
      : action?.kind === "recovery" ? "Confirm your identity to generate ten recovery codes. Previous recovery codes will be replaced and other sessions will be signed out."
        : "Enter your current password to create a QR code for your authenticator app.";

  return <section className="account-panel account-mfa-panel" aria-labelledby="account-mfa-title">
    <div className="account-panel-header account-mfa-header"><div><h2 id="account-mfa-title">Two-factor authentication (OTP)</h2>
      <p>Use a code from your authenticator app when you sign in.</p></div>
      {ready && <span className="account-mfa-status" data-enabled={active.length > 0}>{active.length > 0 ? "Enabled" : "Not enabled"}</span>}
    </div>
    {loading && <p className="account-loading" role="status">Loading authenticators…</p>}
    {error && <p className="account-notice" data-error role="alert"><Icon name="info" />{error}</p>}
    {!loading && !ready ? <Button onClick={() => { setError(""); setRevision((value) => value + 1); }}>Try again</Button> : ready && <>
      {methods.length > 0 && <ul className="account-authenticator-list">{methods.map((method) => <li key={method.id}>
        <span className="account-session-icon"><Icon name="shield" /></span>
        <div><strong>{method.name || "Authenticator app"}</strong><p>{method.status === "active" ? "Active" : method.status === "pending" ? "Awaiting verification" : "Setup expired"}</p></div>
        <Button type="button" disabled={loading || action !== null} onClick={() => { setError(""); setAction({ kind: "remove", method }); }}>Remove</Button>
      </li>)}</ul>}
      {setup ? <div className="account-otp-setup">
        <h3>Connect your authenticator</h3>
        {expired ? <p className="account-notice" data-error role="alert">This QR code has expired. Remove the pending authenticator and start again.</p> : <>
          <p>Scan this QR code in your authenticator app, or enter the setup key manually. Setup expires at {new Date(setup.setup_expires_at * 1000).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" })}.</p>
          <div className="account-otp-qr"><QRCodeSVG value={setup.provisioning_uri} size={204} marginSize={4} level="M" title="Authenticator setup QR code" /></div>
          <TextField label="Setup key" value={authenticatorKey(setup.provisioning_uri)} readOnly autoComplete="off" className="account-otp-key" />
          <Form onSubmit={verify} className="account-otp-form">
            <Fieldset.Root disabled={action !== null || loading}>
              <TextField label="Code from your new authenticator" name="new_authenticator_code" inputMode="numeric" autoComplete="one-time-code"
                pattern="[0-9]{6}" maxLength={6} required value={code} onValueChange={setCode} />
              <div className="account-actions"><Button type="submit" variant="primary">Verify and enable OTP</Button></div>
            </Fieldset.Root>
          </Form>
        </>}
        <Button type="button" variant="ghost" disabled={action !== null} onClick={() => { setSetup(null); setCode(""); }}>Hide setup</Button>
        <p className="account-verification-hint">OTP stays disabled for this authenticator until you verify its code. A hidden setup cannot be reopened; remove the pending authenticator to start again.</p>
      </div> : <Form onSubmit={begin} className="account-otp-form">
        <Fieldset.Root disabled={loading || action !== null || capacity >= 5}>
          <TextField label="Authenticator name" name="authenticator_name" required maxLength={100} value={name} onValueChange={setName}
            description="Choose a name to recognize this device." />
          <div className="account-actions"><Button type="submit" variant="primary"><Icon name="plus" />Register authenticator</Button></div>
        </Fieldset.Root>
        {capacity >= 5 && <p className="account-verification-hint">You can have up to five active or pending authenticators. Remove one to add another.</p>}
      </Form>}
      {active.length > 0 && <div className="account-recovery-section"><div><h3>Recovery codes</h3>
        <p>{remaining > 0 ? `${remaining} unused codes remaining.` : "No recovery codes saved yet."} Keep them somewhere safe in case you lose your authenticator.</p></div>
        <Button type="button" disabled={loading || action !== null} onClick={() => { setError(""); setAction({ kind: "recovery" }); }}>{remaining > 0 ? "Replace recovery codes" : "Generate recovery codes"}</Button>
      </div>}
    </>}
    <ReauthenticationDialog open={action !== null} title={title} description={description}
      confirmLabel={action?.kind === "start" ? "Create QR code" : title} onOpenChange={(open) => { if (!open) setAction(null); }} onVerified={perform} />
    <Dialog.Root open={recoveryCodes.length > 0} onOpenChange={(open) => { if (!open && savedCodes) { setRecoveryCodes([]); setSavedCodes(false); } }}>
      <DialogPopup>
        <Dialog.Title>Save your recovery codes</Dialog.Title><Dialog.Description>These codes are shown only once. Each code can be used once to sign in without your authenticator.</Dialog.Description>
        <ul className="account-recovery-codes">{recoveryCodes.map((value) => <li key={value}><code>{value}</code></li>)}</ul>
        <Button type="button" onClick={downloadCodes}>Download codes</Button>
        <label className="account-recovery-confirm"><Checkbox.Root checked={savedCodes} onCheckedChange={(checked) => setSavedCodes(checked)}><Checkbox.Indicator><Icon name="check" width="12" height="12" /></Checkbox.Indicator></Checkbox.Root>I saved my recovery codes</label>
        <div className="account-actions"><Button type="button" variant="primary" disabled={!savedCodes} onClick={() => { setRecoveryCodes([]); setSavedCodes(false); }}>Done</Button></div>
      </DialogPopup>
    </Dialog.Root>
  </section>;
}
