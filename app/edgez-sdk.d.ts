import "@edgez/react-native-sdk";

declare module "@edgez/react-native-sdk" {
  interface EdgezSensorData {
    mcuTemperature?: number;
  }
}
