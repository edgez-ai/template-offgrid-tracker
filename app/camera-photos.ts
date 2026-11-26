import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import type { GatewayPicture } from './gateway-camera';

export async function saveCameraPicture(picture: GatewayPicture, endpoint: string): Promise<string> {
  if (Platform.OS !== 'android' || !NativeModules.WifiGateway?.savePicture) {
    throw new Error('Install the latest Android app to save pictures to Photos.');
  }
  if (Number(Platform.Version) < 29) {
    const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
    if (permission !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Storage permission is required to save this picture.');
  }
  const name = `EZ_${endpoint.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}_${Date.now()}.jpg`;
  const uri = picture.uri.startsWith('file://')
    ? `data:image/jpeg;base64,${await FileSystem.readAsStringAsync(picture.uri, { encoding: FileSystem.EncodingType.Base64 })}`
    : picture.uri;
  return NativeModules.WifiGateway.savePicture(uri, name);
}
