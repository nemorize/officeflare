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
      <Menu.GroupLabel>Appearance</Menu.GroupLabel>
      <Menu.RadioGroup
        aria-label="Appearance"
        value={preference}
        onValueChange={browserTheme.setPreference}
      >
        {(["system", "light", "dark"] as const).map((value) => (
          <Menu.RadioItem key={value} value={value}>
            <Icon name={preference === value ? "check" : "circle"} />
            {value === "system" ? "System" : value === "light" ? "Light" : "Dark"}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu.Group>
  );
}
