import { isMessageKey, t, type StaticMessageKey } from "./index.ts";

type LabelKey = Extract<StaticMessageKey, `labels.${string}`>;
const isLabelKey = (key: string): key is LabelKey => key.startsWith("labels.") && isMessageKey(key);

/** Protocol values stay stable; only their presentation is translated. */
export function enumLabel(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const key = `labels.${value}`;
  return isLabelKey(key) ? t(key) : value;
}
