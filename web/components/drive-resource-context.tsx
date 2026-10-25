import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { CalendarResourceCache } from "../lib/calendar-resource-cache";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { useAccess } from "./console-access";

export const createDriveCache = () => new CalendarResourceCache<unknown>((path, signal) => api(path, { signal }), Date.now, 30_000, 48);
const Context = createContext<ReturnType<typeof createDriveCache> | null>(null);
export function DriveResourceProvider({ children }: { children: ReactNode }) {
  const session = useSession().session?.tokens.session_id, permissions = [...useAccess().permissions].sort().join("\n");
  const cache = useMemo(createDriveCache, [session, permissions]);
  useEffect(() => () => cache.clear(), [cache]);
  return <Context value={cache}>{children}</Context>;
}
export const useSharedDriveCache = () => useContext(Context);
