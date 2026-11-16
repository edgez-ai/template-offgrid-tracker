import type { ImageSourcePropType } from "react-native";
import type { ColorMode } from "./theme";

/**
 * Transparent product and brand artwork exported from the KEEPTEEN UI handoff
 * (docs/ui-handoff/assets/{products,brand}/png). React Native picks @2x/@3x
 * automatically from the file names.
 */
const art = {
  light: {
    collar: require("../assets/keepteen/light/collar.png"),
    chat: require("../assets/keepteen/light/chat.png"),
    valve: require("../assets/keepteen/light/water_valve.png"),
    camera: require("../assets/keepteen/light/camera.png"),
    keepteen: require("../assets/keepteen/light/keepteen_logo.png"),
    edgez: require("../assets/keepteen/light/edgez_logo.png"),
  },
  dark: {
    collar: require("../assets/keepteen/dark/collar.png"),
    chat: require("../assets/keepteen/dark/chat.png"),
    valve: require("../assets/keepteen/dark/water_valve.png"),
    camera: require("../assets/keepteen/dark/camera.png"),
    keepteen: require("../assets/keepteen/dark/keepteen_logo.png"),
    edgez: require("../assets/keepteen/dark/edgez_logo.png"),
  },
} satisfies Record<ColorMode, Record<string, ImageSourcePropType>>;

export type ArtworkKey = keyof typeof art.light;

export function artwork(mode: ColorMode, key: ArtworkKey): ImageSourcePropType {
  return art[mode][key];
}
