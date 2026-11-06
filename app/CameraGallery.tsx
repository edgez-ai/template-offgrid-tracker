import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { cloudCameraImageReader, listCloudCameraImages, type CloudCameraImage } from "./cloud-auth";

type Reader = Awaited<ReturnType<typeof cloudCameraImageReader>>;

function Photo({ image, reader, onOpen }: { image: CloudCameraImage; reader: Reader;
  onOpen: (photo: { image: CloudCameraImage; uri: string }) => void }) {
  const [uri, setUri] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setUri("");
    void reader(image.fileId, controller.signal).then(setUri).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not load photo.");
    });
    return () => controller.abort();
  }, [image.fileId, reader, attempt]);
  return <View style={styles.photo}>
    <Pressable onPress={() => uri ? onOpen({ image, uri }) : setAttempt((value) => value + 1)}
      accessibilityRole="button" accessibilityLabel={uri ? "Open camera photo" : "Retry loading photo"}>
      {uri ? <Image source={{ uri }} style={[styles.thumbnail, { aspectRatio: image.width / image.height }]} resizeMode="contain" />
        : <View style={styles.placeholder}>{error ? <Text style={styles.error}>{error} Tap to retry.</Text> : <ActivityIndicator color="#0a8c87" />}</View>}
    </Pressable>
    <Text style={styles.caption}>{new Date(image.receivedAt).toLocaleString()}</Text>
    <Text style={styles.hint}>{image.width} × {image.height} · {Math.round(image.totalBytes / 1024)} KB</Text>
  </View>;
}

export function CameraGallery({ deviceId, onImagesAvailable }: { deviceId: string; onImagesAvailable: () => void }) {
  const [images, setImages] = useState<CloudCameraImage[]>([]);
  const [reader, setReader] = useState<Reader | null>(null);
  const [selected, setSelected] = useState<{ image: CloudCameraImage; uri: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const activeDevice = useRef(deviceId); activeDevice.current = deviceId;
  const onImages = useRef(onImagesAvailable); onImages.current = onImagesAvailable;
  useEffect(() => {
    let active = true, running = false;
    setImages([]); setReader(null); setSelected(null); setPage(0); setError(""); setLoading(true);
    let readerAt = 0;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const rows = await listCloudCameraImages(deviceId);
        if (!active) return;
        if (rows.length && Date.now() - readerAt > 10 * 60 * 1000) {
          const nextReader = await cloudCameraImageReader();
          if (!active) return;
          setReader(() => nextReader); readerAt = Date.now();
        }
        if (!active) return;
        setImages((current) => [...rows, ...current.filter((image) => !rows.some((row) => row.$id === image.$id))]);
        setHasMore((current) => readerAt === 0 || rows.length < 12 ? false : current || rows.length === 12);
        if (rows.length) onImages.current();
        setError("");
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : "Could not load photos."); }
      finally { running = false; if (active) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => { active = false; clearInterval(timer); };
  }, [deviceId]);

  const loadMore = useCallback(async () => {
    const cursor = images.at(-1)?.$id;
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const rows = await listCloudCameraImages(deviceId, cursor);
      if (activeDevice.current !== deviceId) return;
      setImages((current) => [...current, ...rows.filter((row) => !current.some((image) => image.$id === row.$id))]);
      setHasMore(rows.length === 12); setError("");
    } catch (caught) { if (activeDevice.current === deviceId) setError(caught instanceof Error ? caught.message : "Could not load photos."); }
    finally { if (activeDevice.current === deviceId) setLoading(false); }
  }, [deviceId, images, loading]);
  // Render one page at a time to bound decoded image memory on mobile.
  const visible = images.slice(page * 12, (page + 1) * 12);
  return <View style={styles.card}>
    <Text style={styles.title}>CAMERA PHOTOS</Text>
    <Text style={styles.hint}>Newest first · Received time</Text>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {!images.length && !loading && !error ? <Text style={styles.hint}>Waiting for the first photo.</Text> : null}
    {reader ? visible.map((image) => <Photo key={image.$id} image={image} reader={reader} onOpen={setSelected} />) : null}
    {loading ? <ActivityIndicator color="#0a8c87" /> : null}
    <View style={styles.actions}>
      {page > 0 ? <Pressable onPress={() => setPage((value) => value - 1)}><Text style={styles.link}>NEWER</Text></Pressable> : null}
      {(page + 1) * 12 < images.length ? <Pressable onPress={() => setPage((value) => value + 1)}><Text style={styles.link}>OLDER</Text></Pressable>
        : hasMore ? <Pressable disabled={loading} onPress={() => void loadMore()}><Text style={styles.link}>LOAD OLDER PHOTOS</Text></Pressable> : null}
    </View>
    <Modal visible={Boolean(selected)} onRequestClose={() => setSelected(null)} animationType="fade">
      <SafeAreaView style={styles.viewer}>
        <Pressable onPress={() => setSelected(null)} accessibilityRole="button"><Text style={styles.close}>CLOSE PHOTO</Text></Pressable>
        {selected ? <><Image source={{ uri: selected.uri }} style={styles.fullImage} resizeMode="contain" />
          <Text style={styles.close}>{new Date(selected.image.receivedAt).toLocaleString()} · {selected.image.width} × {selected.image.height}</Text></> : null}
      </SafeAreaView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 12, backgroundColor: "white", borderRadius: 16 },
  title: { fontSize: 13, fontWeight: "700", color: "#173a37" }, hint: { fontSize: 12, color: "#667e7a" },
  photo: { gap: 5 }, thumbnail: { width: "100%", backgroundColor: "#edf3f1", borderRadius: 8 },
  placeholder: { height: 150, alignItems: "center", justifyContent: "center", backgroundColor: "#edf3f1" },
  caption: { fontSize: 13, color: "#173a37" }, error: { fontSize: 12, color: "#b42318" },
  actions: { flexDirection: "row", justifyContent: "space-between" }, link: { fontSize: 12, color: "#0a8c87", paddingVertical: 12, fontWeight: "700" },
  viewer: { flex: 1, backgroundColor: "#0c1716", padding: 18 }, fullImage: { flex: 1, width: "100%" },
  close: { color: "white", paddingVertical: 16, fontSize: 13 },
});
