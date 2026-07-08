import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

// Mirror of the server-side ModerationResult shape (src/lib/moderation.ts),
// kept inline so the component is self-contained on the client.
type Decision = 'pass' | 'fail';
type Severity = 'high' | 'medium' | 'low';
interface Violation { rule: string; severity: Severity; explanation: string; }
interface ModerationResult {
  is_listing_photo: boolean;
  not_photo_reason: string | null;
  decision: Decision;
  violations: Violation[];
  quality_score: number;
  confidence: number;
}

type Status = 'empty' | 'loading' | 'streaming' | 'done' | 'error';
type View = 'card' | 'json';

const ACCEPT = 'image/png,image/jpeg';

// Map Seclai's raw model aliases to human-friendly labels for display. Falls
// back to auto-formatting (e.g. openai_gpt_4_1 → GPT-4.1) for unmapped aliases.
const MODEL_LABELS: Record<string, string> = {
  openai_gpt_5_5: 'GPT-5.5',
};
const modelLabel = (m: string) => {
  if (MODEL_LABELS[m]) return MODEL_LABELS[m];
  const g = m.match(/gpt_(\d+)_(\d+)/i);
  if (g) return `GPT-${g[1]}.${g[2]}`;
  return m;
};

const VERDICT = {
  pass: { color: '#15803D', glyph: 'M20 6 9 17l-5-5', label: 'Pass', sub: 'Listing is clear to publish.', bg: '#F1FBF4', border: '#CBEBD5', chip: '#DCFCE7' },
  fail: { color: '#B91C1C', glyph: 'M18 6 6 18M6 6l12 12', label: 'Fail', sub: "Listing can't be published — see the checks below.", bg: '#FEF6F5', border: '#F5D9D6', chip: '#FEE2E2' },
} as const;

// What the moderator checks for, shown in the UI so users know what
// to expect before they run something. Mirrors the system prompt in
// src/lib/moderation.ts. Every rule is blocking — the moderator is strict,
// so there are no advisory-only notes.
type RuleTier = 'fail';
const RULES: { rule: string; tier: RuleTier; label: string; examples: string }[] = [
  { rule: 'prohibited_item', tier: 'fail', label: 'Prohibited or restricted items', examples: 'weapons, drugs, recalled goods, counterfeits, adult content' },
  { rule: 'unsafe_or_graphic', tier: 'fail', label: 'Unsafe or graphic content', examples: 'gore, violence, hazardous materials' },
  { rule: 'contact_info_in_image', tier: 'fail', label: 'Contact info shown in the photo', examples: 'phone numbers, emails, URLs, handles' },
  { rule: 'third_party_watermark', tier: 'fail', label: 'Third-party or retailer watermarks', examples: 'logos from other marketplaces or stock sites' },
  { rule: 'misleading_or_stock', tier: 'fail', label: 'Stock / misleading imagery', examples: 'product render or web-pulled image used as the actual item' },
  { rule: 'not_a_listing_photo', tier: 'fail', label: 'Not a listing photo', examples: 'memes, screenshots, selfies — short-circuits with an error' },
  { rule: 'low_quality_photo', tier: 'fail', label: 'Image quality', examples: 'poor lighting, focus, or framing' },
  { rule: 'possibly_ai_generated', tier: 'fail', label: 'AI-generated or unusual artifacts', examples: 'image appears AI-generated or digitally fabricated' },
];
const RULE_TIER = {
  fail: { color: '#B91C1C', bg: 'rgba(220,38,38,0.10)', label: 'Fails' },
} as const;

// Every rule is a blocking check, so the full rule set becomes the pass/fail
// checklist in the card view.
const CARD_CHECKS = RULES.filter((r) => r.tier === 'fail');

// Sample listings shown under the run button. Drop matching images into
// /public/samples/ — clicking a tile loads it into the uploader like a
// hand-picked file.
const SAMPLES: { src: string; name: string; tag: string; badge: string; caption: string }[] = [
  { src: '/samples/grapefruit.jpg', name: 'grapefruit.jpg', tag: 'clean listing', badge: '#16A34A', caption: 'Fresh grapefruit' },
  { src: '/samples/knife.jpg', name: 'knife.jpg', tag: 'prohibited item', badge: '#DC2626', caption: 'Tactical hunting knife' },
  { src: '/samples/lemons.jpg', name: 'lemons.jpg', tag: 'stock', badge: '#DC2626', caption: 'Fresh organic lemons for sale' },
  { src: '/samples/stock.jpg', name: 'stock.jpg', tag: 'watermark', badge: '#D97706', caption: 'Fresh Watermelon' },
];

