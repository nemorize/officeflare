import { StrictMode } from "react";
import { UIProvider } from "./components/ui";
import { WorkspaceLoading } from "./components/workspace-loading";
import { ApplicationErrorBoundary, ApplicationErrorPage } from "./components/application-error";
import { root } from "./lib/app-root";
import "./lib/browser-theme";
import { browserLanguage } from "./lib/browser-language";
import { setRegionalPreferences } from "./lib/regional";
import { sessions } from "./lib/session";
import "./styles.css";

root.render(
  <StrictMode>
    <ApplicationErrorBoundary>
      <UIProvider>
        <WorkspaceLoading />
      </UIProvider>
    </ApplicationErrorBoundary>
  </StrictMode>,
);

// Resolve the account preference before modules capture navigation/editor labels.
sessions.start();
await sessions.restore();
sessions.subscribe(() => {
  if (sessions.getSnapshot().status === "signed_out") {
    setRegionalPreferences(null);
    browserLanguage.setPreference("system");
  }
});
try {
  await import("./app");
} catch (error) {
  console.error("Application startup failed", error);
  root.render(<ApplicationErrorPage error={error} />);
}
browserLanguage.start();
