import { StrictMode } from "react";
import { UIProvider } from "./components/ui";
import { WorkspaceLoading } from "./components/workspace-loading";
import { root } from "./lib/app-root";
import "./lib/browser-theme";
import { browserLanguage } from "./lib/browser-language";
import { sessions } from "./lib/session";
import "./styles.css";

root.render(
  <StrictMode>
    <UIProvider>
      <WorkspaceLoading />
    </UIProvider>
  </StrictMode>,
);

// Resolve the account preference before modules capture navigation/editor labels.
sessions.start();
await sessions.restore();
sessions.subscribe(() => {
  if (sessions.getSnapshot().status === "signed_out") browserLanguage.setPreference("system");
});
await import("./app");
browserLanguage.start();
