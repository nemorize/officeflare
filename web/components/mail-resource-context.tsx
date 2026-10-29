import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { api } from "../lib/api";
import { hydrateMailResources } from "../lib/mail-ui";
import { MailResourceCache } from "../lib/mail-resource-cache";
import { useSession } from "../lib/session";
import { useAccess } from "./console-access";

const Context = createContext<MailResourceCache | null>(null);
export function MailResourceProvider({ children }: { children: ReactNode }) {
  const session = useSession().session?.tokens.session_id;
  const permissions = [...useAccess().permissions].sort().join("\n");
  const cache = useMemo(() => {
    const instance = new MailResourceCache(async (path, signal) => {
      const data = await api(path, {
        signal: /\/(?:render\/assets|attachments)\//.test(path)
          ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
          : signal,
        ...(/\/(?:render\/assets|attachments)\//.test(path) ? { response: "blob" as const } : {}),
      });
      if (!signal.aborted) hydrateMailResources(instance, path, data);
      return data;
    });
    return instance;
  }, [session, permissions]);
  useEffect(() => () => cache.clear(), [cache]);
  return <Context value={cache}>{children}</Context>;
}
export function useMailCache() {
  const cache = useContext(Context);
  if (!cache) throw new Error("Mail resource scope is unavailable");
  return cache;
}
