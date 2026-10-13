// Channels from the Morse Micro mmregdb used by the device firmware.
// Keep this list aligned with the firmware regulatory database.
export type HalowChannel = { number: number; frequencyMHz: number; bandwidthMHz?: number };
export const halowCountries: { code: string; name: string; channels: HalowChannel[] }[] = [
  { code: "AU", name: "Australia", channels: [{ number: 27, frequencyMHz: 915.5 }, { number: 29, frequencyMHz: 916.5 }, { number: 31, frequencyMHz: 917.5 }, { number: 33, frequencyMHz: 918.5 }, { number: 35, frequencyMHz: 919.5 }, { number: 37, frequencyMHz: 920.5 }, { number: 39, frequencyMHz: 921.5 }, { number: 41, frequencyMHz: 922.5 }, { number: 43, frequencyMHz: 923.5 }, { number: 45, frequencyMHz: 924.5 }, { number: 47, frequencyMHz: 925.5 }, { number: 49, frequencyMHz: 926.5 }, { number: 51, frequencyMHz: 927.5 }] },
  { code: "CA", name: "Canada", channels: [{ number: 1, frequencyMHz: 902.5 }, { number: 3, frequencyMHz: 903.5 }, { number: 5, frequencyMHz: 904.5 }, { number: 7, frequencyMHz: 905.5 }, { number: 9, frequencyMHz: 906.5 }, { number: 11, frequencyMHz: 907.5 }, { number: 13, frequencyMHz: 908.5 }, { number: 15, frequencyMHz: 909.5 }, { number: 17, frequencyMHz: 910.5 }, { number: 19, frequencyMHz: 911.5 }, { number: 21, frequencyMHz: 912.5 }, { number: 23, frequencyMHz: 913.5 }, { number: 25, frequencyMHz: 914.5 }, { number: 27, frequencyMHz: 915.5 }, { number: 29, frequencyMHz: 916.5 }, { number: 31, frequencyMHz: 917.5 }, { number: 33, frequencyMHz: 918.5 }, { number: 35, frequencyMHz: 919.5 }, { number: 37, frequencyMHz: 920.5 }, { number: 39, frequencyMHz: 921.5 }, { number: 41, frequencyMHz: 922.5 }, { number: 43, frequencyMHz: 923.5 }, { number: 45, frequencyMHz: 924.5 }, { number: 47, frequencyMHz: 925.5 }, { number: 49, frequencyMHz: 926.5 }, { number: 51, frequencyMHz: 927.5 }] },
  { code: "EU", name: "European Union", channels: [{ number: 1, frequencyMHz: 863.5 }, { number: 3, frequencyMHz: 864.5 }, { number: 5, frequencyMHz: 865.5 }, { number: 7, frequencyMHz: 866.5 }, { number: 9, frequencyMHz: 867.5 }] },
  { code: "GB", name: "United Kingdom", channels: [{ number: 1, frequencyMHz: 863.5 }, { number: 3, frequencyMHz: 864.5 }, { number: 5, frequencyMHz: 865.5 }, { number: 7, frequencyMHz: 866.5 }, { number: 9, frequencyMHz: 867.5 }, { number: 33, frequencyMHz: 917.9 }, { number: 35, frequencyMHz: 918.9 }] },
  { code: "IN", name: "India", channels: [{ number: 5, frequencyMHz: 865.5 }, { number: 7, frequencyMHz: 866.5 }, { number: 9, frequencyMHz: 867.5 }] },
  { code: "JP", name: "Japan", channels: [{ number: 9, frequencyMHz: 921 }, { number: 13, frequencyMHz: 923 }, { number: 15, frequencyMHz: 924 }, { number: 17, frequencyMHz: 925 }, { number: 19, frequencyMHz: 926 }, { number: 21, frequencyMHz: 927 }] },
  { code: "KR", name: "South Korea", channels: [{ number: 1, frequencyMHz: 918 }, { number: 3, frequencyMHz: 919 }, { number: 5, frequencyMHz: 920 }, { number: 7, frequencyMHz: 921 }, { number: 9, frequencyMHz: 922 }, { number: 11, frequencyMHz: 923 }, { number: 18, frequencyMHz: 926.5 }, { number: 20, frequencyMHz: 927.5 }, { number: 22, frequencyMHz: 928.5 }, { number: 24, frequencyMHz: 929.5 }] },
  { code: "NZ", name: "New Zealand", channels: [{ number: 27, frequencyMHz: 915.5 }, { number: 29, frequencyMHz: 916.5 }, { number: 31, frequencyMHz: 917.5 }, { number: 33, frequencyMHz: 918.5 }, { number: 35, frequencyMHz: 919.5 }, { number: 37, frequencyMHz: 920.5 }, { number: 39, frequencyMHz: 921.5 }, { number: 41, frequencyMHz: 922.5 }, { number: 43, frequencyMHz: 923.5 }, { number: 45, frequencyMHz: 924.5 }, { number: 47, frequencyMHz: 925.5 }, { number: 49, frequencyMHz: 926.5 }, { number: 51, frequencyMHz: 927.5 }] },
  { code: "US", name: "United States", channels: [
    { number: 1, frequencyMHz: 902.5 }, { number: 2, frequencyMHz: 903, bandwidthMHz: 2 },
    { number: 3, frequencyMHz: 903.5 }, { number: 5, frequencyMHz: 904.5 },
    { number: 6, frequencyMHz: 905, bandwidthMHz: 2 }, { number: 7, frequencyMHz: 905.5 },
    { number: 8, frequencyMHz: 906, bandwidthMHz: 4 }, { number: 9, frequencyMHz: 906.5 },
    { number: 10, frequencyMHz: 907, bandwidthMHz: 2 }, { number: 11, frequencyMHz: 907.5 },
    { number: 12, frequencyMHz: 908, bandwidthMHz: 8 }, { number: 13, frequencyMHz: 908.5 },
    { number: 14, frequencyMHz: 909, bandwidthMHz: 2 }, { number: 15, frequencyMHz: 909.5 },
    { number: 16, frequencyMHz: 910, bandwidthMHz: 4 }, { number: 17, frequencyMHz: 910.5 },
    { number: 18, frequencyMHz: 911, bandwidthMHz: 2 }, { number: 19, frequencyMHz: 911.5 },
    { number: 21, frequencyMHz: 912.5 }, { number: 22, frequencyMHz: 913, bandwidthMHz: 2 },
    { number: 23, frequencyMHz: 913.5 }, { number: 24, frequencyMHz: 914, bandwidthMHz: 4 },
    { number: 25, frequencyMHz: 914.5 }, { number: 26, frequencyMHz: 915, bandwidthMHz: 2 },
    { number: 27, frequencyMHz: 915.5 }, { number: 28, frequencyMHz: 916, bandwidthMHz: 8 },
    { number: 29, frequencyMHz: 916.5 }, { number: 30, frequencyMHz: 917, bandwidthMHz: 2 },
    { number: 31, frequencyMHz: 917.5 }, { number: 32, frequencyMHz: 918, bandwidthMHz: 4 },
    { number: 33, frequencyMHz: 918.5 }, { number: 34, frequencyMHz: 919, bandwidthMHz: 2 },
    { number: 35, frequencyMHz: 919.5 }, { number: 37, frequencyMHz: 920.5 },
    { number: 38, frequencyMHz: 921, bandwidthMHz: 2 }, { number: 39, frequencyMHz: 921.5 },
    { number: 40, frequencyMHz: 922, bandwidthMHz: 4 }, { number: 41, frequencyMHz: 922.5 },
    { number: 42, frequencyMHz: 923, bandwidthMHz: 2 }, { number: 43, frequencyMHz: 923.5 },
    { number: 44, frequencyMHz: 924, bandwidthMHz: 8 }, { number: 45, frequencyMHz: 924.5 },
    { number: 46, frequencyMHz: 925, bandwidthMHz: 2 }, { number: 47, frequencyMHz: 925.5 },
    { number: 48, frequencyMHz: 926, bandwidthMHz: 4 }, { number: 49, frequencyMHz: 926.5 },
    { number: 50, frequencyMHz: 927, bandwidthMHz: 2 }, { number: 51, frequencyMHz: 927.5 },
  ] },
];

export function bandwidthForChannel(channel: HalowChannel): number {
  return channel.bandwidthMHz ?? 1;
}

export function channelsForCountry(code: string): HalowChannel[] {
  return halowCountries.find((country) => country.code === code)?.channels ?? [];
}

export function bandwidthsForCountry(code: string): number[] {
  return [...new Set(channelsForCountry(code).map(bandwidthForChannel))].sort((a, b) => a - b);
}

export function centerChannelForCountry(code: string): HalowChannel | undefined {
  const channels = channelsForCountry(code);
  if (!channels.length) return undefined;
  const midpoint = (channels[0].frequencyMHz + channels[channels.length - 1].frequencyMHz) / 2;
  return channels.reduce((closest, channel) =>
    Math.abs(channel.frequencyMHz - midpoint) < Math.abs(closest.frequencyMHz - midpoint) ? channel : closest, channels[0]);
}
