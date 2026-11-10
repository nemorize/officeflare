export interface RegionalPreferences {
  time_zone: string;
  regional_format: string;
}

export const defaultRegionalPreferences: RegionalPreferences = {
  time_zone: "UTC",
  regional_format: "en",
};

export function canonicalTimeZone(value: string): string {
  if (/^[+-]/.test(value)) throw new RangeError();
  return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
}

export const canonicalRegionalFormat = (value: string): string =>
  Intl.getCanonicalLocales(value)[0]!;
