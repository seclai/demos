// In-page player: finds the article text, sends it to Seclai in chunks, plays
// the returned audio, and highlights the word being read.
//
// Word timing: the TTS model returns no timestamps, so once a chunk's audio
// arrives we decode it and find the silent gaps. Sentence and paragraph ends
// are snapped to those gaps, and words in between are spread across the
// remaining speech by length. Drift resets at every pause.

(() => {
  if (window.__seclaiReadAloud) {
    window.__seclaiReadAloud.close();
    return;
  }

  const CHUNK_TARGET = 2500; // chars per Seclai run (TTS input limit is ~2k tokens)
  const CHUNK_MAX = 3200;
  const PARALLEL = 2;
  const CREDITS_PER_CHAR = 0.28; // rough, from a test run with gpt-4o-mini-tts
  const SKIP = 'nav,aside,footer,figure,figcaption,button,script,style,noscript,[aria-hidden="true"],[hidden]';
  const SENTENCE_END = /[.!?]["”’)\]]*$/;

  // ---------- Article extraction ----------

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function skipped(el, stop) {
    for (let n = el; n && n !== stop; n = n.parentElement) {
      if (n.matches(SKIP)) return true;
    }
    return false;
  }

  // Readability-style: the element whose paragraphs hold the most text wins.
  function findRoot() {
    const scores = new Map();
    for (const p of document.querySelectorAll('p')) {
      const len = p.textContent.trim().length;
      if (len < 40 || skipped(p, document.body) || !visible(p)) continue;
      const parent = p.parentElement;
      const grand = parent?.parentElement;
      if (parent) scores.set(parent, (scores.get(parent) || 0) + len);
      if (grand) scores.set(grand, (scores.get(grand) || 0) + len / 2);
    }
    let best = null;
    let bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) [best, bestScore] = [el, s];
    return best;
  }

  function collectBlocks(root) {
    let els = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')].filter(
      (el) => el.textContent.trim() && !skipped(el, root) && visible(el),
    );
    // Keep the innermost blocks only (e.g. the <p> inside a <blockquote>).
    els = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
    const h1 = document.querySelector('h1');
    if (h1 && !root.contains(h1) && visible(h1) && !skipped(h1, document.body)) els.unshift(h1);
    return els;
  }

  function wordsIn(block) {
    const words = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest('script,style,noscript,sup') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let node; (node = walker.nextNode()); ) {
      const re = /\S+/g;
      for (let m; (m = re.exec(node.data)); ) {
        const range = new Range();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        words.push({ text: m[0], range, block, t: 0 });
      }
    }
    return words;
  }

  // Group blocks into chunks of ~CHUNK_TARGET chars, splitting oversized
  // paragraphs at sentence ends.
  function buildChunks(blocks) {
    const chunks = [];
    let cur = { words: [], parts: [], len: 0 };
    const flush = () => {
      if (cur.words.length) chunks.push(cur);
      cur = { words: [], parts: [], len: 0 };
    };
    for (const words of blocks) {
      words[words.length - 1].blockEnd = true;
      let piece = [];
      let plen = 0;
      const emit = () => {
        if (!piece.length) return;
        const text = piece.map((w) => w.text).join(' ');
        if (cur.len && cur.len + text.length > CHUNK_TARGET) flush();
        cur.words.push(...piece);
        cur.parts.push(text);
        cur.len += text.length + 2;
        piece = [];
        plen = 0;
      };
      for (const w of words) {
        piece.push(w);
        plen += w.text.length + 1;
        if (plen > CHUNK_TARGET && (SENTENCE_END.test(w.text) || plen > CHUNK_MAX)) emit();
      }
      emit();
    }
    flush();
    return chunks.map((c, index) => {
      c.words.forEach((w) => (w.chunk = index));
      return { index, text: c.parts.join('\n\n'), words: c.words, status: 'pending', blob: null, url: null, duration: 0 };
    });
  }

  // ---------- Audio alignment (see align.js) ----------

  async function findGaps(blob) {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    return globalThis.__seclaiAlign.findGaps(buf.getChannelData(0), buf.sampleRate);
  }

  function alignWords(chunk, analysis) {
    globalThis.__seclaiAlign.alignWords(chunk.words, analysis);
    chunk.duration = analysis.duration;
  }

  // Fallback if decoding fails: spread words evenly by length.
  function alignEvenly(chunk, duration) {
    const total = chunk.words.reduce((s, w) => s + w.text.length + 1, 0);
    let acc = 0;
    for (const w of chunk.words) {
      w.t = (acc / total) * duration;
      acc += w.text.length + 1;
    }
    chunk.duration = duration;
  }

  // ---------- Seclai calls (via the service worker, which holds the key) ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(type, payload = {}) {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res) throw new Error('No response from the extension.');
    if (res.error) throw new Error(res.error);
    return res;
  }

  async function narrate(text, withVoice = voice) {
    const { runId } = await call('startRun', { text, voice: withVoice });
    const deadline = Date.now() + 6 * 60_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      if (closed) throw new Error('closed');
      const run = await call('getRun', { runId });
      if (run.status === 'completed') {
        const att = run.attachments.find((a) => a.mime?.startsWith('audio/'));
        if (!att) throw new Error('Run finished without an audio file.');
        const { base64, mime } = await call('download', { url: att.download_url });
        return base64ToBlob(base64, mime);
      }
      if (['failed', 'cancelled', 'canceled', 'error'].includes(run.status)) {
        throw new Error(`Seclai run ${run.status}.`);
      }
    }
    throw new Error('Timed out waiting for Seclai.');
  }

  function base64ToBlob(base64, mime = 'audio/mpeg') {
    return new Blob([Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))], { type: mime });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ---------- Saved audio ----------
  //
  // Each generated part is stored in extension storage, keyed by voice + a hash
  // of its exact text, so reopening the same article plays instantly (and a
  // half-finished article only generates the missing parts).

  const MAX_SAVED_PARTS = 100; // ~3 MB each stored (≈ 30–40 articles); least recently used are evicted

  // cyrb53: small, fast string hash (crypto.subtle isn't available on http pages).
  function hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const cacheKey = (c, v = voice) => `tts:${v}:${hash(c.text)}`;

  // Saves run one at a time so parallel parts don't clobber the shared index.
  let saveChain = Promise.resolve();
  const saveToCache = (c) => (saveChain = saveChain.then(() => doSave(c)));

  async function doSave(c) {
    try {
      const key = cacheKey(c);
      const { ttsIndex = {} } = await chrome.storage.local.get('ttsIndex');
      ttsIndex[key] = Date.now();
      const keys = Object.keys(ttsIndex).sort((a, b) => ttsIndex[a] - ttsIndex[b]);
      const evict = keys.slice(0, Math.max(0, keys.length - MAX_SAVED_PARTS));
      evict.forEach((k) => delete ttsIndex[k]);
      if (evict.length) await chrome.storage.local.remove(evict);
      await chrome.storage.local.set({ [key]: await blobToBase64(c.blob), ttsIndex });
    } catch (err) {
      console.warn('[read-aloud] could not save audio', err);
    }
  }

  // Load any saved parts for the current voice. Returns how many were found.
  let loadToken = 0;
  async function loadSaved() {
    const token = ++loadToken;
    const keys = chunks.map((c) => cacheKey(c));
    const saved = await chrome.storage.local.get([...keys, 'ttsIndex']);
    if (token !== loadToken || started) return;
    const ttsIndex = saved.ttsIndex || {};
    for (const [i, c] of chunks.entries()) {
      const b64 = saved[keys[i]];
      if (!b64) continue;
      c.blob = base64ToBlob(b64);
      await prepare(c);
      if (token !== loadToken) return;
      c.status = 'ready';
      ttsIndex[keys[i]] = Date.now();
    }
    chrome.storage.local.set({ ttsIndex });
    render();
  }

  function resetChunks() {
    for (const c of chunks) {
      if (c.url) URL.revokeObjectURL(c.url);
      Object.assign(c, { status: 'pending', blob: null, url: null, duration: 0, error: null });
    }
  }

  // Time-align words to a part's audio and make it playable.
  async function prepare(c) {
    try {
      alignWords(c, await findGaps(c.blob));
    } catch (err) {
      console.warn('[read-aloud] alignment failed, using even timing', err);
      alignEvenly(c, await blobDuration(c.blob));
    }
    c.url = URL.createObjectURL(c.blob);
  }

  async function generateAll() {
    const todo = chunks.filter((c) => c.status === 'pending');
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !closed) {
        const c = todo[next++];
        c.status = 'loading';
        render();
        try {
          c.blob = await narrate(c.text);
          await prepare(c);
          c.status = 'ready';
          saveToCache(c);
        } catch (err) {
          if (closed) return;
          c.status = 'error';
          c.error = err.message;
        }
        render();
        if (waitingFor && waitingFor.chunk === c.index) playChunk(c.index, waitingFor.time);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }

  function blobDuration(blob) {
    return new Promise((resolve) => {
      const a = new Audio(URL.createObjectURL(blob));
      a.addEventListener('loadedmetadata', () => resolve(a.duration || 0), { once: true });
      a.addEventListener('error', () => resolve(0), { once: true });
    });
  }

  // ---------- Voices + previews ----------

  const VOICES = {
    nova: 'Nova · female, warm',
    shimmer: 'Shimmer · female, soft',
    onyx: 'Onyx · male, deep',
  };
  const sampleText = (v) => {
    const name = v[0].toUpperCase() + v.slice(1);
    return `Hi, I'm ${name}. Pick me, and I'll read this article to you.`;
  };
  const sampleAudio = new Audio();
  let sampleLoading = false;

  // Samples are generated once per voice (a few credits) and cached in the extension.
  async function previewVoice() {
    if (!sampleAudio.paused) {
      sampleAudio.pause();
      return render();
    }
    const key = `sample_${voice}`;
    try {
      let { [key]: b64 } = await chrome.storage.local.get(key);
      if (!b64) {
        sampleLoading = true;
        render();
        b64 = await blobToBase64(await narrate(sampleText(voice)));
        await chrome.storage.local.set({ [key]: b64 });
      }
      if (sampleAudio.src) URL.revokeObjectURL(sampleAudio.src);
      sampleAudio.src = URL.createObjectURL(base64ToBlob(b64));
      await sampleAudio.play();
    } catch (err) {
      if (!closed) setStatus(`Preview failed: ${err.message}`);
    } finally {
      sampleLoading = false;
      render();
    }
  }
  sampleAudio.addEventListener('ended', () => render());

  // ---------- Playback + highlighting ----------

  const audio = new Audio();
  let chunks = [];
  let allWords = [];
  let current = -1; // chunk index loaded in <audio>
  let waitingFor = null; // { chunk, time } when playback is blocked on generation
  let speed = 1;
  let voice = 'nova';
  let follow = true;
  let lastWord = null;
  let lastBlock = null;
  let closed = false;
  let started = false;
  let finished = false;
  let dragging = false;
  let dragTime = 0;
  const canHighlight = 'highlights' in CSS;

  function playChunk(i, time = 0) {
    const c = chunks[i];
    if (!c) return;
    if (c.status === 'error') return playChunk(i + 1, 0); // skip a failed part rather than stall
    if (c.status !== 'ready') {
      waitingFor = { chunk: i, time };
      audio.pause();
      render();
      return;
    }
    waitingFor = null;
    finished = false;
    lastWord = null;
    const start = () => {
      audio.currentTime = Math.max(0, Math.min(time, (audio.duration || c.duration) - 0.05));
      audio.playbackRate = speed;
      audio.play().catch(() => setStatus('Press play to start listening.'));
    };
    if (current !== i) {
      current = i;
      audio.src = c.url;
      audio.addEventListener('loadedmetadata', start, { once: true });
    } else {
      start();
    }
    render();
  }

  audio.addEventListener('play', () => {
    sampleAudio.pause();
    render();
    requestAnimationFrame(tick);
  });
  audio.addEventListener('pause', render);
  audio.addEventListener('ended', () => {
    if (current + 1 < chunks.length) playChunk(current + 1, 0);
    else {
      finished = true;
      clearHighlights();
      render();
    }
  });
  audio.addEventListener('error', () => {
    if (audio.getAttribute('src')) setStatus('This site blocked audio playback. Use download instead.');
  });

  function tick() {
    if (closed || audio.paused) return;
    highlight(wordAt(chunks[current].words, audio.currentTime));
    renderProgress();
    requestAnimationFrame(tick);
  }

  // Last word that has started by `time`.
  function wordAt(words, time) {
    let lo = 0;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (words[mid].t <= time) lo = mid;
      else hi = mid - 1;
    }
    return words[lo];
  }

  function highlight(w) {
    if (!canHighlight || w === lastWord) return;
    lastWord = w;
    CSS.highlights.set('seclai-word', new Highlight(w.range));
    if (w.block !== lastBlock) {
      lastBlock = w.block;
      const r = new Range();
      r.selectNodeContents(w.block);
      CSS.highlights.set('seclai-block', new Highlight(r));
    }
    if (follow) {
      const rect = w.range.getBoundingClientRect();
      if (rect.top < 80 || rect.bottom > innerHeight - 220) {
        scrollBy({ top: rect.top - innerHeight * 0.35, behavior: 'smooth' });
      }
    }
  }

  function clearHighlights() {
    if (!canHighlight) return;
    CSS.highlights.delete('seclai-word');
    CSS.highlights.delete('seclai-block');
    lastWord = lastBlock = null;
  }

  // ---------- One continuous timeline across all parts ----------

  // Parts not generated yet get an estimated length (from the parts we have,
  // or ~15 chars/sec before any exist); estimates firm up as parts arrive.
  function timeline() {
    const known = chunks.filter((c) => c.duration);
    const secPerChar = known.length
      ? known.reduce((a, c) => a + c.duration, 0) / known.reduce((a, c) => a + c.text.length, 0)
      : 1 / 15;
    let acc = 0;
    const starts = chunks.map((c) => {
      const s = acc;
      acc += c.duration || c.text.length * secPerChar;
      return s;
    });
    return { starts, total: acc };
  }

  function position() {
    const { starts } = timeline();
    if (dragging) return dragTime;
    if (waitingFor) return starts[waitingFor.chunk] + waitingFor.time;
    if (current >= 0) return starts[current] + audio.currentTime;
    return 0;
  }

  function seekTo(t) {
    const { starts, total } = timeline();
    t = Math.max(0, Math.min(t, total - 0.05));
    let i = 0;
    while (i + 1 < chunks.length && starts[i + 1] <= t) i++;
    finished = false;
    if (current === i && chunks[i].status === 'ready') {
      // Same part: just move the playhead (and stay paused if paused).
      audio.currentTime = t - starts[i];
      lastWord = null;
      highlight(wordAt(chunks[i].words, t - starts[i]));
    } else {
      playChunk(i, t - starts[i]);
    }
    render();
  }

  // Click any word in the article to jump there (links still work normally).
  function onWordClick(e) {
    if (!started || e.composedPath().includes(host)) return;
    if (e.target.closest?.('a,button,input,textarea,select,label,[contenteditable]')) return;
    if (!getSelection().isCollapsed) return; // user is selecting text
    let node;
    let offset;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) [node, offset] = [pos.offsetNode, pos.offset];
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) [node, offset] = [r.startContainer, r.startOffset];
    }
    if (!node) return;
    const w = allWords.find((x) => x.range.isPointInRange(node, offset));
    if (!w) return;
    playChunk(w.chunk, w.t);
  }
  document.addEventListener('click', onWordClick, true);

  // ---------- UI (shadow DOM so page styles can't leak in) ----------

  const svg = (body, size = 18) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>', 22),
    pause: svg('<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" stroke="none"/>', 22),
    playSm: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>', 14),
    stopSm: svg('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>', 14),
    back: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><text x="12.5" y="15.5" font-size="7.5" font-family="system-ui" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">15</text>', 22),
    fwd: svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><text x="11.5" y="15.5" font-size="7.5" font-family="system-ui" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">15</text>', 22),
    download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    wave: svg('<path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3"/>'),
  };

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      /* Seclai brand: deep purple primary, amber accent, warm stone neutrals. */
      :host {
        --bg: #1c1917; --surface: #292524; --line: #44403c; --muted: #a8a29e; --text: #fafaf9;
        --purple: #581c87; --purple-2: #7e22ce; --purple-light: #c084fc; --purple-pale: #e9d8ff;
        --amber: #f59e0b; --amber-light: #fbbf24;
      }
      [hidden] { display: none !important; }
      .panel { font: 13px/1.4 -apple-system, system-ui, sans-serif; color: var(--text); background: var(--bg);
               border: 1px solid var(--surface); border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
               padding: 14px 16px 12px; width: 320px; box-sizing: border-box; }
      .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
      .title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
      .logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, var(--purple-2), var(--purple));
              display: inline-flex; align-items: center; justify-content: center; color: var(--amber-light); }
      .logo svg { width: 14px; height: 14px; }
      button { font: inherit; color: var(--text); background: none; border: 0; border-radius: 50%; cursor: pointer;
               display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; }
      button:hover:not(:disabled) { background: var(--surface); }
      button:disabled { opacity: .35; cursor: default; }
      .x { width: 26px; height: 26px; color: var(--muted); }
      select { font: inherit; font-size: 12px; font-weight: 600; color: var(--text); background: var(--surface);
               border: 1px solid var(--line); border-radius: 8px; padding: 5px 6px; cursor: pointer; }

      .status { display: flex; align-items: center; gap: 8px; color: var(--muted); min-height: 18px; margin-bottom: 10px; }
      .status:empty, .status.blank { display: none; }
      .spinner { width: 13px; height: 13px; border: 2px solid var(--line); border-top-color: var(--purple-light);
                 border-radius: 50%; animation: spin .8s linear infinite; flex: none; }
      @keyframes spin { to { transform: rotate(360deg); } }

      .voice { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--muted); }
      .voice select { flex: 1; padding: 7px 8px; font-weight: 500; }
      .preview { width: auto; height: 32px; border-radius: 8px; padding: 0 10px; gap: 6px; font-size: 12px;
                 font-weight: 600; background: var(--surface); border: 1px solid var(--line); }
      .preview .spinner { width: 11px; height: 11px; }
      .generate { width: 100%; height: 42px; border-radius: 10px; color: #fff; font-weight: 600; gap: 8px;
                  background: linear-gradient(135deg, var(--purple-2), var(--purple)); }
      .generate:hover:not(:disabled) { background: linear-gradient(135deg, #9333ea, var(--purple-2)); }

      .scrub { padding: 8px 0; cursor: pointer; touch-action: none; }
      .track { position: relative; height: 5px; border-radius: 3px; background: var(--line); }
      .buffered { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: #57534e; }
      .loading { position: absolute; top: 0; bottom: 0; right: 0; border-radius: 3px; overflow: hidden; }
      .loading::after { content: ''; position: absolute; inset: 0; width: 60px;
                        background: linear-gradient(90deg, transparent, rgba(192,132,252,.55), transparent);
                        animation: sweep 1.3s ease-in-out infinite; }
      @keyframes sweep { from { transform: translateX(-60px); } to { transform: translateX(320px); } }
      .played { position: absolute; inset: 0 auto 0 0; border-radius: 3px;
                background: linear-gradient(90deg, var(--purple-2), var(--purple-light)); }
      .knob { position: absolute; top: 50%; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%;
              background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.5), 0 0 0 3px rgba(192,132,252,.35);
              transition: transform .1s; }
      .scrub:hover .knob, .scrub.dragging .knob { transform: scale(1.2); }
      .times { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted);
               font-variant-numeric: tabular-nums; margin-bottom: 4px; }

      .controls { display: flex; align-items: center; justify-content: space-between; }
      .main { display: flex; align-items: center; gap: 4px; }
      .play { width: 46px; height: 46px; color: #fff; background: linear-gradient(135deg, var(--purple-2), var(--purple)); }
      .play:hover:not(:disabled) { background: linear-gradient(135deg, #9333ea, var(--purple-2)); }
      .side { display: flex; align-items: center; gap: 2px; }
      .top { cursor: grab; user-select: none; touch-action: none; margin: -14px -16px 10px; padding: 14px 16px 0; }
      .top.moving { cursor: grabbing; }
      .grip { color: #57534e; font-size: 11px; letter-spacing: -1px; margin-left: 2px; }
      .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 10px;
              padding-top: 10px; border-top: 1px solid var(--surface); }
      .switch { width: auto; height: auto; border-radius: 6px; padding: 2px 4px; gap: 8px; font-size: 12px;
                color: var(--muted); }
      .switch .sw { width: 28px; height: 16px; border-radius: 8px; background: var(--line); position: relative;
                    transition: background .15s; flex: none; }
      .switch .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
                           border-radius: 50%; background: #d6d3d1; transition: transform .15s; }
      .switch.on { color: var(--text); }
      .switch.on .sw { background: var(--purple-2); }
      .switch.on .sw::after { transform: translateX(12px); background: #fff; }
      .hint { color: #78716c; font-size: 11px; }
    </style>
    <div class="panel">
      <div class="top">
        <span class="title" title="Drag to move · double-click to reset"><span class="logo">${ICONS.wave}</span>Read Aloud<span class="grip">⋮⋮</span></span>
        <button class="x" data-a="close" title="Close">${ICONS.close}</button>
      </div>
      <div class="status"><span class="spinner" hidden></span><span class="msg"></span></div>
      <div class="setup">
        <div class="voice">
          <select data-a="voice" title="Voice">
            ${Object.entries(VOICES).map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}
          </select>
          <button class="preview" data-a="preview" title="Hear a sample of this voice"></button>
        </div>
        <button class="generate" data-a="start">${ICONS.wave}Generate audio</button>
      </div>
      <div class="player" hidden>
        <div class="scrub"><div class="track">
          <div class="buffered"></div><div class="loading" hidden></div><div class="played"></div><div class="knob"></div>
        </div></div>
        <div class="times"><span class="cur">0:00</span><span class="tot">0:00</span></div>
        <div class="controls">
          <div class="main">
            <button data-a="back" title="Back 15 seconds">${ICONS.back}</button>
            <button class="play" data-a="play" title="Play / pause">${ICONS.play}</button>
            <button data-a="fwd" title="Forward 15 seconds">${ICONS.fwd}</button>
          </div>
          <div class="side">
            <select data-a="speed" title="Playback speed">
              <option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option>
              <option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option>
              <option value="2">2×</option>
            </select>
            <button data-a="download" title="Download MP3">${ICONS.download}</button>
          </div>
        </div>
        <div class="foot">
          <button class="switch on" data-a="follow" role="switch" aria-checked="true"
                  title="Scroll the page to keep the word being read on screen"><span class="sw"></span>Auto-scroll</button>
          <span class="hint">Click any word to jump there</span>
        </div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = (sel) => shadow.querySelector(sel);
  let statusOverride = null;

  // ---------- Moving the player ----------
  //
  // Drag the header to move it; the spot is remembered across pages.
  // Double-click the header to put it back in the bottom-right corner.

  const DEFAULT_POS = 'right:20px;bottom:20px;left:auto;top:auto;';
  const placeAt = (left, top) => {
    const r = host.getBoundingClientRect();
    left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
    top = Math.max(8, Math.min(top, innerHeight - r.height - 8));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = host.style.bottom = 'auto';
    return { left, top };
  };
  let saved = null;
  chrome.storage.local.get('playerPos').then(({ playerPos }) => {
    if (playerPos && !closed) saved = placeAt(playerPos.left, playerPos.top);
  });
  addEventListener('resize', () => saved && placeAt(saved.left, saved.top));

  const header = $('.top');
  let grab = null;
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = host.getBoundingClientRect();
    grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    header.setPointerCapture(e.pointerId);
    header.classList.add('moving');
  });
  header.addEventListener('pointermove', (e) => {
    if (grab) saved = placeAt(e.clientX - grab.dx, e.clientY - grab.dy);
  });
  const drop = () => {
    if (!grab) return;
    grab = null;
    header.classList.remove('moving');
    if (saved) chrome.storage.local.set({ playerPos: saved });
  };
  header.addEventListener('pointerup', drop);
  header.addEventListener('pointercancel', drop);
  header.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    saved = null;
    host.style.cssText += DEFAULT_POS;
    chrome.storage.local.remove('playerPos');
  });

  function setStatus(msg) {
    statusOverride = msg;
    render();
  }

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function renderProgress() {
    if (!started) return;
    const { starts, total } = timeline();
    const pos = position();
    const pct = (t) => `${total ? Math.min(100, (t / total) * 100) : 0}%`;
    // "Buffered" = the run of finished parts from the start.
    const firstPending = chunks.findIndex((c) => c.status === 'pending' || c.status === 'loading');
    const bufferedEnd = firstPending < 0 ? total : starts[firstPending];
    $('.buffered').style.width = pct(bufferedEnd);
    $('.loading').hidden = firstPending < 0;
    $('.loading').style.left = pct(bufferedEnd);
    $('.played').style.width = pct(pos);
    $('.knob').style.left = pct(pos);
    $('.cur').textContent = fmt(pos);
    $('.tot').textContent = (firstPending < 0 ? '' : '~') + fmt(total);
  }

  function render() {
    if (closed) return;
    const ready = chunks.filter((c) => c.status === 'ready').length;
    const failed = chunks.filter((c) => c.status === 'error');

    $('.setup').hidden = started;
    $('.player').hidden = !started;
    $('.play').innerHTML = audio.paused ? ICONS.play : ICONS.pause;
    $('.play').disabled = !ready && !waitingFor;
    $('[data-a=back]').disabled = current < 0;
    $('[data-a=fwd]').disabled = current < 0;
    const allDone = ready > 0 && ready + failed.length === chunks.length;
    $('[data-a=download]').disabled = chunks[0]?.status !== 'ready';
    $('[data-a=download]').title = allDone ? 'Download MP3' : 'Download MP3 (what has been generated so far)';
    const allSaved = chunks.length > 0 && ready === chunks.length;
    $('.generate').innerHTML = allSaved ? `${ICONS.playSm}Play saved audio` : `${ICONS.wave}Generate audio`;
    $('.switch').classList.toggle('on', follow);
    $('.switch').setAttribute('aria-checked', String(follow));
    $('.preview').innerHTML = sampleLoading
      ? '<span class="spinner"></span>Preview'
      : `${sampleAudio.paused ? ICONS.playSm : ICONS.stopSm}Preview`;
    $('.preview').disabled = sampleLoading;

    let msg = '';
    let spin = false;
    if (statusOverride) msg = statusOverride;
    else if (!started) {
      const chars = chunks.filter((c) => c.status !== 'ready').reduce((a, c) => a + c.text.length, 0);
      const mins = Math.max(1, Math.round(allWords.length / 160));
      const cost = allSaved
        ? 'saved · no credits'
        : ready
          ? `${ready}/${chunks.length} saved · ~${Math.round(chars * CREDITS_PER_CHAR).toLocaleString()} credits for the rest`
          : `~${Math.round(chars * CREDITS_PER_CHAR).toLocaleString()} credits`;
      msg = sampleLoading
        ? 'Making a voice sample…'
        : `${allWords.length.toLocaleString()} words · ~${mins} min · ${cost}`;
      spin = sampleLoading;
    } else if (failed.length) msg = `Part ${failed[0].index + 1} failed: ${failed[0].error}`;
    else if (waitingFor) {
      msg = current < 0 ? 'Generating audio…' : 'Generating this part…';
      spin = true;
    } else if (finished) msg = 'Finished';
    $('.msg').textContent = msg;
    $('.spinner').hidden = !spin;
    $('.status').classList.toggle('blank', !msg);
    renderProgress();
  }

  // Scrubber: drag (or click) anywhere on the bar to move the playhead.
  const scrub = $('.scrub');
  const timeAt = (x) => {
    const r = $('.track').getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * timeline().total;
  };
  scrub.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragTime = timeAt(e.clientX);
    scrub.setPointerCapture(e.pointerId);
    scrub.classList.add('dragging');
    renderProgress();
  });
  scrub.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragTime = timeAt(e.clientX);
    renderProgress();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    scrub.classList.remove('dragging');
    seekTo(timeAt(e.clientX));
  };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', () => {
    dragging = false;
    scrub.classList.remove('dragging');
    renderProgress();
  });

  shadow.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a && a !== 'close') statusOverride = null;
    if (a === 'close') close();
    else if (a === 'preview') previewVoice();
    else if (a === 'start') {
      sampleAudio.pause();
      started = true;
      loadToken++; // ignore any saved-audio load still in flight
      for (const c of chunks) if (c.status === 'loading') c.status = 'pending';
      playChunk(0, 0); // plays now if saved, otherwise waits for generation
      if (chunks.some((c) => c.status === 'pending')) generateAll();
    } else if (a === 'play') {
      if (!audio.paused) audio.pause();
      else if (waitingFor) render();
      else if (current < 0 || finished) {
        seekTo(0);
        audio.play().catch(() => {});
      } else audio.play();
    } else if (a === 'back') seekTo(position() - 15);
    else if (a === 'fwd') seekTo(position() + 15);
    else if (a === 'follow') {
      follow = !follow;
      render();
    } else if (a === 'download') download();
  });
  shadow.addEventListener('change', (e) => {
    if (e.target.dataset.a === 'speed') {
      speed = Number(e.target.value);
      audio.playbackRate = speed;
    } else if (e.target.dataset.a === 'voice') {
      voice = e.target.value;
      sampleAudio.pause();
      chrome.storage.local.set({ voice });
      resetChunks();
      render();
      loadSaved();
    }
  });

  async function download() {
    // Take the unbroken run of finished parts from the start (no gaps in the
    // audio). MP3 frames concatenate cleanly, so parts join byte-for-byte.
    const parts = [];
    for (const c of chunks) {
      if (c.status === 'ready') parts.push(c);
      else if (c.status !== 'error') break;
    }
    if (!parts.length) return;
    const blob = new Blob(parts.map((c) => c.blob), { type: 'audio/mpeg' });
    const name = (document.title || 'article').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'article';
    const partial = parts.at(-1).index < chunks.length - 1;
    try {
      setStatus('Preparing download…');
      await call('saveFile', { base64: await blobToBase64(blob), filename: `${name}.mp3` });
      setStatus(
        partial
          ? `Saved part 1–${parts.at(-1).index + 1} of ${chunks.length} to Downloads (the rest is still generating).`
          : 'Saved to your Downloads folder.',
      );
    } catch (err) {
      setStatus(`Download failed: ${err.message}`);
    }
  }

  function close() {
    closed = true;
    audio.pause();
    sampleAudio.pause();
    audio.removeAttribute('src');
    clearHighlights();
    document.removeEventListener('click', onWordClick, true);
    chunks.forEach((c) => c.url && URL.revokeObjectURL(c.url));
    host.remove();
    delete window.__seclaiReadAloud;
  }

  window.__seclaiReadAloud = { close };

  // ---------- Init ----------

  const root = findRoot();
  const blocks = root ? collectBlocks(root).map(wordsIn).filter((w) => w.length) : [];
  if (!blocks.length) {
    $('.setup').hidden = true;
    $('.msg').textContent = "Couldn't find article text on this page.";
    return;
  }
  chunks = buildChunks(blocks);
  allWords = chunks.flatMap((c) => c.words);
  render();

  // Restore the last voice picked, then any audio saved for this article.
  chrome.storage.local.get('voice').then((s) => {
    if (s.voice && VOICES[s.voice]) $('[data-a=voice]').value = voice = s.voice;
    loadSaved();
  });
})();
