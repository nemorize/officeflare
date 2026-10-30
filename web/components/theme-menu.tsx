import { t } from "../../shared/i18n/index.ts";
import { useSyncExternalStore } from "react";
import { browserTheme } from "../lib/browser-theme";
import { Icon, Menu } from "./ui";

export function ThemeMenu() {
  const preference = useSyncExternalStore(
    browserTheme.subscribe,
    browserTheme.getSnapshot,
    () => "system",
  );
  return (
    <Menu.Group>
      <Menu.GroupLabel>{t("componentsThemeMenu.appearance")}</Menu.GroupLabel>
      <Menu.RadioGroup
        aria-label={t("componentsThemeMenu.appearance")}
        value={preference}
        onValueChange={browserTheme.setPreference}
      >
        {(["system", "light", "dark"] as const).map((value) => (
          <Menu.RadioItem key={value} value={value}>
            <Icon name={preference === value ? "check" : "circle"} />
            {value === "system"
              ? t("componentsThemeMenu.system")
              : value === "light"
                ? t("componentsThemeMenu.light")
                : t("componentsThemeMenu.dark")}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu.Group>
  );
}
