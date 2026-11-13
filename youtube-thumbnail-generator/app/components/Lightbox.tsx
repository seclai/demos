import { useEffect, useRef } from "react";

import { type GalleryImage, imageFileName } from "./ImageCard";

export function Lightbox({
  images,
  index,
  onChange,
  onClose,
}: {
  images: GalleryImage[];
  index: number | null;
  onChange(index: number): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const image = index === null ? null : images[index];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (image && !dialog.open) dialog.showModal();
    if (!image && dialog.open) dialog.close();
  }, [image]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && index > 0) onChange(index - 1);
      if (e.key === "ArrowRight" && index < images.length - 1) onChange(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onChange]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto w-[min(96vw,1400px)] max-w-none bg-transparent p-0 text-white"
    >
      {image && (
        <div className="flex flex-col gap-3">
          <img src={image.url} alt={`Thumbnail ${image.number}`} className="aspect-video w-full rounded-lg object-contain" />
          <div className="flex flex-wrap items-center gap-2 px-1 text-sm">
            <span className="mr-auto">
              Turn {image.turn} · Image {image.number}
              <span className="ml-2 text-white/60">
                {index! + 1} / {images.length}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onChange(index! - 1)}
              disabled={index === 0}
              className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20 disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={() => onChange(index! + 1)}
              disabled={index === images.length - 1}
              className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20 disabled:opacity-40"
            >
              Next →
            </button>
            <a
              href={image.url}
              download={imageFileName(image)}
              className="rounded-md bg-white px-3 py-1.5 font-medium text-black hover:bg-white/90"
            >
              Download
            </a>
            <button type="button" onClick={onClose} className="rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20">
              Close
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
