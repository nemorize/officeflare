import { colorThemeStorageKey, createColorThemeStore } from "./color-theme";

const system = window.matchMedia("(prefers-color-scheme: dark)");
export const browserTheme = createColorThemeStore({
  read: () => localStorage.getItem(colorThemeStorageKey),
  write: (value) => localStorage.setItem(colorThemeStorageKey, value),
  systemDark: () => system.matches,
  apply: (scheme) => {
    document.documentElement.dataset.colorScheme = scheme;
    document.documentElement.style.colorScheme = `only ${scheme}`;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", scheme);
  },
  onSystemChange: (listener) => {
    system.addEventListener("change", listener);
    return () => system.removeEventListener("change", listener);
  },
  onStorageChange: (listener) => {
    const change = (event: StorageEvent) => {
      if (event.key === colorThemeStorageKey || event.key === null) listener();
    };
    window.addEventListener("storage", change);
    return () => window.removeEventListener("storage", change);
  },
});

if (import.meta.hot) import.meta.hot.dispose(() => browserTheme.dispose());
