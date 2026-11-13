import { useAgentRun, type AgentRunStep } from "@seclai/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { saveUrl } from "~/lib/download";
import {
  API_BASE,
  attachmentUrl,
  type ChatMessage,
  type SessionSummary,
  type UploadInfo,
} from "~/lib/types";

import { Composer, type ComposerHandle } from "./Composer";
import { type GalleryImage, ImageCard, imageFileName, SkeletonCard } from "./ImageCard";
import { Lightbox } from "./Lightbox";
import { ReplyText } from "./ReplyText";

const DEFAULT_VARIANTS = 4;

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
          onClick={async () => {
            for (const img of images) {
              saveUrl(img.url, imageFileName(img));
              await new Promise((r) => setTimeout(r, 400));
            }
          }}
          className="mt-2 text-xs font-medium text-muted underline-offset-2 hover:text-text hover:underline"
        >
          Download all {images.length}
        </button>
      )}
    </div>
  );
}

function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setSeconds(0);
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);
  return seconds;
}

function WaitNote({ running }: { running: boolean }) {
  const seconds = useElapsed(running);
  if (!running) return null;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <p className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
      <span className="flex-1">
        {seconds < 150
          ? "Generating images usually takes a minute or two. You can keep this tab open while they're made."
          : "Still working: larger batches can take a few minutes."}
      </span>
      <span className="tabular-nums" aria-label={`${seconds} seconds elapsed`}>
        {clock}
      </span>
    </p>
  );
}

function StepList({ steps }: { steps: AgentRunStep[] }) {
  if (steps.length === 0) return <p className="text-sm text-muted">Starting the run…</p>;
  return (
    <ol className="space-y-0.5 text-xs text-muted">
      {steps.map((s, i) => (
        <li key={s.id} className="flex gap-2">
          <span aria-hidden>{i === steps.length - 1 ? "●" : "✓"}</span>
          <span>
            <span className="font-medium text-text">{s.name}</span>
            {s.message && <span> · {s.message}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
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

  // Follow the conversation as it grows, unless the user has scrolled up.
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages.length, pending, run.text, run.steps.length, run.status]);

  async function send(turn: PendingTurn) {
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
    // Rejected before the run started (for example no credits): nothing was
    // stored, so keep the turn around to retry.
    if (result.status === "failed" && !result.runId && !result.text) {
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

  const liveTurn = turns.size + 1;
  const liveImages: GalleryImage[] =
    run.runId && run.attachments.length
      ? run.attachments
          .filter((a) => a.mime.startsWith("image/"))
          .map((a, i) => ({ key: `live:${a.id}`, url: a.url, name: a.name, number: i + 1, turn: liveTurn }))
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
                  {m.content && <ReplyText text={m.content} />}
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
                      Stopped. The run may still have finished on Seclai, but its images weren't saved here.
                    </p>
                  )}
                </div>
              </div>
            ),
          )}

          {pending && (
            <>
              <UserBubble content={pending.input} uploads={pending.uploads} />
              <div className="flex gap-3" aria-live="polite">
                <Avatar />
                <div className="min-w-0 flex-1 space-y-3">
                  <WaitNote running={running} />
                  {running && <StepList steps={run.steps} />}
                  {(run.text || running) && <ReplyText text={run.text} streaming={running} />}
                  {liveImages.length > 0 ? (
                    <ImageGrid images={liveImages} onOpen={() => {}} onRefine={refine} />
                  ) : (
                    running && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {Array.from({ length: DEFAULT_VARIANTS }, (_, i) => (
                          <SkeletonCard key={i} number={i + 1} />
                        ))}
                      </div>
                    )
                  )}
                  {running && (
                    <button
                      type="button"
                      onClick={run.cancel}
                      className="rounded-md border border-border px-3 py-1 text-xs hover:bg-surface-2"
                    >
                      Stop
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
            busy={running || !!pending}
            onSend={(input, uploads) => send({ input, uploads })}
          />
          <p className="mt-2 text-center text-[11px] text-muted">
            Each reply can use up to 3,000 credits. Images are 16:9; titles are kept clear of YouTube's timestamp.
          </p>
        </div>
      </div>

      <Lightbox images={gallery} index={lightbox} onChange={setLightbox} onClose={() => setLightbox(null)} />
    </main>
  );
}
