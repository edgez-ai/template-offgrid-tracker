import React, { useEffect, useRef, useState } from 'react';
import { findNodeHandle, Image, Modal, NativeModules, StyleSheet, View } from 'react-native';
import { createPictureGesture, type PictureTransform } from '../camera-picture-gesture';
import { useI18n } from './i18n';

export function CameraPictureViewer({ uri, onClose }: { uri: string; onClose: () => void }) {
  const { t } = useI18n();
  const root = useRef<View>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => () => { NativeModules.WifiGateway?.setCameraFullscreen?.(false, 0); }, []);
  const enterFullscreen = () => NativeModules.WifiGateway?.setCameraFullscreen?.(true, findNodeHandle(root.current) || 0);
  const [transform, setTransform] = useState<PictureTransform>({ scale: 1, x: 0, y: 0 });
  const size = useRef({ width: 0, height: 0 });
  const gesture = useRef<ReturnType<typeof createPictureGesture> | null>(null);
  if (!gesture.current) gesture.current = createPictureGesture(() => size.current, setTransform, () => close.current());
  return <Modal visible animationType="fade" presentationStyle="fullScreen" statusBarTranslucent navigationBarTranslucent supportedOrientations={['landscape', 'landscape-left', 'landscape-right']} onShow={enterFullscreen} onRequestClose={onClose}>
    <View ref={root} collapsable={false} style={styles.screen} onLayout={event => {
      size.current = event.nativeEvent.layout;
      gesture.current!.layout();
    }} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
      onTouchStart={event => gesture.current!.start(event.nativeEvent.touches)}
      onTouchMove={event => gesture.current!.move(event.nativeEvent.touches)}
      onTouchEnd={event => gesture.current!.end(event.nativeEvent.touches)}
      onTouchCancel={() => gesture.current!.cancel()} accessibilityLabel={t('cameraPictureGestures')} accessibilityActions={[{ name: 'escape', label: t('cameraClosePicture') }]} onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'escape') onClose(); }}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}><Image source={{ uri }} resizeMode="contain" accessibilityLabel={t('cameraLatestPicture')} style={[StyleSheet.absoluteFill, { transform: [{ translateX: transform.x }, { translateY: transform.y }, { scale: transform.scale }] }]} /></View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
});
