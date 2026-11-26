export type PictureTransform = { scale: number; x: number; y: number };
export type PictureTouch = { pageX: number; pageY: number; locationX?: number; locationY?: number };
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** Keep the whole pointer sequence separate from tap-to-close. Lifting either
 * finger of a pinch must not start a new tap or discard the other finger. */
export function createPictureGesture(
  size: () => { width: number; height: number },
  update: (value: PictureTransform) => void,
  onTap: () => void,
) {
  let value: PictureTransform = { scale: 1, x: 0, y: 0 };
  let base = value, active = false, count = 0, eligible = false, began = 0;
  let px = 0, py = 0, distance = 1, tapX = 0, tapY = 0;
  const geometry = (touches: readonly PictureTouch[]) => {
    const a = touches[0], b = touches[1];
    return { x: b ? (a.pageX + b.pageX) / 2 : a.pageX, y: b ? (a.pageY + b.pageY) / 2 : a.pageY,
      distance: b ? Math.max(1, Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY)) : 1 };
  };
  const apply = (next: PictureTransform) => {
    const scale = Math.max(1, Math.min(5, next.scale)), viewport = size();
    value = { scale, x: clamp(next.x, viewport.width * (scale - 1) / 2), y: clamp(next.y, viewport.height * (scale - 1) / 2) };
    update(value);
  };
  const snapshot = (touches: readonly PictureTouch[]) => {
    if (!touches.length) return;
    const point = geometry(touches);
    base = value; count = touches.length; px = point.x; py = point.y; distance = point.distance;
  };
  return {
    start(touches: readonly PictureTouch[], now = Date.now()) {
      if (!touches.length) return;
      if (!active) {
        active = true; eligible = touches.length === 1; began = now;
        tapX = touches[0].pageX; tapY = touches[0].pageY;
      }
      if (touches.length > 1) eligible = false;
      snapshot(touches);
    },
    move(touches: readonly PictureTouch[]) {
      if (!active || !touches.length) return;
      const point = geometry(touches);
      if (touches.length > 1 || Math.hypot(touches[0].pageX - tapX, touches[0].pageY - tapY) > 8) eligible = false;
      if (touches.length !== count) { eligible = false; snapshot(touches); return; }
      apply({ scale: base.scale * (touches.length > 1 ? point.distance / distance : 1), x: base.x + point.x - px, y: base.y + point.y - py });
    },
    end(remaining: readonly PictureTouch[], now = Date.now()) {
      if (!active) return;
      if (remaining.length) { eligible = false; snapshot(remaining); return; }
      const tap = eligible && now - began < 350;
      active = false; eligible = false; count = 0;
      if (tap) onTap();
    },
    cancel() { active = false; eligible = false; count = 0; },
    layout() { apply(value); },
  };
}
