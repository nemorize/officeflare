import { t } from "../shared/i18n/index.ts";
import "./lib/browser-theme";
import { browserLanguage } from "./lib/browser-language";
import { sessions } from "./lib/session";
import "./styles.css";

const placeholder = document.createElement("p");
placeholder.className = "empty-page";
placeholder.setAttribute("role", "status");
placeholder.textContent = t("common.loading");
document.getElementById("root")!.append(placeholder);

// Resolve the account preference before modules capture navigation/editor labels.
await sessions.restore();
sessions.subscribe(() => {
  if (sessions.getSnapshot().status === "signed_out") browserLanguage.setPreference("system");
});
await import("./app");
browserLanguage.start();
