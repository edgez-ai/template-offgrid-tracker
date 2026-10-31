import "@edgez/react-native-sdk";

declare module "@edgez/react-native-sdk" {
  interface EdgezSensorData {
    batteryVoltage?: number;
    mcuTemperature?: number;
  }
}
