// Word timing for narrated audio that comes back without timestamps.
//
// 1. findGaps: find silent stretches in the decoded audio.
// 2. alignWords: match sentence/paragraph ends to those silences, choosing the
//    matching for the whole part at once (dynamic programming) so one wrong
//    pick can't throw off everything after it. Words between matched pauses
//    are spread over the remaining speech by length.
//
// Loaded before content.js; also runs under Node for tests.

(() => {
  const SENTENCE_END = /[.!?]["”’)\]]*$/;
  const FRAME = 0.02; // seconds per analysis frame
  const MIN_GAP = 0.12; // shortest silence that counts as a pause
  const SKIP_COST = 4; // cost of leaving a sentence end unmatched
  const MAX_LOOKBACK = 6; // sentences that can be skipped between matches

  // Silent gaps in mono samples, as [{start, end}] in seconds.
  function findGaps(data, sampleRate) {
    const hop = Math.round(sampleRate * FRAME);
    const rms = [];
    for (let i = 0; i + hop <= data.length; i += hop) {
      let s = 0;
      for (let j = i; j < i + hop; j++) s += data[j] * data[j];
      rms.push(Math.sqrt(s / hop));
    }
    const duration = data.length / sampleRate;
    const sorted = [...rms].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
    const loud = sorted[Math.floor(sorted.length * 0.7)] || 0;
    const threshold = floor + 0.12 * (loud - floor);
    const gaps = [];
    let start = -1;
    for (let i = 0; i <= rms.length; i++) {
      const quiet = i < rms.length && rms[i] < threshold;
      if (quiet && start < 0) start = i;
      else if (!quiet && start >= 0) {
        if ((i - start) * FRAME >= MIN_GAP) gaps.push({ start: start * FRAME, end: Math.min(i * FRAME, duration) });
        start = -1;
      }
    }
    return { duration, gaps };
  }

  // Sets w.t (start time, seconds) on each word. Words need .text and
  // optionally .blockEnd (last word of a paragraph).
  function alignWords(words, { duration, gaps }, opts = {}) {
    const skipCost = opts.skipCost ?? SKIP_COST;
    const varBase = opts.varBase ?? 0.05; // tuned on synthetic speech with known timings
    const varRate = opts.varRate ?? 0.05;
    const fitWeight = opts.fitWeight ?? 6;
    const eps = 0.01;
    const starts = [];
    let pos = 0;
    for (const w of words) {
      starts.push(pos);
      pos += w.text.length + 1;
    }
    const total = pos;
    const t0 = gaps[0] && gaps[0].start <= eps ? gaps[0].end : 0;
    const last = gaps[gaps.length - 1];
    const tN = last && last.end >= duration - eps ? last.start : duration;
    const inner = gaps.filter((g) => g.start > t0 + eps && g.end < tN - eps);

    // Speech clock: seconds of non-silent audio between t0 and t.
    const speechAt = (t) => {
      let s = t - t0;
      for (const g of inner) {
        if (g.end <= t) s -= g.end - g.start;
        else if (g.start < t) s -= t - g.start;
      }
      return s;
    };
    const S = speechAt(tN);
    const rate = S / total; // speaking seconds per character

    const B = [];
    for (let i = 0; i < words.length - 1; i++) {
      const w = words[i];
      if (w.blockEnd || SENTENCE_END.test(w.text)) {
        B.push({ endChar: starts[i] + w.text.length, nextChar: starts[i + 1], para: !!w.blockEnd });
      }
    }
    const G = inner.map((g) => ({ ...g, sc: speechAt(g.start), len: g.end - g.start }));

    // Cost of the speech between two matched points, given how many chars it
    // holds. Variance grows with length since speaking rate drifts.
    const span = (c0, s0, c1, s1) => {
      const expected = rate * (c1 - c0);
      const actual = s1 - s0;
      if (actual <= 0) return Infinity;
      const err = actual - expected;
      return (err * err) / (varBase + varRate * expected);
    };
    // Paragraph breaks should land on longer pauses than sentence breaks.
    const fit = (b, g) => (b.para ? Math.max(0, 0.45 - g.len) : Math.max(0, 0.2 - g.len)) * fitWeight;

    const n = B.length;
    const m = G.length;
    // best[k][j]: lowest cost with boundary k matched to gap j (and the chain before it).
    const best = Array.from({ length: n }, () => new Float64Array(m).fill(Infinity));
    const prev = Array.from({ length: n }, () => new Int32Array(m * 2).fill(-1));
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < m; j++) {
        const own = fit(B[k], G[j]);
        // From the start of the part, skipping boundaries 0..k-1.
        let bestCost = skipCost * k + span(0, 0, B[k].nextChar, G[j].sc) + own;
        let bk = -1;
        let bj = -1;
        for (let k2 = Math.max(0, k - MAX_LOOKBACK); k2 < k; k2++) {
          for (let j2 = 0; j2 < j; j2++) {
            const base = best[k2][j2];
            if (base === Infinity) continue;
            const c = base + skipCost * (k - k2 - 1) + span(B[k2].nextChar, G[j2].sc, B[k].nextChar, G[j].sc) + own;
            if (c < bestCost) [bestCost, bk, bj] = [c, k2, j2];
          }
        }
        best[k][j] = bestCost;
        prev[k][j * 2] = bk;
        prev[k][j * 2 + 1] = bj;
      }
    }
    // Close out at the end of the part.
    let endCost = skipCost * n + span(0, 0, total, S);
    let ek = -1;
    let ej = -1;
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < m; j++) {
        if (best[k][j] === Infinity) continue;
        const c = best[k][j] + skipCost * (n - 1 - k) + span(B[k].nextChar, G[j].sc, total, S);
        if (c < endCost) [endCost, ek, ej] = [c, k, j];
      }
    }
    const matched = [];
    for (let k = ek, j = ej; k >= 0; ) {
      matched.unshift([k, j]);
      [k, j] = [prev[k][j * 2], prev[k][j * 2 + 1]];
    }

    const anchors = [[0, t0]];
    for (const [k, j] of matched) {
      anchors.push([B[k].endChar, G[j].start]);
      anchors.push([B[k].nextChar, G[j].end]);
    }
    anchors.push([total, tN]);

    // Between anchors, spread chars over speaking time, skipping silences.
    const mapper = (ta, tb) => {
      const segs = [];
      let cur = ta;
      for (const g of inner) {
        if (g.end <= ta || g.start >= tb) continue;
        if (g.start > cur) segs.push([cur, g.start]);
        cur = Math.max(cur, g.end);
      }
      if (tb > cur) segs.push([cur, tb]);
      const speech = segs.reduce((a, [s, e]) => a + e - s, 0);
      return (f) => {
        let rem = f * speech;
        for (const [s, e] of segs) {
          if (rem <= e - s) return s + rem;
          rem -= e - s;
        }
        return tb;
      };
    };

    let a = 0;
    let map = mapper(anchors[0][1], anchors[1][1]);
    for (let i = 0; i < words.length; i++) {
      const c = starts[i];
      let moved = false;
      while (a < anchors.length - 2 && anchors[a + 1][0] <= c) {
        a++;
        moved = true;
      }
      if (moved) map = mapper(anchors[a][1], anchors[a + 1][1]);
      const [ca, ta] = anchors[a];
      const [cb] = anchors[a + 1];
      words[i].t = cb > ca ? map((c - ca) / (cb - ca)) : ta;
    }
    return { matched: matched.length, boundaries: n, gaps: m };
  }

  const api = { findGaps, alignWords, SENTENCE_END };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.__seclaiAlign = api;
})();
