import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { UploadInfo, UploadKind } from "~/lib/types";

interface PendingFile {
  localId: string;
  kind: UploadKind;
  name: string;
  preview: string;
  status: "uploading" | "ready" | "error";
  upload?: UploadInfo;
  error?: string;
}

/**
 * A label wrapping a visually hidden file input, so the browser opens the
 * picker natively. Calling `.click()` on a `display: none` input from script
 * is ignored by some browsers (and does nothing before hydration).
 */
function AttachButton({
  label,
  accept,
  multiple = false,
  disabled,
  onFiles,
}: {
  label: string;
  accept: string[];
  multiple?: boolean;
  disabled: boolean;
  onFiles(files: File[]): void;
}) {
  return (
    <label
      aria-disabled={disabled}
      className={`relative rounded-lg border border-border px-3 py-1.5 text-sm focus-within:ring-2 focus-within:ring-accent ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-surface-2"
      }`}
    >
      {label}
      <input
        type="file"
        accept={accept.join(",")}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length) onFiles(picked);
        }}
      />
    </label>
  );
}

export interface ComposerHandle {
  insert(text: string): void;
}

const MAX_BYTES = 10 * 1024 * 1024;

export const Composer = forwardRef<
  ComposerHandle,
  {
    sessionId: string;
    maxFiles: number;
    contentTypes: string[];
    hasHeadshot: boolean;
    busy: boolean;
    onSend(input: string, uploads: UploadInfo[]): void;
  }
>(function Composer({ sessionId, maxFiles, contentTypes, hasHeadshot, busy, onSend }, ref) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    insert(text) {
      setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
      requestAnimationFrame(() => {
        const el = textarea.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  }));

  // Grow the textarea with its content, up to a limit.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const headshotPending = files.some((f) => f.kind === "headshot");
  const defaultKind: UploadKind = hasHeadshot || headshotPending ? "style" : "headshot";

  async function uploadOne(item: PendingFile, file: File) {
    const form = new FormData();
    form.set("file", file);
    form.set("kind", item.kind);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/uploads`, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as UploadInfo & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Upload failed (status ${res.status}).`);
      setFiles((all) => all.map((f) => (f.localId === item.localId ? { ...f, status: "ready", upload: body } : f)));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Upload failed.";
      setFiles((all) => all.map((f) => (f.localId === item.localId ? { ...f, status: "error", error: message } : f)));
    }
  }

  function addFiles(list: FileList | File[], kind: UploadKind) {
    setNotice(null);
    const room = maxFiles - files.length;
    const incoming = Array.from(list);
    if (incoming.length > room) {
      setNotice(`You can attach up to ${maxFiles} images per message.`);
    }
    for (const file of incoming.slice(0, Math.max(room, 0))) {
      if (!contentTypes.includes(file.type)) {
        setNotice(`${file.name}: use a JPEG, PNG or WebP image.`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        setNotice(`${file.name} is over 10 MB.`);
        continue;
      }
      const item: PendingFile = {
        localId: crypto.randomUUID(),
        kind,
        name: file.name,
        preview: URL.createObjectURL(file),
        status: "uploading",
      };
      setFiles((all) => [...all, item]);
      void uploadOne(item, file);
    }
  }

  function remove(localId: string) {
    setFiles((all) => {
      const gone = all.find((f) => f.localId === localId);
      if (gone) URL.revokeObjectURL(gone.preview);
      return all.filter((f) => f.localId !== localId);
    });
  }

  const uploading = files.some((f) => f.status === "uploading");
  const ready = files.filter((f) => f.status === "ready" && f.upload).map((f) => f.upload!);
  const canSend = !busy && !uploading && (draft.trim().length > 0 || ready.length > 0);

  function send() {
    if (!canSend) return;
    onSend(draft.trim(), ready);
    files.forEach((f) => URL.revokeObjectURL(f.preview));
    setFiles([]);
    setDraft("");
    setNotice(null);
  }

  return (
    <div
      className={`rounded-2xl border bg-surface shadow-sm transition-colors ${
        dragging ? "border-accent" : "border-border"
      }`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files, defaultKind);
      }}
    >
      {!hasHeadshot && files.length === 0 && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted">
          Tip: start with <strong className="text-text">a headshot</strong> (a clear, well-lit photo of your face) and,
          optionally, a thumbnail whose style you like.
        </p>
      )}

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-3 pt-3">
          {files.map((f) => (
            <li key={f.localId} className="relative w-24">
              <div className="relative aspect-square overflow-hidden rounded-lg border border-border bg-surface-2">
                <img src={f.preview} alt="" className="h-full w-full object-cover" />
                {f.status === "uploading" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">
                    Uploading…
                  </div>
                )}
                {f.status === "error" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-1 text-center text-[10px] text-white">
                    {f.error}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => remove(f.localId)}
                  className="absolute right-1 top-1 h-5 w-5 rounded-full bg-black/70 text-xs leading-5 text-white"
                  aria-label={`Remove ${f.name}`}
                >
                  ✕
                </button>
              </div>
              <span
                className={`mt-1 block truncate rounded px-1 text-center text-[11px] font-medium ${
                  f.kind === "headshot" ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"
                }`}
              >
                {f.kind === "headshot" ? "Headshot" : "Style"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={textarea}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            addFiles(pasted, defaultKind);
          }
        }}
        rows={2}
        placeholder={
          hasHeadshot
            ? 'Refine, e.g. "I like 3 best, but use the layout of 1 and make the title yellow"'
            : 'Describe the video, e.g. "Title: I Tried Waking Up at 4AM for 30 Days. Shocked face, bold yellow text."'
        }
        className="block w-full resize-none bg-transparent px-4 py-3 text-[15px] outline-none placeholder:text-muted"
        aria-label="Message"
      />

      {notice && <p className="px-4 pb-1 text-xs text-danger">{notice}</p>}

      <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
        <AttachButton
          label="+ Headshot"
          accept={contentTypes}
          disabled={files.length >= maxFiles}
          onFiles={(list) => addFiles(list, "headshot")}
        />
        <AttachButton
          label="+ Style reference"
          accept={contentTypes}
          multiple
          disabled={files.length >= maxFiles}
          onFiles={(list) => addFiles(list, "style")}
        />
        <span className="hidden text-xs text-muted sm:inline">or drop / paste images</span>
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          className="ml-auto rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Designing…" : uploading ? "Uploading…" : "Send"}
        </button>
      </div>
    </div>
  );
});
