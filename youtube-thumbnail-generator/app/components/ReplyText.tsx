// Lightweight rendering for the agent's replies: paragraphs, numbered and
// bulleted lists, and **bold**. Enough for "1. … 2. …" without a markdown
// dependency, and safe because it never injects HTML.

import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

type Block =
  | { type: "p"; lines: string[] }
  | { type: "ol"; items: Array<{ n: number; text: string }> }
  | { type: "ul"; items: string[] };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const last = blocks.at(-1);
    if (ordered) {
      const item = { n: Number(ordered[1]), text: ordered[2] };
      if (last?.type === "ol") last.items.push(item);
      else blocks.push({ type: "ol", items: [item] });
    } else if (bullet) {
      if (last?.type === "ul") last.items.push(bullet[1]);
      else blocks.push({ type: "ul", items: [bullet[1]] });
    } else if (!line.trim()) {
      if (last && !(last.type === "p" && last.lines.length === 0)) blocks.push({ type: "p", lines: [] });
    } else if (last?.type === "p") {
      last.lines.push(line);
    } else {
      blocks.push({ type: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => b.type !== "p" || b.lines.length > 0);
}

export function ReplyText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parse(text);
  return (
    <div className={`space-y-2 leading-relaxed ${streaming ? "streaming" : ""}`}>
      {blocks.map((b, i) => {
        if (b.type === "ol") {
          return (
            <ol key={i} className="space-y-1.5">
              {b.items.map((item, j) => (
                <li key={j} className="flex gap-2">
                  <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold text-on-accent">
                    {item.n}
                  </span>
                  <span>{inline(item.text)}</span>
                </li>
              ))}
            </ol>
          );
        }
        if (b.type === "ul") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
      {streaming && blocks.length === 0 && <p className="caret text-muted">Writing</p>}
    </div>
  );
}
