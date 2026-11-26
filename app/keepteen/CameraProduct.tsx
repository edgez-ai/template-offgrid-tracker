import React, { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { CAMERA_RESOLUTIONS, readCameraResolution, changeCameraResolution, captureGatewayPicture, type CameraResolution, type GatewayPicture } from '../gateway-camera';
import { deleteCameraPicture, listCameraPictures, storeCameraPicture, type GalleryPicture } from '../camera-gallery';
import { saveCameraPicture } from '../camera-photos';
import type { GatewayClient } from '../gateway-lwm2m';
import { CameraPictureViewer } from './CameraPictureViewer';
import { useI18n } from './i18n';
import { useTheme } from './theme';
import { Button, Card, ListRow, NavHeader, Notice, PageScroll, Screen } from './ui';

export function CameraProduct({ cameras, onClose }: { cameras: GatewayClient[]; onClose: () => void }) {
  const { t } = useI18n();
  return <Screen>
    <NavHeader title={t('productCamera')} onBack={onClose} />
    <PageScroll>
      {cameras.map((camera) => <CameraCard key={camera.endpoint} camera={camera} />)}
      {!cameras.length ? <Notice text={t('noCameraConnected')} /> : null}
    </PageScroll>
  </Screen>;
}

function CameraCard({ camera }: { camera: GatewayClient }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const [picture, setPicture] = useState<GatewayPicture | null>(null);
  const [phase, setPhase] = useState<'capture' | 'download' | null>(null);
  const [error, setError] = useState('');
  const [resolution, setResolution] = useState<CameraResolution | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryPicture[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteInProgress = useRef(false);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [savedUri, setSavedUri] = useState('');
  const saveInProgress = useRef(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void updateResolution();
    void listCameraPictures(camera.endpoint).then(photos => {
      if (mounted.current) { setGallery(current => [...current, ...photos.filter(photo => !current.some(existing => existing.uri === photo.uri))]); setPicture(value => value || photos[0] || null); }
    }).catch(caught => { if (mounted.current) setError(caught instanceof Error ? caught.message : t('cameraGalleryFailed')); });
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  const updateResolution = async (next?: CameraResolution) => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setResolutionOpen(false); setSettingsBusy(true); setError('');
    try {
      const value = next ? await changeCameraResolution(camera.endpoint, next, controller.signal)
        : await readCameraResolution(camera.endpoint, controller.signal);
      if (mounted.current && !controller.signal.aborted) setResolution(value);
    } catch (caught) {
      if (mounted.current && !controller.signal.aborted) {
        setResolution(null);
        setError(caught instanceof Error ? caught.message : t('cameraResolutionFailed'));
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current) setSettingsBusy(false);
    }
  };
  const savePicture = async () => {
    if (!picture || saveInProgress.current || savedUri) return;
    saveInProgress.current = true; setSaving(true); setError('');
    try {
      const uri = await saveCameraPicture(picture, camera.endpoint);
      if (mounted.current) setSavedUri(uri);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : t('cameraSaveFailed'));
    } finally {
      saveInProgress.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const deleteSelectedPhoto = async () => {
    if (!selectedPhoto || deleteInProgress.current || request.current) return;
    deleteInProgress.current = true; setDeleting(true); setError('');
    try {
      await deleteCameraPicture(camera.endpoint, selectedPhoto);
      if (mounted.current) {
        const remaining = gallery.filter(photo => photo.uri !== selectedPhoto);
        setGallery(remaining); setSelectedPhoto(null);
        if (picture?.uri === selectedPhoto) { setPicture(remaining[0] || null); setSavedUri(''); }
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : t('cameraDeleteFailed'));
    } finally {
      deleteInProgress.current = false;
      if (mounted.current) setDeleting(false);
    }
  };
  const takePicture = async () => {
    if (request.current) { request.current.abort(); return; }
    const controller = new AbortController(); request.current = controller;
    setPhase('capture'); setError('');
    try {
      const next = await captureGatewayPicture(camera.endpoint, controller.signal, () => {
        if (mounted.current && !controller.signal.aborted) setPhase('download');
      });
      if (controller.signal.aborted) return;
      const stored = await storeCameraPicture(camera.endpoint, next);
      if (mounted.current) {
        setPicture(stored); setSavedUri('');
        setGallery(photos => [stored, ...photos]);
      }
    } catch (caught) {
      if (mounted.current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : t('cameraCaptureFailed'));
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current) setPhase(null);
    }
  };
  return <Card>
    <ListRow icon="camera-outline" title={camera.name || camera.serial || camera.endpoint} subtitle={camera.model || camera.serial || camera.endpoint} last />
    <View style={styles.content}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('cameraResolution')} accessibilityState={{ expanded: resolutionOpen, disabled: !!phase || settingsBusy }} disabled={!!phase || settingsBusy} onPress={() => setResolutionOpen(value => !value)} style={[styles.dropdown, { borderColor: colors.separator, backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.text }}>{t('cameraResolution')} · {settingsBusy ? t('cameraLoadingResolution') : resolution || '—'}</Text>
        <Text style={{ color: colors.secondary }}>{resolutionOpen ? '▴' : '▾'}</Text>
      </Pressable>
      {resolutionOpen ? <View style={[styles.options, { borderColor: colors.separator }]}>
        {CAMERA_RESOLUTIONS.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: resolution === value }} style={[styles.option, { backgroundColor: resolution === value ? colors.surface : colors.card }]} onPress={() => { setResolutionOpen(false); if (value !== resolution) void updateResolution(value); }}>
          <Text style={{ color: colors.text }}>{value}{resolution === value ? ' ✓' : ''}</Text>
        </Pressable>)}
      </View> : null}
      <Button icon="refresh-outline" label={t('cameraQueryResolution')} kind="secondary" disabled={!!phase || settingsBusy} onPress={() => void updateResolution()} />
      <Button icon="camera-outline" label={phase ? `${t(phase === 'capture' ? 'cameraCapturing' : 'cameraDownloading')} · ${t('cancel')}` : t('cameraTakePicture')} disabled={settingsBusy || saving || deleting} onPress={() => void takePicture()} kind={phase ? 'secondary' : 'primary'} />
      {error ? <Notice tone="danger" text={error} /> : null}
      {picture ? <>
        <Pressable accessibilityRole="button" accessibilityLabel={t('cameraOpenPicture')} onPress={() => setViewerUri(picture.uri)}>
          <Image source={{ uri: picture.uri }} style={[styles.picture, { backgroundColor: colors.surface }]} resizeMode="contain" accessibilityLabel={t('cameraLatestPicture')} />
        </Pressable>
        <Text style={[styles.caption, { color: colors.secondary }]}>{t('cameraLatestPicture')} · {Math.ceil(picture.bytes / 1024)} KB</Text>
        <Button icon="download-outline" label={savedUri ? t('cameraSaved') : t('cameraSavePhotos')} kind="secondary" disabled={!!phase || !!savedUri || deleting} loading={saving} onPress={() => void savePicture()} />
      </> : null}
      <Text style={[styles.galleryTitle, { color: colors.text }]}>{t('cameraGallery')} · {gallery.length}</Text>
      {gallery.length ? <>
        <Text style={[styles.caption, { color: colors.secondary }]}>{t('cameraGalleryHint')}</Text>
        <View style={styles.gallery}>
          {gallery.map(photo => <Pressable key={photo.uri} accessibilityRole="button" accessibilityLabel={`${t('cameraOpenPicture')} · ${new Date(photo.createdAt).toLocaleString()}`} accessibilityState={{ selected: selectedPhoto === photo.uri }} disabled={deleting} onPress={() => { setSelectedPhoto(null); setViewerUri(photo.uri); }} onLongPress={() => setSelectedPhoto(photo.uri)} style={[styles.thumbnail, { borderColor: selectedPhoto === photo.uri ? colors.primary : colors.separator }]}>
            <Image source={{ uri: photo.uri }} style={styles.thumbnailImage} resizeMode="cover" />
          </Pressable>)}
        </View>
        {selectedPhoto ? <Button icon="trash-outline" label={t('cameraDeletePicture')} kind="danger" loading={deleting} disabled={!!phase || saving} onPress={() => void deleteSelectedPhoto()} /> : null}
      </> : <Text style={[styles.caption, { color: colors.secondary }]}>{t('cameraGalleryEmpty')}</Text>}
      {viewerUri ? <CameraPictureViewer uri={viewerUri} onClose={() => setViewerUri(null)} /> : null}
    </View>
  </Card>;
}
const styles = StyleSheet.create({
  galleryTitle: { fontSize: 16, fontWeight: '600', marginTop: 8 },
  gallery: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumbnail: { width: '30%', aspectRatio: 4 / 3, borderRadius: 10, borderWidth: 2, overflow: 'hidden' },
  thumbnailImage: { width: '100%', height: '100%' },
  dropdown: { borderWidth: 1, borderRadius: 12, padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  options: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  option: { padding: 14, minHeight: 48, justifyContent: 'center' },
  content: { padding: 14, gap: 12 },
  picture: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12 },
  caption: { fontSize: 13 },
});
