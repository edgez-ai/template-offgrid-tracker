import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";

/** Colour tokens from docs/ui-handoff/specs/DESIGN_TOKENS.json (2026.11.14). */
export const palettes = {
  light: {
    canvas: "#F5F5F7",
    card: "#FFFFFF",
    surface: "#EFEFF2",
    text: "#1D1D1F",
    secondary: "#6E6E73",
    separator: "#E2E2E7",
    accent: "#FF8500",
    online: "#1479D7",
    warning: "#A15C07",
    danger: "#C52A24",
    primary: "#1D1D1F",
    onPrimary: "#FFFFFF",
    bubbleMine: "#1D1D1F",
    onBubbleMine: "#FFFFFF",
    bubblePeer: "#FFFFFF",
  },
  dark: {
    canvas: "#000000",
    card: "#1C1C1E",
    surface: "#2C2C2E",
    text: "#F5F5F7",
    secondary: "#A1A1A6",
    separator: "#38383A",
    accent: "#FF9A33",
    online: "#64ADF3",
    warning: "#E0A458",
    danger: "#FF6961",
    primary: "#F5F5F7",
    onPrimary: "#000000",
    bubbleMine: "#F5F5F7",
    onBubbleMine: "#000000",
    bubblePeer: "#2C2C2E",
  },
} as const;

export type Palette = { [K in keyof typeof palettes.light]: string };
export type AppearancePreference = "system" | "light" | "dark";
export type ColorMode = "light" | "dark";

const appearanceStorageKey = "keepteen.appearance.v1";

type ThemeContextValue = {
  colors: Palette;
  mode: ColorMode;
  preference: AppearancePreference;
  setPreference: (preference: AppearancePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  colors: palettes.light,
  mode: "light",
  preference: "system",
  setPreference: () => undefined,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<AppearancePreference>("system");

  useEffect(() => {
    void AsyncStorage.getItem(appearanceStorageKey).then((stored) => {
      if (stored === "light" || stored === "dark" || stored === "system") setPreferenceState(stored);
    }).catch(() => undefined);
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const mode: ColorMode = preference === "system" ? (system === "dark" ? "dark" : "light") : preference;
    return {
      colors: palettes[mode],
      mode,
      preference,
      setPreference: (next) => {
        setPreferenceState(next);
        void AsyncStorage.setItem(appearanceStorageKey, next).catch(() => undefined);
      },
    };
  }, [preference, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
