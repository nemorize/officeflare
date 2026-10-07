import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Dialog, DialogPopup, Fieldset, Form, Select, SelectPopup, TextField } from "@/components/ui";
import { PasswordField } from "./password-field";
import { ApiError, api, errorMessage } from "../lib/api";
import type { MfaChallenge } from "../lib/auth";
import type { ReauthenticationGrant } from "../lib/mfa";

export function ReauthenticationDialog({ open, title, description, confirmLabel, onOpenChange, onVerified }: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onOpenChange: (open: boolean) => void;
  onVerified: (grant: ReauthenticationGrant) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [method, setMethod] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    setPassword(""); setChallenge(null); setMethod(""); setCode(""); setRecovery(false); setError("");
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (challenge && challenge.expires_at * 1000 <= Date.now()) {
      setChallenge(null); setCode(""); setError("Verification expired. Enter your password again."); return;
    }
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = challenge
        ? await api<ReauthenticationGrant>(recovery ? "/api/auth/mfa/recovery" : "/api/auth/mfa/verify", {
          method: "POST", token: challenge.challenge_token,
          body: recovery ? { recovery_code: code.trim() } : { method_id: method, code: code.trim() },
        })
        : await api<ReauthenticationGrant | MfaChallenge>("/api/auth/reauthenticate", {
          method: "POST", retryAuth: false, body: { password },
        });
      setPassword(""); setCode("");
      if ("next" in result) {
        setChallenge(result); setMethod(result.methods[0]?.id ?? ""); setRecovery(result.methods.length === 0);
      } else await onVerified(result);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 401
        ? challenge ? "Use a new code from your authenticator, or a valid recovery code. Codes can only be used once."
          : "Check your current password and try again."
        : errorMessage(failure));
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!inFlight.current) onOpenChange(next); }}>
    <DialogPopup>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
      <Form onSubmit={submit} className="account-dialog-form" aria-busy={busy}>
        <Fieldset.Root disabled={busy}>
          {!challenge ? <PasswordField id="otp-current-password" label="Current password" value={password} onChange={setPassword} autoComplete="current-password" /> : <>
            <p className="account-verification-hint">{recovery ? "Enter one of your saved recovery codes." : "Verify with an existing authenticator. Use a new code; each code can only be used once."}</p>
            {!recovery && challenge.methods.length > 1 && <Select.Root
              items={challenge.methods.map((item, index) => ({ value: item.id, label: item.name || `Authenticator app ${index + 1}` }))}
              value={method} onValueChange={(next) => { setMethod(next ?? ""); setCode(""); setError(""); }}>
              <Select.Label>Existing authenticator</Select.Label><Select.Trigger><Select.Value /></Select.Trigger>
              <SelectPopup><Select.List>{challenge.methods.map((item, index) => <Select.Item key={item.id} value={item.id}><Select.ItemText>{item.name || `Authenticator app ${index + 1}`}</Select.ItemText></Select.Item>)}</Select.List></SelectPopup>
            </Select.Root>}
            <TextField key={recovery ? "recovery" : "authenticator"} label={recovery ? "Recovery code" : "Authentication code"} name="verification_code"
              autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} pattern={recovery ? undefined : "[0-9]{6}"}
              maxLength={recovery ? 64 : 6} required value={code} onValueChange={setCode} />
            {challenge.methods.length > 0 && <Button type="button" variant="ghost" onClick={() => { setRecovery(!recovery); setCode(""); setError(""); }}>
              {recovery ? "Use an authenticator code" : "Use a recovery code"}
            </Button>}
          </>}
          {error && <p className="account-notice" data-error role="alert">{error}</p>}
          <div className="account-actions"><Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary">{busy ? "Verifying…" : challenge ? "Verify and continue" : confirmLabel}</Button></div>
        </Fieldset.Root>
      </Form>
    </DialogPopup>
  </Dialog.Root>;
}
