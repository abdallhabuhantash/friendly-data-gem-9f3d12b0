/**
 * Pure geometry for drawing a normalized frame box over an `object-cover` image.
 *
 * The live stream is rendered with `object-cover`, so the displayed image is
 * scaled up and cropped. Drawing a normalized box as a plain percentage of the
 * container would point at the wrong place, which for a person highlight is a
 * correctness problem — not a cosmetic one.
 */

export interface Size {
  width: number;
  height: number;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const usable = (size: Size | null | undefined): size is Size =>
  !!size &&
  Number.isFinite(size.width) &&
  Number.isFinite(size.height) &&
  size.width > 0 &&
  size.height > 0;

/**
 * Maps a normalized (0..1) frame box to container pixels for an image rendered
 * with `object-fit: cover` and centred. Returns null when the sizes are not yet
 * known or when the box would be entirely outside the visible crop.
 */
export function objectCoverRect(
  box: { x: number; y: number; width: number; height: number },
  image: Size | null | undefined,
  container: Size | null | undefined,
): PixelRect | null {
  if (!usable(image) || !usable(container)) return null;
  const scale = Math.max(container.width / image.width, container.height / image.height);
  const drawnWidth = image.width * scale;
  const drawnHeight = image.height * scale;
  const offsetX = (container.width - drawnWidth) / 2;
  const offsetY = (container.height - drawnHeight) / 2;
  const left = offsetX + box.x * drawnWidth;
  const top = offsetY + box.y * drawnHeight;
  const width = box.width * drawnWidth;
  const height = box.height * drawnHeight;
  if (left + width <= 0 || top + height <= 0) return null;
  if (left >= container.width || top >= container.height) return null;
  return { left, top, width, height };
}
