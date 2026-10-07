import { useMemo, type ReactNode } from "react";
import { Toast } from "./styled-primitives";
import { Button } from "./button";
import { Icon } from "./icon";
import "./notifications.css";

export function useNotifications() {
  const { add } = Toast.useToastManager();
  return useMemo(() => {
    const notify = (type: "success" | "error" | "info", message: string) => add({
      id: `${type}:${message}`, title: message, type,
      priority: type === "error" ? "high" : "low",
      timeout: type === "error" ? 8000 : 5000,
    });
    return {
      success: (message: string) => notify("success", message),
      error: (message: string) => notify("error", message),
      info: (message: string) => notify("info", message),
    };
  }, [add]);
}

function Notifications() {
  const { toasts } = Toast.useToastManager();
  return <Toast.Portal>
    <Toast.Viewport className="app-notifications">
      {toasts.map((toast) => <Toast.Root key={toast.id} toast={toast} className="app-notification" swipeDirection="right">
        <Toast.Content className="app-notification-content">
          <Icon name={toast.type === "success" ? "check" : "info"} className="app-notification-icon" />
          <Toast.Title />
          <Toast.Close render={<Button variant="ghost" size="sm" />} aria-label="Dismiss notification" aria-hidden={false}><Icon name="close" /></Toast.Close>
        </Toast.Content>
      </Toast.Root>)}
    </Toast.Viewport>
  </Toast.Portal>;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  return <Toast.Provider limit={3}>{children}<Notifications /></Toast.Provider>;
}