const pct = (n: number) => `${Math.round(n <= 1 ? n * 100 : n)}%`;

// Lightweight JSON syntax highlighter, tuned for a light panel.
function JsonView({ data }: { data: unknown }) {
  const lines = JSON.stringify(data, null, 2).split('\n');
  const color = (rest: string): string => {
    if (/^".*"$/.test(rest)) return '#0A7C42';
    if (/^-?\d/.test(rest)) return '#B45309';
    if (/^(true|false|null)$/.test(rest)) return '#B91C1C';
    if (/^[[\]{}]+$/.test(rest)) return '#9A9A90';
    return '#2A2B33';
  };
  return (
    <div className="json">
      {lines.map((line, i) => {
        const ws = line.match(/^\s*/)![0];
        let rest = line.slice(ws.length);
        const keyMatch = rest.match(/^("(?:[^"\\]|\\.)*")(\s*:\s*)/);
        let key: [string, string] | null = null;
        if (keyMatch) { key = [keyMatch[1], keyMatch[2]]; rest = rest.slice(keyMatch[0].length); }
        let trailing = '';
        if (rest.endsWith(',')) { trailing = ','; rest = rest.slice(0, -1); }
        return (
          <div key={i} className="json-line">
            {ws}
            {key && (<><span style={{ color: '#4640E0' }}>{key[0]}</span><span style={{ color: '#9A9A90' }}>{key[1]}</span></>)}
            {rest && <span style={{ color: color(rest) }}>{rest}</span>}
            {trailing && <span style={{ color: '#9A9A90' }}>{trailing}</span>}
          </div>
        );
      })}
    </div>
  );
}

