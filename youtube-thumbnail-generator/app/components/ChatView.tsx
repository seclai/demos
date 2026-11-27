import { MarkdownContent, MediaViewer, RunProgress, saveFiles, useAgentRun, type AgentAttachment } from "@seclai/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { DEFAULT_VARIANTS, expectedImageCount } from "~/lib/expected-images";
import {
  API_BASE,
  attachmentUrl,
  type ChatMessage,
  type SessionSummary,
  type UploadInfo,
} from "~/lib/types";

import { Composer, type ComposerHandle } from "./Composer";
import { type GalleryImage, ImageCard, imageFileName, SkeletonCard } from "./ImageCard";

/** How often to check for a reply that's still being generated. */
const POLL_MS = 8_000;
/** Longer than any run can take (the handlers stop waiting at 11 minutes). */
const AWAIT_REPLY_MS = 15 * 60 * 1000;

interface Slot {
  max: number;
  contentTypes: string[];
}

interface PendingTurn {
  input: string;
  uploads: UploadInfo[];
}

function UploadChips({ uploads }: { uploads: UploadInfo[] }) {
  if (uploads.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-wrap justify-end gap-2">
      {uploads.map((u) => (
        <li key={u.id} className="w-20">
          <a href={u.url} target="_blank" rel="noreferrer" className="block">
            <img
              src={u.url}
              alt={u.filename}
              className="aspect-square w-full rounded-lg border border-border object-cover"
            />
          </a>
          <span
            className={`mt-1 block truncate rounded px-1 text-center text-[11px] font-medium ${
              u.kind === "headshot" ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"
            }`}
          >
            {u.kind === "headshot" ? "Headshot" : "Style"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function UserBubble({ content, uploads }: { content: string; uploads: UploadInfo[] }) {
  return (
    <div className="flex flex-col items-end">
      <UploadChips uploads={uploads} />
      {content && (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-user px-4 py-2.5">{content}</div>
      )}
    </div>
  );
}

function Avatar() {
  return (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs text-on-accent">
      ▶
    </div>
  );
}

function ImageGrid({
  images,
  onOpen,
  onRefine,
}: {
  images: GalleryImage[];
  onOpen(img: GalleryImage): void;
  onRefine(img: GalleryImage): void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {images.map((img) => (
          <ImageCard key={img.key} image={img} onOpen={() => onOpen(img)} onRefine={() => onRefine(img)} />
        ))}
      </div>
      {images.length > 1 && (
        <button
          type="button"
          onClick={() => void saveFiles(images.map((img) => ({ source: img.url, filename: imageFileName(img) })))}
          className="mt-2 text-xs font-medium text-muted underline-offset-2 hover:text-text hover:underline"
        >
          Download all {images.length}
        </button>
      )}
    </div>
  );
}

/**
 * The agent's reply. While it streams, a caret follows the text. Until the first
 * of it arrives, `RunProgress` shows the run is going.
 */
function Reply({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (!text.trim()) return null;
  return (
    <div className={`leading-relaxed ${streaming ? "streaming" : ""}`}>
      <MarkdownContent content={text} streaming={streaming} />
    </div>
  );
}

/** The note next to the clock while a round of images is generating. */
function waitMessage(seconds: number): string {
  return seconds < 150
    ? "Generating images usually takes a minute or two. You can keep this tab open while they're made."
    : "Still working: larger batches can take a few minutes.";
}

export function ChatView({
  session,
  messages,
  slot,
}: {
  session: SessionSummary;
  messages: ChatMessage[];
  slot: Slot;
}) {
  const run = useAgentRun({ basePath: API_BASE });
  const revalidator = useRevalidator();
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [startError, setStartError] = useState<{ message: string; turn: PendingTurn } | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);

  // Number the agent's replies, and collect every image in the session for the lightbox.
  const { turns, gallery } = useMemo(() => {
    const turns = new Map<number, GalleryImage[]>();
    const gallery: GalleryImage[] = [];
    let turn = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      turn += 1;
      const images = m.runId
        ? m.attachments
            .filter((a) => a.mime.startsWith("image/"))
            .map((a, i) => ({
              key: `${m.runId}:${a.id}`,
              url: attachmentUrl(m.runId!, a),
              name: a.name,
              mime: a.mime,
              number: i + 1,
              turn,
            }))
        : [];
      turns.set(m.id, images);
      gallery.push(...images);
    }
    return { turns, gallery };
  }, [messages]);

  const hasHeadshot = messages.some((m) => m.uploads.some((u) => u.kind === "headshot"));
  const running = run.status === "running";
  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  // A run whose browser went away (another session, "continue in background", a
  // closed tab) keeps going, and the server saves its reply when it finishes.
  // Until then the session ends with the user's message: check back for it.
  const last = messages.at(-1);
  const awaitingSince = !pending && last?.role === "user" ? last.createdAt : null;
  const gaveUp = awaitingSince !== null && Date.now() - awaitingSince > AWAIT_REPLY_MS;
  const awaitingReply = awaitingSince !== null && !gaveUp;
  useEffect(() => {
    if (!awaitingReply) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [awaitingReply, revalidator]);

  // Follow the conversation as it grows, unless the user has scrolled up.
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages.length, pending, run.text, run.steps.length, run.status]);

  // The latest message count, readable after an await.
  const messageCount = useRef(messages.length);
  messageCount.current = messages.length;

  async function send(turn: PendingTurn) {
    const before = messageCount.current;
    setStartError(null);
    setPending(turn);
    stick.current = true;
    const result = await run.start({
      input: turn.input,
      uploadIds: turn.uploads.map((u) => u.id),
      sessionId: session.id,
    });
    await revalidator.revalidate();
    setPending(null);
    // The server stores the turn (and, if the API refused the run, the error).
    // If nothing new arrived, the request never reached it, for example a
    // network error: keep the turn around to retry.
    if (result.status === "failed" && messageCount.current === before) {
      setStartError({ message: result.error ?? "The run failed to start.", turn });
    }
  }

  const refine = useCallback((img: GalleryImage) => {
    composer.current?.insert(`Image ${img.number} from round ${img.turn}: `);
  }, []);

  const open = useCallback(
    (img: GalleryImage) => {
      const i = gallery.findIndex((g) => g.key === img.key);
      if (i >= 0) setLightbox(i);
    },
    [gallery],
  );

  // The package's viewer shows each image's name as its label and uses it as
  // the download's filename, so name them by round and number.
  const viewerImages = useMemo<AgentAttachment[]>(
    () =>
      gallery.map((g) => ({
        id: g.key,
        name: `round-${g.turn}-image-${g.number}.${g.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`,
        mime: g.mime,
        bytes: null,
        url: g.url,
      })),
    [gallery],
  );

  const liveTurn = turns.size + 1;
  const hasImages = [...turns.values()].some((imgs) => imgs.length > 0);
  const placeholders = pending
    ? expectedImageCount({
        input: pending.input,
        streamedText: run.text,
        hasImages,
        hasUploads: pending.uploads.length > 0,
      })
    : 0;
  const liveImages: GalleryImage[] =
    run.runId && run.attachments.length
      ? run.attachments
          .filter((a) => a.mime.startsWith("image/"))
          .map((a, i) => ({ key: `live:${a.id}`, url: a.url, name: a.name, mime: a.mime, number: i + 1, turn: liveTurn }))
      : [];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 && !pending && (
            <div className="rounded-2xl border border-dashed border-border p-6 text-center">
              <h2 className="text-lg font-semibold">New thumbnail session</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted">
                Add your headshot and, optionally, a style reference. Then tell the designer the video title and the
                mood. You'll get {DEFAULT_VARIANTS} variants to compare and refine; each round of images takes a minute
                or two.
              </p>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <UserBubble key={m.id} content={m.content} uploads={m.uploads} />
            ) : (
              <div key={m.id} className="flex gap-3">
                <Avatar />
                <div className="min-w-0 flex-1">
                  {m.content && <Reply text={m.content} />}
                  <ImageGrid images={turns.get(m.id) ?? []} onOpen={open} onRefine={refine} />
                  {m.status === "failed" && (
                    <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                      {m.error ?? "The run failed."}
                      {lastUser && m.id === messages.at(-1)?.id && (
                        <button
                          type="button"
                          disabled={running}
                          onClick={() => send({ input: lastUser.content, uploads: lastUser.uploads })}
                          className="ml-2 font-medium underline"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                  {m.status === "cancelled" && (
                    <p className="mt-1 text-xs text-muted">
                      Stopped before this reply was saved. The run may still have finished on Seclai.
                    </p>
                  )}
                </div>
              </div>
            ),
          )}

          {awaitingReply && (
            <div className="flex gap-3" aria-live="polite">
              <Avatar />
              <p className="flex flex-1 items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
                Still generating this reply in the background. It will appear here when it's done.
              </p>
            </div>
          )}
          {gaveUp && (
            <p className="text-xs text-muted">
              No reply was saved for this message. The server may have restarted while it was generating. You can send
              it again.
            </p>
          )}

          {pending && (
            <>
              <UserBubble content={pending.input} uploads={pending.uploads} />
              <div className="flex gap-3" aria-live="polite">
                <Avatar />
                <div className="min-w-0 flex-1 space-y-3">
                  <RunProgress run={run} message={waitMessage} />
                  <Reply text={run.text} streaming={running} />
                  {liveImages.length > 0 ? (
                    <ImageGrid images={liveImages} onOpen={() => {}} onRefine={refine} />
                  ) : (
                    running && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {Array.from({ length: placeholders }, (_, i) => (
                          <SkeletonCard key={i} number={i + 1} />
                        ))}
                      </div>
                    )
                  )}
                  {running && (
                    <button
                      type="button"
                      onClick={run.cancel}
                      title="The run keeps going on Seclai. Its reply is saved here when it finishes."
                      className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2"
                    >
                      Continue in background
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {startError && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {startError.message}
              <button type="button" onClick={() => send(startError.turn)} className="ml-2 font-medium underline">
                Retry
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-bg/80 px-4 pb-4 pt-3 backdrop-blur">
        <div className="mx-auto max-w-3xl">
          <Composer
            ref={composer}
            sessionId={session.id}
            maxFiles={slot.max}
            contentTypes={slot.contentTypes}
            hasHeadshot={hasHeadshot}
            busy={running || !!pending || awaitingReply}
            onSend={(input, uploads) => send({ input, uploads })}
          />
          <p className="mt-2 text-center text-[11px] text-muted">
            Each reply can use up to 3,000 credits. Images are 16:9; titles are kept clear of YouTube's timestamp.
          </p>
        </div>
      </div>

      <MediaViewer
        attachments={viewerImages}
        index={lightbox}
        onIndexChange={setLightbox}
        onClose={() => setLightbox(null)}
      />
    </main>
  );
}
