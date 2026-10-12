import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet } from "react-router";
import { api, errorMessage } from "../lib/api";
import { consoleMenu } from "../lib/console";
import { useSession } from "../lib/session";
import { LoadingSkeleton } from "./loading-skeleton";
import { workspaceApps } from "../lib/workspace-navigation";

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
  const lastForegroundRefresh = useRef(0);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastForegroundRefresh.current < 250) return;
      lastForegroundRefresh.current = Date.now(); refresh();
    };
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const access = state.sessionId === sessionId ? state : { permissions: [], status: "loading" as const, error: "" };
  return <AccessContext value={{ ...access, refresh }}>{children}</AccessContext>;
}

export function AccessDenied() {
  return <section className="account-page"><header className="account-page-header"><h1>Access restricted</h1><p>You do not have permission to open this page.</p></header><Link to="/">Return to workspace</Link></section>;
}
export function ConsoleGate({ children, permissions }: { children?: ReactNode; permissions?: string[] }) {
  const access = useAccess();
  if (access.status === "loading") return <LoadingSkeleton kind="page" label="Checking permissions…" />;
  if (access.status === "error") return <section className="account-page"><p className="account-notice" role="alert">{access.error}</p></section>;
  const allowed = access.permissions.includes("console.access") && (!permissions || permissions.some((permission) => access.permissions.includes(permission)));
  return allowed ? children ?? <Outlet /> : <AccessDenied />;
}
export function ConsoleHome() {
  const menu = consoleMenu(useAccess().permissions);
  return menu[0] ? <Navigate to={menu[0].path} replace /> : <section className="account-page"><header className="account-page-header"><h1>Console</h1><p>Your account can access Console. User and role management require additional permissions.</p></header></section>;
}
export function ServiceGate({ permission, children }: { permission: string; children: ReactNode }) {
  const access = useAccess();
  if (access.status === "loading") return <LoadingSkeleton kind="page" label="Checking permissions…" />;
  if (access.status === "error") return <section className="account-page"><p className="account-notice" role="alert">{access.error}</p></section>;
  return access.permissions.includes(permission) ? children : <AccessDenied />;
}
export function WorkspaceHome() {
  const access = useAccess();
  if (access.status !== "ready") return <p className="account-page" role="status">{access.error || "Checking permissions…"}</p>;
  const app = workspaceApps.find((item) => access.permissions.includes(item.permission));
  return <Navigate to={app?.path ?? (access.permissions.includes("console.access") ? "/console" : "/profile")} replace />;
}
