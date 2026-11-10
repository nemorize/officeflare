import { useContext } from "react";
import { t } from "../../shared/i18n/index.ts";
import { PushContext as Context } from "./push-context";
import { Button } from "./ui";

export function PushNotificationSettings() {
  const state = useContext(Context);
  return (
    <section className="account-panel">
      <div className="account-panel-header">
        <h2>{t("push.title")}</h2>
        <p>{t("push.description")}</p>
      </div>
      <p role="status">
        {!state?.loaded
          ? t("common.loading")
          : !state.supported
            ? t("push.unsupported")
            : !state.available
              ? t("push.unavailable")
              : state.denied
                ? t("push.denied")
                : state.enabled
                  ? t("push.enabled")
                  : t("push.disabled")}
      </p>
      {state?.error && (
        <p className="account-notice" role="alert">
          {state.error}
        </p>
      )}
      {state?.loaded && state.supported && state.available && (
        <div className="account-actions">
          <Button
            variant={state.enabled ? "secondary" : "primary"}
            disabled={state.busy || (!state.enabled && state.denied)}
            onClick={() => void (state.enabled ? state.disable() : state.enable())}
          >
            {state.busy
              ? t("common.loading")
              : state.enabled
                ? t("push.disable")
                : t("push.enable")}
          </Button>
        </div>
      )}
    </section>
  );
}
