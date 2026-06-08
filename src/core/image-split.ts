import { createCanvas, loadImage } from '@napi-rs/canvas';

type LoadedImage = Awaited<ReturnType<typeof loadImage>>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function crop(img: LoadedImage, sx: number, sy: number, sw: number, sh: number): string {
  const canvas = createCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toBuffer('image/jpeg', 0.92).toString('base64');
}

/**
 * Splits a base64 image into left and right halves at `ratio` (fraction of the
 * width, clamped to 0.1–0.9) — used to break a two-page spread across its gutter.
 * Returns raw base64 JPEGs to match how page images are stored.
 */
export async function splitImageHorizontally(
  base64: string,
  ratio: number,
): Promise<{ left: string; right: string }> {
  const img = await loadImage(Buffer.from(base64, 'base64'));
  const w = img.width;
  const h = img.height;
  const cut = Math.round(w * clamp(ratio, 0.1, 0.9));
  return {
    left: crop(img, 0, 0, cut, h),
    right: crop(img, cut, 0, w - cut, h),
  };
}
