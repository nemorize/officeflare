import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet } from "react-router";
import { Button } from "./ui";
import { api, errorMessage } from "../lib/api";
import { consoleMenu } from "../lib/console";
import { useSession } from "../lib/session";

interface Access { permissions: string[]; status: "loading" | "ready" | "error"; error: string; refresh: () => void; }
const AccessContext = createContext<Access>({ permissions: [], status: "loading", error: "", refresh: () => {} });
export const useAccess = () => useContext(AccessContext);

export function AccessProvider({ children }: { children: ReactNode }) {
  const auth = useSession(), sessionId = auth.session?.tokens.session_id;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<Access, "refresh"> & { sessionId?: string }>({ permissions: [], status: "loading", error: "" });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    if (!sessionId) return;
    void api<{ permissions: string[] }>("/api/me/permissions", { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setState({ sessionId, permissions: result.permissions, status: "ready", error: "" });
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setState({ sessionId, permissions: [], status: "error", error: errorMessage(failure) });
    });
    return () => controller.abort();
  }, [sessionId, revision]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const access = state.sessionId === sessionId ? state : { permissions: [], status: "loading" as const, error: "" };
  return <AccessContext value={{ ...access, refresh }}>{children}</AccessContext>;
}

export function AccessDenied() {
  return <section className="account-page"><header className="account-page-header"><h1>Access restricted</h1><p>You do not have permission to open this page.</p></header><Link to="/mail">Return to workspace</Link></section>;
}
export function ConsoleGate({ children, permissions }: { children?: ReactNode; permissions?: string[] }) {
  const access = useAccess();
  if (access.status === "loading") return <p className="account-page" role="status">Checking permissions…</p>;
  if (access.status === "error") return <section className="account-page"><p className="account-notice" role="alert">{access.error}</p><Button onClick={access.refresh}>Try again</Button></section>;
  const allowed = permissions ? permissions.some((permission) => access.permissions.includes(permission)) : consoleMenu(access.permissions).length > 0;
  return allowed ? children ?? <Outlet /> : <AccessDenied />;
}
export function ConsoleHome() {
  const menu = consoleMenu(useAccess().permissions);
  return menu[0] ? <Navigate to={menu[0].path} replace /> : <AccessDenied />;
}
