import * as Location from "expo-location";
import { NativeModules, Platform } from "react-native";

export type AppCoordinates = { latitude: number; longitude: number };

type NativeLocationResult = AppCoordinates & {
  accuracy: number;
  timestamp: number;
};

type NativeLocationModule = {
  getCurrentLocation(timeoutMs: number): Promise<NativeLocationResult>;
};

const nativeLocation = NativeModules.NativeLocation as NativeLocationModule | undefined;

function coordinates(position: Location.LocationObject): AppCoordinates {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  };
}

export async function compatibleCurrentLocation(): Promise<AppCoordinates> {
  if (Platform.OS === "android") {
    if (!nativeLocation?.getCurrentLocation) {
      throw new Error("Native Android location support is unavailable");
    }
    const result = await nativeLocation.getCurrentLocation(20_000);
    return { latitude: result.latitude, longitude: result.longitude };
  }

  const lastKnown = await Location.getLastKnownPositionAsync({ maxAge: 15 * 60_000 });
  if (lastKnown) return coordinates(lastKnown);

  return new Promise<AppCoordinates>((resolve, reject) => {
    let subscription: Location.LocationSubscription | undefined;
    let finished = false;
    const finish = (result?: AppCoordinates, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription?.remove();
      if (result) resolve(result);
      else reject(error ?? new Error("No location fix is available"));
    };
    const timer = setTimeout(() => finish(undefined, new Error("Timed out waiting for a location fix")), 15_000);

    void Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Low,
        mayShowUserSettingsDialog: false,
        timeInterval: 1_000,
        distanceInterval: 0,
      },
      (position) => finish(coordinates(position)),
    ).then((value) => {
      subscription = value;
      if (finished) subscription.remove();
    }).catch(() => finish(undefined, new Error("No location fix is available")));
  });
}
