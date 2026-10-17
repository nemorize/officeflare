export const colorThemeStorageKey = "officeflare.color-theme";
export type ColorTheme = "system" | "light" | "dark";
export type ColorScheme = "light" | "dark";

export function colorTheme(value: unknown): ColorTheme {
  return value === "light" || value === "dark" ? value : "system";
}

interface ThemeEnvironment {
  read: () => string | null;
  write: (value: ColorTheme) => void;
  systemDark: () => boolean;
  apply: (scheme: ColorScheme) => void;
  onSystemChange: (listener: () => void) => () => void;
  onStorageChange: (listener: () => void) => () => void;
}

export function createColorThemeStore(environment: ThemeEnvironment) {
  const read = () => {
    try { return colorTheme(environment.read()); }
    catch { return "system" as const; }
  };
  let preference = read();
  const listeners = new Set<() => void>();
  const apply = () => environment.apply(preference === "system" ? environment.systemDark() ? "dark" : "light" : preference);
  const notify = () => { for (const listener of listeners) listener(); };
  const stopSystem = environment.onSystemChange(() => {
    if (preference === "system") apply();
  });
  const stopStorage = environment.onStorageChange(() => {
    preference = read();
    apply();
    notify();
  });
  apply();
  return {
    getSnapshot: () => preference,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setPreference: (value: unknown) => {
      preference = colorTheme(value);
      try { environment.write(preference); }
      catch { /* The current tab can still change theme when storage is blocked. */ }
      apply();
      notify();
    },
    dispose: () => { stopSystem(); stopStorage(); listeners.clear(); },
  };
}
