import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogPopup, Button, Icon, useNotifications } from "@/components/ui";
import { api, errorMessage } from "../lib/api";
import { sessions } from "../lib/session";

interface AccountSession {
  id: string; current: boolean; created_at: number; last_used_at: number; expires_at: number; user_agent: string | null;
}
const date = (timestamp: number) => new Date(timestamp * 1000).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
function device(agent: string | null) {
  if (!agent) return "Browser session";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const system = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Windows/.test(agent) ? "Windows" : /Mac/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "another device";
  return `${browser} on ${system}`;
}

export function SessionsPage() {
  const notify = useNotifications();
  const [items, setItems] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<AccountSession | "all" | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void api<{ sessions: AccountSession[] }>("/api/me/sessions", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setItems(result.sessions); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function revoke() {
    if (!target || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      await api(target === "all" ? "/api/me/sessions" : `/api/me/sessions/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      if (target === "all") { notify.success("All sessions have been signed out."); await sessions.restore(); }
      else {
        setItems((current) => current.filter((item) => item.id !== target.id));
        notify.success("The session has been signed out.");
      }
      setTarget(null);
    } catch (failure) { notify.error(errorMessage(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="account-page">
    <header className="account-page-header"><h1>Sessions</h1><p>Review the devices signed in to your account.</p></header>
    <section className="account-panel">
      <div className="account-panel-header"><h2>Active sessions</h2><p>Sign out a session you no longer use or do not recognize.</p></div>
      {loading ? <p className="account-loading" role="status">Loading sessions…</p> : <>
        {error ? <p className="account-notice" data-error role="alert">{error}</p> : <div className="account-session-list">
          {items.map((item) => <div className="account-session" key={item.id}>
            <span className="account-session-icon"><Icon name="laptop" width="19" height="19" /></span>
            <div className="account-session-details"><div className="account-session-title"><h3>{device(item.user_agent)}</h3>{item.current && <span className="account-session-badge">This device</span>}</div>
              <p>Signed in {date(item.created_at)}</p><p>Last active {date(item.last_used_at)}</p><p>Expires {date(item.expires_at)}</p></div>
            {!item.current && <Button size="sm" disabled={busy} onClick={() => setTarget(item)}>Sign out</Button>}
          </div>)}
          {!items.length && <p className="account-loading">No active sessions.</p>}
        </div>}
      </>}
    </section>
    <section className="account-panel account-danger-panel"><div><h2>Sign out everywhere</h2><p>End all sessions, including this device.</p></div>
      <Button variant="danger" disabled={busy} onClick={() => setTarget("all")}>Sign out everywhere</Button></section>
    <AlertDialog.Root open={target !== null} onOpenChange={(open) => { if (!open && !inFlight.current) setTarget(null); }}>
      <AlertDialogPopup>
        <AlertDialog.Title>{target === "all" ? "Sign out everywhere?" : "Sign out this session?"}</AlertDialog.Title>
        <AlertDialog.Description>{target === "all" ? "You will need to sign in again on every device, including this one." : "The selected device will need to sign in again."}</AlertDialog.Description>
        <div className="account-actions"><Button disabled={busy} onClick={() => setTarget(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => { void revoke(); }}>{busy ? "Signing out…" : "Sign out"}</Button></div>
      </AlertDialogPopup>
    </AlertDialog.Root>
  </section>;
}
