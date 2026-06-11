import { createCanvas, loadImage } from '@napi-rs/canvas';
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
function crop(img, sx, sy, sw, sh) {
    const canvas = createCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    // Use toDataURL (quality on a 0–1 scale, like render-pdf) — @napi-rs/canvas's
    // toBuffer reads JPEG quality as 0–100, so passing 0.95 there yields ~1% quality.
    return canvas.toDataURL('image/jpeg', 0.95).replace(/^data:image\/jpeg;base64,/, '');
}
/**
 * Splits a base64 image into left and right halves at `ratio` (fraction of the
 * width, clamped to 0.1–0.9) — used to break a two-page spread across its gutter.
 * Returns raw base64 JPEGs to match how page images are stored.
 */
export async function splitImageHorizontally(base64, ratio) {
    const img = await loadImage(Buffer.from(base64, 'base64'));
    const w = img.width;
    const h = img.height;
    const cut = Math.round(w * clamp(ratio, 0.1, 0.9));
    return {
        left: crop(img, 0, 0, cut, h),
        right: crop(img, cut, 0, w - cut, h),
    };
}
