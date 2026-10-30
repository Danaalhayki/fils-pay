import sharp from "sharp";
import type { DetectedFileType } from "./fileSignature.js";

/**
 * Longest side, in pixels.
 */
const THUMBNAIL_MAX_DIMENSION_PX = 320;

const THUMBNAIL_MAX_INPUT_PIXELS = 25_000_000;

// Each upload is thumbnailed once, so libvips' operation cache never hits;
// it only grows toward the API container's 512 MB limit.
sharp.cache(false);

export interface GeneratedThumbnail {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generates a review-UI-sized thumbnail from an already-validated upload
 * buffer. Only `jpeg`/`png` documents get one — a `pdf` (commercial
 * registration, bank letter) has no image to thumbnail, and this returns
 * `null` rather than attempting a PDF-to-image conversion. Always
 * re-encodes to JPEG regardless of the source format, so the admin
 * console's `<img>` tag never needs to branch on thumbnail mime type the
 * way the original-file endpoint does.
 */
export async function generateKycThumbnail(
  buffer: Buffer,
  detectedType: DetectedFileType,
): Promise<GeneratedThumbnail | null> {
  if (detectedType !== "jpeg" && detectedType !== "png") {
    return null;
  }
  // The byte cap doesn't bound decoded size: a few-KB PNG can declare a
  // gigapixel canvas. 25 MP covers any phone photo or scan.
  const resized = await sharp(buffer, { limitInputPixels: THUMBNAIL_MAX_INPUT_PIXELS })
    .resize(THUMBNAIL_MAX_DIMENSION_PX, THUMBNAIL_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
  return { buffer: resized, mimeType: "image/jpeg" };
}
