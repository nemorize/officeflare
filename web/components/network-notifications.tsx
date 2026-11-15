import { useEffect } from "react";
import { t } from "../../shared/i18n/index.ts";
import { Toast } from "./ui/styled-primitives";

export function NetworkNotifications() {
  const { add, close } = Toast.useToastManager();
  useEffect(() => {
    let online = navigator.onLine;
    let toast: string | undefined;
    const changed = () => {
      const next = navigator.onLine;
      if (next === online) return;
      online = next;
      if (toast) close(toast);
      toast = add({
        title: t(next ? "network.reconnected" : "network.disconnected"),
        type: "info",
        priority: "low",
        timeout: 5000,
      });
    };
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
      if (toast) close(toast);
    };
  }, [add, close]);
  return null;
}
