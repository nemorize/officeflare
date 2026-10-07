import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type AccountUser } from "../lib/api";
import { useSession } from "../lib/session";

const AccountContext = createContext<{ user: AccountUser | null; imageUrl: string | null; reload: () => Promise<void>; update: (user: AccountUser) => void }>({ user: null, imageUrl: null, reload: async () => {}, update: () => {} });
export const useAccount = () => useContext(AccountContext);

export function AccountProvider({ children }: { children: ReactNode }) {
  const auth = useSession();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const sessionId = auth.session?.tokens.session_id;
  const reload = useCallback(async () => {
    const result = await api<{ user: AccountUser }>("/api/me");
    setUser(result.user);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setUser(null);
    void api<{ user: AccountUser }>("/api/me", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setUser(result.user); })
      .catch(() => { /* Account pages show request errors; navigation can use the restored email. */ });
    return () => controller.abort();
  }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    setImageUrl(null);
    if (user?.profile_image_key) void api<Blob>("/api/me/profile-image", { response: "blob", signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob); setImageUrl(url);
      }).catch(() => { /* Initials remain visible if the photo cannot be loaded. */ });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [user?.id, user?.profile_image_key]);
  return <AccountContext value={{ user, imageUrl, reload, update: setUser }}>{children}</AccountContext>;
}
