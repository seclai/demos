import { useState } from "react";

import { baseName, saveBlob, toYouTubeJpeg } from "~/lib/download";

export interface GalleryImage {
  key: string;
  url: string;
  name: string | null;
  /** 1-based, matching the agent's numbered list for its turn. */
  number: number;
  /** 1-based count of the agent's replies in the session. */
  turn: number;
}

export function imageFileName(img: GalleryImage, ext?: string): string {
  const fallback = `thumbnail-turn${img.turn}-${img.number}`;
  if (!ext) return img.name ?? `${fallback}.png`;
  return `${baseName(img.name, fallback)}-1280x720.${ext}`;
}

export function ImageCard({
  image,
  onOpen,
  onRefine,
}: {
  image: GalleryImage;
  onOpen(): void;
  onRefine(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function downloadForYouTube() {
    setBusy(true);
    setError(null);
    try {
      saveBlob(await toYouTubeJpeg(image.url), imageFileName(image, "jpg"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <figure className="group overflow-hidden rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={onOpen}
        className="relative block aspect-video w-full overflow-hidden bg-surface-2"
        aria-label={`Open image ${image.number} full size`}
      >
        <img
          src={image.url}
          alt={`Thumbnail variant ${image.number}`}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
        />
        <span className="absolute left-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-black/75 px-1.5 text-xs font-semibold text-white">
          {image.number}
        </span>
      </button>
      <figcaption className="flex flex-wrap items-center gap-1.5 p-2">
        <a
          href={image.url}
          download={imageFileName(image)}
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
        >
          Download
        </a>
        <button
          type="button"
          onClick={downloadForYouTube}
          disabled={busy}
          title="1280×720 JPEG under 2 MB, ready to upload to YouTube"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          {busy ? "Preparing…" : "1280×720 JPG"}
        </button>
        <button
          type="button"
          onClick={onRefine}
          className="ml-auto rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
        >
          Refine this
        </button>
        {error && <span className="w-full text-xs text-danger">{error}</span>}
      </figcaption>
    </figure>
  );
}

export function SkeletonCard({ number }: { number: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="skeleton relative aspect-video w-full">
        <span className="absolute left-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-black/40 px-1.5 text-xs font-semibold text-white">
          {number}
        </span>
      </div>
      <div className="h-10" />
    </div>
  );
}