export default function ListingModerator() {
  const [status, setStatus] = useState<Status>('empty');
  const [view, setView] = useState<View>('card');
  const [checksOpen, setChecksOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [result, setResult] = useState<ModerationResult | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const running = status === 'loading' || status === 'streaming';

  const copyJson = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }, [result]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Only show the top bar's border once the page has scrolled off the top.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!checksOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChecksOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [checksOpen]);

  const setImage = useCallback((f: File | null | undefined) => {
    if (!f) return;
    setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
    setFile(f);
    setStatus('empty');
    setResult(null);
    setError(null);
  }, []);

  const clearImage = useCallback(() => {
    setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setFile(null);
    setStatus('empty');
    setResult(null);
    setError(null);
    setStreamText('');
  }, []);

  const loadSample = useCallback(async (src: string, name: string, sampleCaption: string) => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      setImage(new File([blob], name, { type: blob.type || 'image/jpeg' }));
      setCaption(sampleCaption);
    } catch {
      setError(`Couldn't load sample "${name}". Make sure it exists in /public/samples/.`);
      setStatus('error');
    }
  }, [setImage]);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setImage(e.dataTransfer.files?.[0]);
  }, [setImage]);

  const run = useCallback(async () => {
    if (!file || status === 'loading' || status === 'streaming') return;
    setStatus('loading');
    setError(null);
    setResult(null);
    setStreamText('');
    try {
      const body = new FormData();
      body.append('image', file);
      if (caption.trim()) body.append('caption', caption.trim());
      const res = await fetch('/api/moderate', { method: 'POST', body });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Request failed (${res.status}).`);
      }

      // Parse the Server-Sent Events stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? '';
        for (const block of blocks) {
          if (!block.trim()) continue;
          let event = 'message';
          let dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          let data: any;
          try { data = JSON.parse(dataStr); } catch { continue; }
          if (event === 'token') {
            acc += data.token ?? '';
            setStreamText(acc);
            setStatus('streaming');
          } else if (event === 'result') {
            setResult(data.result as ModerationResult);
            setLatencyMs(typeof data.latencyMs === 'number' ? data.latencyMs : null);
            setModel(typeof data.model === 'string' ? data.model : null);
            setView('card');
            setStatus('done');
          } else if (event === 'error') {
            throw new Error(data.error || 'Moderation failed.');
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }, [file, caption, status]);

  return (
    <div className="app">
      {/* TOP BAR */}
      <header className={`topbar${scrolled ? ' scrolled' : ''}`}>
        <div className="topbar-inner">
          <div className="brand">
            <img className="brand-mark" src="/logo.png" width="34" height="34" alt="" aria-hidden="true" />
            <span className="brand-title">Listing Moderator</span>
          </div>
          <nav className="topbar-actions">
            <button
              className={`gh-btn checks-btn${checksOpen ? ' active' : ''}`}
              onClick={() => setChecksOpen((v) => !v)}
              aria-label="What the moderator checks"
              aria-expanded={checksOpen}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <span>What's checked</span>
            </button>
            <a
              className="gh-btn"
              href="https://github.com/seclai/demos/tree/main/listing-moderator"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <span>GitHub</span>
            </a>
          </nav>
        </div>
      </header>

      {/* HERO */}
      <section className="hero">
        <div className="hero-bg" aria-hidden="true" />
        <div className="hero-inner">
          <h1 className="hero-title">Catch <span className="hero-em">bad listings</span><br />before buyers do</h1>
          <p className="hero-sub">Drop in a marketplace photo and get an answer in seconds. Plus clean, structured JSON your backend can act on.</p>
        </div>
      </section>

      {/* MAIN */}
      <main className="main">
        <div className="layout">
          {/* LEFT: INPUT */}
          <section className="panel input-panel">
            <div className="panel-head">
              <span className="panel-label">Input</span> 
            </div>

            <input ref={inputRef} type="file" accept={ACCEPT} hidden
              onChange={(e) => { setImage(e.target.files?.[0]); e.target.value = ''; }} />

            {previewUrl ? (
              <div className="preview">
                <div className="preview-img" style={{ backgroundImage: `url(${previewUrl})` }} />
                {running && (
                  <div className="scan" aria-hidden="true">
                    <div className="scan-tint" />
                    <div className="scan-line" />
                    <div className="scan-badge"><span className="scan-pulse" />scanning</div>
                  </div>
                )}
                {file && <div className="preview-name">{file.name}</div>}
                <button className="preview-clear" onClick={clearImage} aria-label="Remove image">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>
            ) : (
              <div
                className={`drop${dragOver ? ' over' : ''}`}
                role="button" tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                onDrop={onDrop}
              >
                <div className="drop-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4640E0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M8 8l4-4 4 4" /><path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" />
                  </svg>
                </div>
                <div className="drop-title">Drag a listing photo here</div>
                <div className="drop-sub">or <span className="drop-link">click to upload</span> · JPG or PNG</div>
              </div>
            )}

            <label className="field-label">Caption <span className="field-optional">(optional)</span></label>
            <input
              className="caption-input"
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="e.g. Vintage leather sofa, great condition"
            />
            <div className="field-helper">The agent cross-checks your caption against the photo — mismatches count against the listing as a stock/misleading violation.</div>

            <button className="run-btn" onClick={run} disabled={!file || running}>
              {running && <span className="run-spinner" />}
              <span>{running ? 'Moderating…' : 'Run moderation'}</span>
            </button>

            <div className="samples">
              <div className="samples-label">Or try a sample listing</div>
              <div className="samples-grid">
                {SAMPLES.map((s) => (
                  <button className="sample" key={s.src} onClick={() => loadSample(s.src, s.name, s.caption)} disabled={running}>
                    <span className="sample-thumb" style={{ backgroundImage: `url(${s.src})` }}>
                      <span className="sample-badge" style={{ background: s.badge }} />
                    </span>
                    <span className="sample-meta">
                      <span className="sample-name">{s.name}</span>
                      <span className="sample-tag">{s.tag}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* RIGHT: OUTPUT */}
          <section className="panel output-panel">
            <div className="output-header">
              <span className="panel-label">Output</span>
              <div className="tabs">
                <button className={`tab${view === 'card' ? ' active' : ''}`} onClick={() => setView('card')}>Card</button>
                <button className={`tab tab-mono${view === 'json' ? ' active' : ''}`} onClick={() => setView('json')}>JSON</button>
              </div>
            </div>

            <div className="output-body">
              {status === 'empty' && view === 'card' && (
                <div className="idle">
                  <div className="idle-icon">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#B4B4AA" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                  </div>
                  <div className="idle-title">Nothing moderated yet</div>
                  <p className="idle-sub">Upload a photo or pick a sample on the left. You'll get an answer, the policy checks that ran, and the raw JSON your backend would receive.</p>
                  <button className="checks-open-link" onClick={() => setChecksOpen(true)}>See everything the moderator checks →</button>
                </div>
              )}

              {status === 'empty' && view === 'json' && (
                <div className="json-empty">// run a moderation to see the response body</div>
              )}

              {running && view === 'card' && (
                <div className="running">
                  <div className="running-head">
                    <span className="running-spin" />
                    <div>
                      <div className="running-title">Moderating listing…</div>
                      <div className="running-sub">Running {CARD_CHECKS.length} policy checks on the image</div>
                    </div>
                  </div>
                  <div className="running-list">
                    {CARD_CHECKS.map((r, i) => (
                      <div className="run-check" key={r.rule} style={{ animationDelay: `${i * 90}ms` }}>
                        <span className="run-glyph" />
                        <span className="run-check-label">{r.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {running && view === 'json' && (
                <div className="json-dark">
                  <div className="json"><span className="json-line">{streamText}<span className="stream-caret" /></span></div>
                </div>
              )}

              {status === 'error' && (
                <div className="idle">
                  <div className="idle-icon error">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <div className="idle-title">Something went wrong</div>
                  <p className="idle-sub">{error}</p>
                </div>
              )}

              {status === 'done' && result && view === 'card' && (() => {
                const vm = VERDICT[result.decision];
                return (
                  <div className="card-view">
                    <div className="verdict" style={{ background: vm.bg, borderColor: vm.border }}>
                      <span className="verdict-icon" style={{ background: vm.color }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d={vm.glyph} /></svg>
                      </span>
                      <div className="verdict-body">
                        <div className="verdict-top">
                          <span className="verdict-label" style={{ color: vm.color }}>{vm.label}</span>
                          <span className="verdict-chip" style={{ color: vm.color, background: vm.chip }}>{pct(result.confidence)} confident</span>
                        </div>
                        <div className="verdict-sub">{vm.sub}</div>
                      </div>
                    </div>

                    <div className="checks-section">
                      <div className="section-label">Policy checks</div>
                      <div className="checks-list">
                        {CARD_CHECKS.map((r) => {
                          const v = result.violations.find((x) => x.rule === r.rule);
                          const failed = !!v;
                          return (
                            <div className="check-row" key={r.rule} style={{ background: failed ? '#FEF6F5' : undefined }}>
                              <span className="check-glyph" style={{ color: failed ? '#B91C1C' : '#15803D', background: failed ? '#FEE2E2' : '#DCFCE7' }}>
                                {failed ? '✕' : '✓'}
                              </span>
                              <div className="check-main">
                                <div className="check-top">
                                  <span className="check-label">{r.label}</span>
                                  <span className="check-status" style={{ color: failed ? '#B91C1C' : '#15803D' }}>{failed ? 'Failed' : 'Clear'}</span>
                                </div>
                                <div className="check-note">{failed ? v!.explanation : r.examples}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {status === 'done' && result && view === 'json' && (
                <div className="json-dark">
                  <button className="json-copy" onClick={copyJson} aria-label="Copy JSON">
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <JsonView data={result} />
                </div>
              )}
            </div>

            {status === 'done' && (
              <div className="output-footer">
                <div className="footer-meta">
                  <span className="ok"><span className="ok-dot" /><span className="ok-code">200</span> OK</span>
                  <span className="dot-sep">·</span>
                  <span>{latencyMs != null ? `${(latencyMs / 1000).toFixed(1)}s` : '—'}</span>
                  {model && (<><span className="dot-sep">·</span><span>{modelLabel(model)}</span></>)}
                </div>
                <button className="footer-clear" onClick={clearImage}>Clear</button>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="site-footer">
        <div className="site-footer-inner">
          <a
            className="site-footer-link"
            href="https://seclai.com"
            target="_blank"
            rel="noopener noreferrer"
            title="Learn more about Seclai"
          >
            Powered by Seclai
          </a>
        </div>
      </footer>

      {/* CHECKS DRAWER */}
      <div
        className={`drawer-backdrop${checksOpen ? ' open' : ''}`}
        onClick={() => setChecksOpen(false)}
        aria-hidden="true"
      />
      <aside className={`drawer${checksOpen ? ' open' : ''}`} role="dialog" aria-label="What the moderator checks" aria-modal={checksOpen}>
        <div className="drawer-head">
          <div>
            <div className="drawer-title">What the moderator checks</div>
            <div className="drawer-sub">A listing passes or fails based on the rules below.</div>
          </div>
          <button className="drawer-close" onClick={() => setChecksOpen(false)} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">
          <p className="drawer-legend">
            <strong>Fails</strong> if <strong>any</strong> of these are found. <strong>Passes</strong> if
            none are.
          </p>
          <div className="drawer-group">
            <div className="drawer-list">
              {RULES.map((r) => {
                const t = RULE_TIER[r.tier];
                return (
                  <div className="check" key={r.rule}>
                    <span className="check-tier" style={{ color: t.color, background: t.bg }}>{t.label}</span>
                    <div className="check-body">
                      <div className="check-top">
                        <span className="check-label">{r.label}</span>
                        <span className="check-id">{r.rule}</span>
                      </div>
                      <div className="check-examples">{r.examples}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
