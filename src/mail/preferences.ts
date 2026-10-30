import { t } from "../../shared/i18n/index.ts";
import { fail } from "./types";
export const defaultMailPreferences = {
  density: "comfortable",
  conversation_view: true,
  reading_pane: "none",
  shortcuts: false,
  undo_seconds: 10,
  sidebar_collapsed: false,
};
export function mailPreferences(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, t("mailPreferences.invalidPreferences"));
  const data = value as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (!(key in defaultMailPreferences)) fail(400, t("mailPreferences.invalidPreference"));
    if (
      (key === "density" && !["comfortable", "compact"].includes(value as string)) ||
      (key === "reading_pane" && !["none", "right"].includes(value as string)) ||
      (key === "undo_seconds" && ![0, 5, 10, 20, 30].includes(value as number)) ||
      (["shortcuts", "conversation_view", "sidebar_collapsed"].includes(key) &&
        typeof value !== "boolean")
    )
      fail(400, t("mailPreferences.invalidField", { field: key }));
  }
  return {
    ...defaultMailPreferences,
    ...data,
  } as typeof defaultMailPreferences;
}
