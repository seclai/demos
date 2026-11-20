// Browser-side download helpers.

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function saveUrl(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

export function baseName(name: string | null, fallback: string): string {
  return (name ?? fallback).replace(/\.[a-z0-9]+$/i, "");
}

const YT_WIDTH = 1280;
const YT_HEIGHT = 720;
const YT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * YouTube wants a 1280×720 JPG, PNG or GIF under 2 MB. Scales the image to
 * cover 1280×720 (cropping any overflow from the centre) and lowers the JPEG
 * quality until it fits.
 */
export async function toYouTubeJpeg(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch the image (status ${res.status}).`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement("canvas");
  canvas.width = YT_WIDTH;
  canvas.height = YT_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas isn't available in this browser.");
  const scale = Math.max(YT_WIDTH / bitmap.width, YT_HEIGHT / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (YT_WIDTH - w) / 2, (YT_HEIGHT - h) / 2, w, h);
  bitmap.close();

  for (const quality of [0.92, 0.85, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && (blob.size <= YT_MAX_BYTES || quality === 0.6)) return blob;
  }
  throw new Error("Couldn't encode the image.");
}
