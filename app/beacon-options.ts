export const beaconIconTypes = ["person", "hiker", "explorer", "dog", "sheep", "cow", "horse"] as const;
export type BeaconIconType = typeof beaconIconTypes[number];

export const beaconIconColors = ["blue", "green", "cyan", "orange", "red", "purple", "yellow"] as const;
export type BeaconIconColor = typeof beaconIconColors[number];

export const beaconColorValues: Record<BeaconIconColor, string> = {
  blue: "#60A5FA",
  green: "#4ADE80",
  cyan: "#22D3EE",
  orange: "#FB923C",
  red: "#F87171",
  purple: "#C084FC",
  yellow: "#FACC15",
};

export const beaconIconNames = {
  person: "account",
  hiker: "hiking",
  explorer: "compass-rose",
  dog: "dog",
  sheep: "sheep",
  cow: "cow",
  horse: "horse",
} as const;

export const beaconIconLabels: Record<BeaconIconType, string> = {
  person: "Person",
  hiker: "Hiker",
  explorer: "Explorer",
  dog: "Dog",
  sheep: "Sheep",
  cow: "Cow",
  horse: "Horse",
};

export function beaconDeviceType(_iconType: BeaconIconType): string {
  // Visual identity styles are all user identities in the current wire contract.
  return "user";
}
