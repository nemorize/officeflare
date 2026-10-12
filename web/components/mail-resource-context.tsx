import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { api } from "../lib/api";
import { MailResourceCache } from "../lib/mail-resource-cache";
import { useSession } from "../lib/session";
import { useAccess } from "./console-access";

const Context = createContext<MailResourceCache | null>(null);
export function MailResourceProvider({ children }: { children: ReactNode }) {
  const session = useSession().session?.tokens.session_id;
  const permissions = [...useAccess().permissions].sort().join("\n");
  const cache = useMemo(() => new MailResourceCache((path, signal) => api(path, { signal })), [session, permissions]);
  useEffect(() => () => cache.clear(), [cache]);
  return <Context value={cache}>{children}</Context>;
}
export function useMailCache() {
  const cache = useContext(Context);
  if (!cache) throw new Error("Mail resource scope is unavailable");
  return cache;
}
