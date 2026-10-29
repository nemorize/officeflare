import { useSyncExternalStore } from "react";

export const workspaceMobileQuery = "(max-width: 760px)";
function subscribe(listener: () => void) {
  const query = window.matchMedia(workspaceMobileQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
export function useWorkspaceMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(workspaceMobileQuery).matches,
    () => false,
  );
}
