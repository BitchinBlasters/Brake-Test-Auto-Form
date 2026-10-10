/*
 * Brake Test Recorder — core logic (no DOM).
 * Machine limits, slip reading, pair checks and filling the record sheet.
 * Works in the browser (window.BTR) and in Node (module.exports) for testing.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------
   * MACHINE LIMITS
   * Source: WHC-BWM-SPC-Brake Testing Performance Criteria, Issue 3.1
   * (18 March 2026). Edit this table when the sheet is revised.
   *   svc  = service brake:   [min speed, max speed, max response s, unladen %, laden %]
   *   sec  = secondary brake: [max speed (must be below), max response s, unladen %, laden %]
   *          null = no secondary test for this machine (N/A on the form)
   * ------------------------------------------------------------------ */
  const CRITERIA = { name: 'WHC-BWM-SPC Brake Testing Performance Criteria', issue: '3.1', date: '18 March 2026' };

  const MACHINE_TABLE = [
    // type,           model,        make,      svc,                         sec
    ['Rear Dump',     '930E-5',     'Komatsu', [15, 20, 2, 36.9, 25.8],     null],
    ['Rear Dump',     '930E-4',     'Komatsu', [15, 20, 2, 38.6, 28.7],     null],
    ['Rear Dump',     '830E-5',     'Komatsu', [15, 20, 2, 30.5, 26.0],     null],
    ['Rear Dump',     '793D FDB',   'CAT',     [15, 32, 2, 28.6, 20.1],     [20, 3, 20.8, 15.2]],
    ['Water Truck',   '789D SPD',   'CAT',     [15, 32, 2, 26.9, 19.5],     [20, 3, 18.1, 14.2]],
    ['Water Truck',   '785D MSY',   'CAT',     [15, 32, 2, 30.6, 25.6],     [20, 3, 20.6, 15.0]],
    ['Service Truck', '775F DLS',   'CAT',     [15, 32, 2, 23.2, 19.0],     [20, 3, 24.8, 13.5]],
    ['Service Truck', '775G T5W',   'CAT',     [15, 32, 2, 26.4, 25.7],     [20, 3, 23.9, 24.4]],
    ['Float',         '797B JSM',   'CAT',     [15, 32, 2, 25.9, 19.8],     [20, 3, 19.1, 16.2]],
    ['Float',         '793D FDB',   'CAT',     [15, 32, 2, 23.7, 12.5],     [20, 3, 15.5, 8.4]],
    ['Float',         '793C ATY',   'CAT',     [15, 32, 2, 26.6, 10.1],     [20, 3, 15.6, 8.7]],
    ['Float',         '777F JRP',   'CAT',     [15, 32, 2, 23.5, 19.0],     [20, 3, 17.7, 14.5]],
    ['Belly Dump',    'CH200 CIII', '',        [15, 32, 2, 25.0, 19.0],     [20, 3, 17.9, 13.5]],
    ['Belly Dump',    'CH200 CII',  '',        [15, 32, 2, 26.0, 20.2],     null],
  ];

  const MACHINES = MACHINE_TABLE.map(([type, model, make, svc, sec]) => {
    const parts = model.split(' ');
    const serialCode = make === 'CAT' && parts.length > 1 ? parts[1] : '';
    const baseModel = make === 'CAT' ? parts[0] : model;
    return {
      id: (type + '-' + model).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      type, model, make, serialCode,
      description: [make, baseModel, type].filter(Boolean).join(' '),
      service: { speedMin: svc[0], speedMax: svc[1], speedBelow: false, resp: svc[2], unladen: svc[3], laden: svc[4] },
      secondary: sec ? { speedMin: null, speedMax: sec[0], speedBelow: true, resp: sec[1], unladen: sec[2], laden: sec[3] } : null,
    };
  });

  const TESTS = [
    { key: 'svcUL', brake: 'service',   load: 'unladen', label: 'Service brake', sub: 'Unladen' },
    { key: 'svcL',  brake: 'service',   load: 'laden',   label: 'Service brake', sub: 'Laden' },
    { key: 'secUL', brake: 'secondary', load: 'unladen', label: 'Secondary brake', sub: 'Unladen' },
    { key: 'secL',  brake: 'secondary', load: 'laden',   label: 'Secondary brake', sub: 'Laden' },
  ];

  function machineById(id) { return MACHINES.find(m => m.id === id) || null; }

  function machinesForSerial(serial) {
    const s = String(serial || '').toUpperCase().replace(/\s+/g, '');
    if (s.length < 3) return [];
    return MACHINES.filter(m => m.serialCode && s.startsWith(m.serialCode));
  }

  /** Limits for one test on one machine, or null when that test is N/A. */
  function limitsFor(machine, testKey) {
    if (!machine) return null;
    const t = TESTS.find(x => x.key === testKey);
    const b = machine[t.brake];
    if (!b) return null;
    return {
      min: b[t.load], resp: b.resp,
      speedMin: b.speedMin, speedMax: b.speedMax, speedBelow: b.speedBelow,
    };
  }

  function speedRangeText(l) {
    if (!l) return '';
    return l.speedBelow ? `under ${l.speedMax} km/h` : `${l.speedMin}–${l.speedMax} km/h`;
  }

  /* ------------------------------------------------------------------
   * READING SLIPS FROM OCR WORDS
   * words: [{text, conf, x0, y0, x1, y1}] in image pixels (y down)
   * ------------------------------------------------------------------ */

  const FIELDS = [
    { key: 'testNo',      name: 'Test number',  unit: '',     lo: 1,   hi: 999999 },
    { key: 'speed',       name: 'Speed',        unit: 'km/h', lo: 1,   hi: 90 },
    { key: 'slope',       name: 'Slope',        unit: '%',    lo: -40, hi: 40 },
    { key: 'capability',  name: 'Capability',   unit: '%',    lo: 1,   hi: 100 },
    { key: 'reaction',    name: 'Reaction time', unit: 's',   lo: 0.01, hi: 9.99 },
    { key: 'performance', name: 'Performance',  unit: '%g',   lo: 1,   hi: 100 },
  ];
  const FIELD_KEYS = FIELDS.map(f => f.key);

  // Single-word labels (OCR-tolerant matching).
  const WORD_LABELS = {
    speed: ['SPEED', 'VELOCITY'],
    slope: ['SLOPE', 'GRADE', 'GRADIENT', 'INCLINE'],
    capability: ['CAPABILITY', 'CAPABIL', 'CAPAB'],
    reaction: ['REACTION', 'RESPONSE', 'REACT'],
    performance: ['PERFORMANCE', 'PERFORM', 'PERF'],
  };

  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  // Letters view of a token for label matching: digits that OCR swaps for letters become letters.
  function labelForm(t) {
    return String(t).toUpperCase()
      .replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/3/g, 'E').replace(/7/g, 'T')
      .replace(/[^A-Z#]/g, '');
  }

  function isLabelWord(token, label) {
    const t = labelForm(token);
    if (!t) return false;
    if (t === label) return true;
    if (label.length < 5) return false;
    if (t.length >= 5 && (t.startsWith(label.slice(0, 5)) || label.startsWith(t))) return true;
    const d = lev(t, label);
    return d <= Math.max(1, Math.floor(label.length * 0.25));
  }

  function isTestWord(token) {
    const t = labelForm(token);
    if (t === 'TEST' || t === 'TESTS') return true;
    return t.length === 4 && lev(t, 'TEST') <= 1 && t[0] === 'T';
  }
  function isNumberWord(token) {
    const raw = String(token).toUpperCase().replace(/[.:=]+$/, '');
    if (['NO', 'N0', 'NO.', '#', 'NUM', 'NBR', 'N°', 'NO#'].includes(raw)) return true;
    const t = labelForm(token);
    return t === 'NO' || t === 'NUM' || t === '#' || (t.length >= 5 && lev(t, 'NUMBER') <= 2);
  }
  // Tokens like "TESTNO", "TEST#", "TESTNUMBER" written as one word.
  function isJoinedTestNumber(token) {
    const t = labelForm(token);
    return /^TES?T(NO|NUM|NUMBER|#|NBR)$/.test(t) || (t.length >= 9 && lev(t, 'TESTNUMBER') <= 2);
  }

  const UNIT_RE = /(km\/?h|kmh|kph|k\/h|%g|%|secs?|s|g|deg|°)$/i;

  /** Turn an OCR token into a clean number string, or null. */
  function cleanNumber(token) {
    let s = String(token).trim();
    s = s.replace(/^[=:#~*>]+/, '').replace(/[=:;,)]+$/, '');
    if (!s) return null;
    const hasDigit = /\d/.test(s);
    if (!hasDigit && !/^[+-]?[Oo][.,]?[Oo]*$/.test(s)) return null;
    let prev;
    do { prev = s; s = s.replace(UNIT_RE, ''); } while (s !== prev && s.length);
    s = s.replace(/[Oo○QD]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/[Zz]/g, '2').replace(/,/g, '.');
    s = s.replace(/^\+/, '');
    if (/^-0*(\.0*)?$/.test(s)) s = s.slice(1); // "-0.0" is just zero
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (/^-?\.\d+$/.test(s)) return s.replace('.', '0.');
    return null;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  /** Split words that glue a label to its value, e.g. "NO.4034", "SPEED:25.3". */
  function splitTokens(words) {
    const out = [];
    for (const w of words) {
      const text = String(w.text || '').trim();
      if (!text) continue;
      const parts = text
        .replace(/([A-Za-z#]{2,}[.:#=]*)(?=[-+]?\d)/g, '$1 ')
        .replace(/[:=]/g, ' ')
        .split(/\s+/).filter(Boolean);
      if (parts.length <= 1) { out.push(Object.assign({}, w, { text })); continue; }
      const width = (w.x1 - w.x0) / text.length;
      let cursor = w.x0;
      for (const p of parts) {
        const pw = width * p.length;
        out.push(Object.assign({}, w, { text: p, x0: cursor, x1: cursor + pw }));
        cursor += pw + width;
      }
    }
    return out;
  }

  /** Group words into reading lines by vertical position. */
  function groupLines(words) {
    if (!words.length) return [];
    const h = median(words.map(w => w.y1 - w.y0)) || 10;
    const sorted = words.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    for (const w of sorted) {
      const yc = (w.y0 + w.y1) / 2;
      let best = null, bestD = Infinity;
      for (const ln of lines) {
        const d = Math.abs(ln.yc - yc);
        if (d < bestD) { bestD = d; best = ln; }
      }
      if (best && bestD < h * 0.55) {
        best.words.push(w);
        best.yc = best.words.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / best.words.length;
      } else {
        lines.push({ yc, words: [w] });
      }
    }
    lines.sort((a, b) => a.yc - b.yc);
    for (const ln of lines) ln.words.sort((a, b) => a.x0 - b.x0);
    return lines;
  }

  /** Find label hits in one line: [{field, start, end}] (token indices, end exclusive). */
  function labelHits(tokens) {
    const hits = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].text;
      if (isJoinedTestNumber(t)) { hits.push({ field: 'testNo', start: i, end: i + 1 }); continue; }
      if (isTestWord(t)) {
        if (i + 1 < tokens.length && isNumberWord(tokens[i + 1].text)) {
          hits.push({ field: 'testNo', start: i, end: i + 2 }); i++; continue;
        }
        if (i + 1 < tokens.length) {
          const n = cleanNumber(tokens[i + 1].text);
          if (n && /^\d{3,6}$/.test(n)) { hits.push({ field: 'testNo', start: i, end: i + 1 }); continue; }
        }
        continue;
      }
      for (const key of Object.keys(WORD_LABELS)) {
        if (WORD_LABELS[key].some(l => isLabelWord(t, l))) { hits.push({ field: key, start: i, end: i + 1 }); break; }
      }
    }
    return hits;
  }

  function firstNumber(tokens, from, to) {
    for (let i = from; i < to; i++) {
      const n = cleanNumber(tokens[i].text);
      if (n !== null) return { value: n, conf: tokens[i].conf == null ? 90 : tokens[i].conf, index: i };
    }
    return null;
  }

  /** Read the six slip values from a group of words (one slip). */
  function parseSlipWords(words) {
    const tokens = splitTokens(words);
    const lines = groupLines(tokens);
    const result = { values: {}, conf: {}, boxes: {}, raw: lines.map(l => l.words.map(w => w.text).join(' ')).join('\n') };
    const h = median(tokens.map(w => w.y1 - w.y0)) || 10;
    // Region where a value was printed, so the app can re-read it digits-only.
    function regionOf(toks, from, to, fallbackX) {
      const ws = toks.slice(from, to);
      const all = toks;
      const y0 = Math.min(...all.map(w => w.y0)), y1 = Math.max(...all.map(w => w.y1));
      if (!ws.length) return { x0: fallbackX, y0, x1: fallbackX + h * 8, y1 };
      return { x0: Math.min(...ws.map(w => w.x0)), y0, x1: Math.max(...ws.map(w => w.x1)), y1 };
    }
    const lineHits = lines.map(l => labelHits(l.words));

    for (let li = 0; li < lines.length; li++) {
      const toks = lines[li].words;
      const hits = lineHits[li];
      for (let hi = 0; hi < hits.length; hi++) {
        const hit = hits[hi];
        if (result.values[hit.field] != null) continue;
        const stop = hi + 1 < hits.length ? hits[hi + 1].start : toks.length;
        let num = firstNumber(toks, hit.end, stop);
        let region = null;
        if (num) {
          region = regionOf(toks, hit.end, stop, toks[hit.end - 1].x1);
          region.x0 = toks[hit.end - 1].x1 + 1; // everything after the label, in case the first read split the value
        }
        if (!num && hi === hits.length - 1 && li + 1 < lines.length) {
          const next = lines[li + 1].words;
          const nextHits = lineHits[li + 1];
          const nextStop = nextHits.length ? nextHits[0].start : next.length;
          num = firstNumber(next, 0, nextStop);
          if (num) region = regionOf(next, 0, nextStop, next[0].x0);
        }
        if (num) {
          let v = num.value;
          if (hit.field === 'testNo') v = v.replace(/\..*$/, '');
          const f = FIELDS.find(x => x.key === hit.field);
          const n = parseFloat(v);
          let conf = num.conf;
          if (!(n >= f.lo && n <= f.hi)) conf = Math.min(conf, 20);
          result.values[hit.field] = v;
          result.conf[hit.field] = Math.round(conf);
          if (region) result.boxes[hit.field] = region;
        }
      }
    }
    return result;
  }

  /** Bounding box hits for every label of a field across all words (used to tell slips apart). */
  function anchorBoxes(words) {
    const lines = groupLines(splitTokens(words));
    const byField = {};
    for (const ln of lines) {
      for (const hit of labelHits(ln.words)) {
        const ws = ln.words.slice(hit.start, hit.end);
        const box = {
          x0: Math.min(...ws.map(w => w.x0)), x1: Math.max(...ws.map(w => w.x1)),
          y0: Math.min(...ws.map(w => w.y0)), y1: Math.max(...ws.map(w => w.y1)),
        };
        (byField[hit.field] = byField[hit.field] || []).push(box);
      }
    }
    return byField;
  }

  function largestGap(intervals, lo, hi) {
    const iv = intervals.filter(([a, b]) => b > lo && a < hi).map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).sort((p, q) => p[0] - q[0]);
    let best = null, cursor = lo;
    for (const [a, b] of iv) {
      if (a > cursor && (!best || a - cursor > best[1] - best[0])) best = [cursor, a];
      cursor = Math.max(cursor, b);
    }
    if (hi > cursor && (!best || hi - cursor > best[1] - best[0])) best = [cursor, hi];
    return best;
  }

  /** Split the words of one photo into one group per slip. */
  function splitSlips(words) {
    if (!words.length) return [];
    const anchors = anchorBoxes(words);
    const order = ['testNo', 'capability', 'performance', 'reaction', 'slope', 'speed'];
    let boxes = null;
    for (const f of order) { if (anchors[f] && anchors[f].length >= 2) { boxes = anchors[f]; break; } }
    if (!boxes) return [words];

    const h = median(words.map(w => w.y1 - w.y0)) || 10;
    const xs = boxes.map(b => (b.x0 + b.x1) / 2), ys = boxes.map(b => (b.y0 + b.y1) / 2);
    const axis = (Math.max(...xs) - Math.min(...xs)) > (Math.max(...ys) - Math.min(...ys)) ? 'x' : 'y';
    const A0 = axis + '0', A1 = axis + '1';

    // Drop anchors that sit on the same slip as their neighbour (within ~3 text heights along the axis).
    boxes = boxes.slice().sort((a, b) => a[A0] - b[A0]);
    const kept = [boxes[0]];
    for (const b of boxes.slice(1)) { if (b[A0] - kept[kept.length - 1][A0] > h * 3) kept.push(b); }
    if (kept.length < 2) return [words];

    const intervals = words.map(w => [w[A0], w[A1]]);
    const cuts = [];
    for (let i = 0; i < kept.length - 1; i++) {
      const a = kept[i], b = kept[i + 1];
      const gap = largestGap(intervals, a[A1], b[A0]);
      cuts.push(gap && gap[1] - gap[0] >= h * 0.4 ? (gap[0] + gap[1]) / 2 : b[A0] - h * 0.4);
    }
    const groups = kept.map(() => []);
    for (const w of words) {
      const c = (w[A0] + w[A1]) / 2;
      let g = 0;
      while (g < cuts.length && c > cuts[g]) g++;
      groups[g].push(w);
    }
    return groups.filter(g => g.length);
  }

  /** Read every slip in one photo's OCR words. Returns [{values, conf, raw}]. */
  function readSlips(words) {
    const groups = splitSlips(words);
    let slips = groups.map(parseSlipWords).filter(s => Object.keys(s.values).length > 0);
    if (groups.length > 1 && slips.some(s => Object.keys(s.values).length < 3)) {
      // The split looked wrong; fall back to reading the photo as one slip.
      const whole = parseSlipWords(words);
      if (Object.keys(whole.values).length > Math.max(...slips.map(s => Object.keys(s.values).length))) slips = [whole];
    }
    return slips;
  }

  /**
   * Combine the first read of a value with a digits-only second read of the same spot.
   * Returns {value, conf}. Agreement raises confidence; disagreement lowers it so the UI asks for a check.
   */
  function mergeReads(field, v1, c1, text2, c2) {
    const f = FIELDS.find(x => x.key === field);
    const ok = v => v != null && Number.isFinite(parseFloat(v)) && parseFloat(v) >= f.lo && parseFloat(v) <= f.hi;
    let v2 = text2 == null ? null : cleanNumber(String(text2).replace(/\s+/g, ''));
    if (v2 != null && field === 'testNo') v2 = v2.replace(/\..*$/, '');
    if (!ok(v2)) return { value: v1, conf: c1 };
    if (ok(v1) && parseFloat(v1) === parseFloat(v2)) {
      // Both reads agree; prefer the spelling with the decimal point if one read dropped it.
      const value = String(v2).length >= String(v1).length ? v2 : v1;
      return { value, conf: Math.max(c1, c2, 90) };
    }
    if (ok(v1) && c2 < 40) return { value: v1, conf: c1 }; // second read too unsure to overrule
    if (!ok(v1)) return { value: v2, conf: Math.min(c2, 70) };
    // One read picked up a unit letter as an extra digit ("0.38s" -> "0.385"): keep the shorter one.
    const a = String(v1), b = String(v2);
    if (b.length === a.length + 1 && (b.startsWith(a) || b.endsWith(a)) && a.includes('.') === b.includes('.')) return { value: v1, conf: Math.max(c1, 80) };
    if (a.length === b.length + 1 && a.startsWith(b) && a.includes('.') === b.includes('.')) return { value: v2, conf: Math.max(c2, 80) };
    return c2 > c1 ? { value: v2, conf: Math.min(c2, 60) } : { value: v1, conf: Math.min(c1, 60) };
  }

  function slipScore(slips) {
    return slips.reduce((s, x) => s + Object.keys(x.values).length, 0);
  }

  /* ------------------------------------------------------------------
   * CHECKS
   * ------------------------------------------------------------------ */

  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    return parseFloat(String(v).replace(',', '.'));
  }
  function fmt(n, dp = 1) { return Number.isFinite(n) ? (Math.round(n * 10 ** dp) / 10 ** dp).toString() : '—'; }

  /** Difference between two readings. mode 'relative' = % of their average; 'points' = absolute. */
  function diffPct(a, b, mode) {
    if (mode === 'points') return Math.abs(a - b);
    const avg = (a + b) / 2;
    if (avg === 0) return a === b ? 0 : 100;
    return Math.abs(a - b) / Math.abs(avg) * 100;
  }

  function band(d) { return d <= 5 + 1e-9 ? 'ok' : d <= 10 + 1e-9 ? 'warn' : 'fail'; }

  /**
   * Check one test (a pair of slips).
   * opts: { capMode: 'relative'|'points', otherTestNos: [numbers used by other tests] }
   * Returns { status: 'pass'|'warn'|'fail'|'incomplete'|'na', items: [{level, text}], slips: sorted }
   */
  function checkTest(testKey, slips, machine, opts) {
    opts = opts || {};
    const limits = limitsFor(machine, testKey);
    const items = [];
    if (!machine) return { status: 'incomplete', items: [{ level: 'info', text: 'Choose the machine first.' }], slips: slips || [] };
    if (!limits) return { status: 'na', items: [{ level: 'info', text: 'No secondary brake test for this machine. Marked N/A on the form.' }], slips: [] };
    slips = (slips || []).filter(Boolean);
    if (slips.length < 2) {
      return { status: 'incomplete', items: [{ level: 'info', text: slips.length ? 'One slip read. Add the second slip.' : 'Photograph the 2 slips for this test.' }], slips };
    }
    slips = slips.slice(0, 2).sort((a, b) => num(a.values.testNo) - num(b.values.testNo));

    const missing = [];
    slips.forEach((s, i) => {
      FIELD_KEYS.forEach(k => { if (!Number.isFinite(num(s.values[k]))) missing.push(`slip ${i + 1} ${FIELDS.find(f => f.key === k).name.toLowerCase()}`); });
    });
    if (missing.length) {
      return { status: 'incomplete', items: [{ level: 'info', text: 'Not read: ' + missing.join(', ') + '. Type them in from the slip.' }], slips };
    }

    const [A, B] = slips.map(s => s.values);
    const tA = num(A.testNo), tB = num(B.testNo);

    // Consecutive test numbers
    if (tB - tA === 1) items.push({ level: 'ok', text: `Test numbers #${tA} and #${tB} are consecutive` });
    else if (tA === tB) items.push({ level: 'fail', text: `Both slips show test #${tA}. Photograph the other slip.` });
    else items.push({ level: 'fail', text: `Test numbers #${tA} and #${tB} are not consecutive` });

    const clash = (opts.otherTestNos || []).filter(n => n === tA || n === tB);
    if (clash.length) items.push({ level: 'fail', text: `Test #${clash.join(', #')} is already used in another test` });

    // Slope must be zero
    const badSlope = slips.filter(s => Math.abs(num(s.values.slope)) > 1e-9);
    if (badSlope.length) items.push({ level: 'fail', text: 'Slope must be 0. Reads ' + badSlope.map(s => `${s.values.slope}% on #${s.values.testNo}`).join(', ') });
    else items.push({ level: 'ok', text: 'Slope reads 0 on both slips' });

    // Speeds within 5% of each other
    const sA = num(A.speed), sB = num(B.speed);
    const dS = diffPct(sA, sB, 'relative');
    const bS = band(dS);
    items.push({ level: bS, text: `Speeds ${A.speed} and ${B.speed} km/h are ${fmt(dS)}% apart` + (bS === 'ok' ? '' : bS === 'warn' ? ' (over 5%)' : ' (over 10%)') });

    // Capabilities within 5% of each other
    const cA = num(A.capability), cB = num(B.capability);
    const dC = diffPct(cA, cB, opts.capMode);
    const bC = band(dC);
    const unitC = opts.capMode === 'points' ? ' points' : '%';
    items.push({ level: bC, text: `Capabilities ${A.capability}% and ${B.capability}% are ${fmt(dC)}${unitC} apart` + (bC === 'ok' ? '' : bC === 'warn' ? ' (over 5)' : ' (over 10)') });

    // Capability against the minimum
    const lowCap = slips.filter(s => num(s.values.capability) < limits.min);
    if (lowCap.length) items.push({ level: 'fail', text: `Capability below the ${limits.min}% minimum on #` + lowCap.map(s => s.values.testNo).join(', #') });
    else items.push({ level: 'ok', text: `Capability meets the ${limits.min}% minimum` });

    // Response time against the maximum
    const slow = slips.filter(s => num(s.values.reaction) > limits.resp);
    if (slow.length) items.push({ level: 'fail', text: `Response time over ${limits.resp} s on #` + slow.map(s => s.values.testNo).join(', #') });
    else items.push({ level: 'ok', text: `Response times within ${limits.resp} s` });

    // Speed of test within the rated range (warning only)
    const outRange = slips.filter(s => {
      const v = num(s.values.speed);
      if (limits.speedBelow) return !(v < limits.speedMax);
      return v < limits.speedMin || v > limits.speedMax;
    });
    if (outRange.length) {
      const which = outRange.map(s => `#${s.values.testNo} reads ${s.values.speed}`).join(', ');
      items.push({ level: 'warn', text: limits.speedBelow
        ? `Test speed should be under ${limits.speedMax} km/h. ${which}`
        : `Test speed should be ${limits.speedMin}–${limits.speedMax} km/h. ${which}` });
    }

    const status = items.some(i => i.level === 'fail') ? 'fail' : items.some(i => i.level === 'warn') ? 'warn' : 'pass';
    return { status, items, slips, limits };
  }

  /* ------------------------------------------------------------------
   * FILLING THE RECORD SHEET (WHC-QLD-FRM Mandatory Brake Test Record Sheet, Issue 3.0)
   * Coordinates are PDF points from the bottom-left of each A4 page.
   * ------------------------------------------------------------------ */
  const LAYOUT = {
    header: { // page 1
      leftX: 144, rightX: 402.8, leftMax: 165, rightMax: 160, wideMax: 420,
      station: 592.55, tester: 575.7, wo: 558.85, hours: 542.0, description: 525.15, serial: 508.3, unit: 491.55,
      date: 592.55, cert: 575.7, siteCode: 558.85, time: 542.0,
    },
    equipment: { rows: [425.05, 407.05, 389.05], cols: [[28.7, 149.1], [149.1, 250.3], [250.3, 365.4], [365.4, 567.9]] },
    service: {
      page: 0, rows: [289.15, 270.0, 250.85, 231.7],
      cols: { payload: [84.9, 141.6], testNo: [141.6, 193.0], min: [193.0, 259.1], actual: [259.1, 333.0], respReq: [333.0, 411.0], resp: [411.0, 474.2] },
      boxes: { pass: 490.1, fail: 519.5, na: 549.95 }, boxRows: [287.0, 267.9, 248.7, 229.6],
      skid: { x: 274, y: 208.55, max: 285 },
    },
    secondary: {
      page: 1, rows: [652.75, 633.6, 614.45, 595.3],
      cols: { payload: [73.9, 133.1], testNo: [133.1, 177.0], min: [177.0, 248.0], actual: [248.0, 318.7], respReq: [318.7, 399.1], resp: [399.1, 465.8] },
      boxes: { pass: 483.1, fail: 517.0, na: 550.25 }, boxRows: [650.6, 631.5, 612.3, 593.2],
      skid: { x: 266, y: 572.15, max: 295 },
    },
    park: { page: 1, rows: [486.2, 467.5], gradient: [176.8, 258.2], boxes: { pass: 297.05, fail: 374.1, na: 489.6 }, boxRows: [483.9, 465.2] },
    comments: { page: 1, rows: [415.0, 395.5, 376.0, 356.55, 337.1, 317.6, 298.15, 278.7], x: 39, labelX: 115.5, dittoX: 154.5, noteX: 224.2, right: 563 },
    signoff: { page: 1, nameX: 123, dateX: 403.5, y: 207.15, compX: 402.8, compY: 182.75 },
    box: { half: 3.0, dy: 5.55 },
  };

  /**
   * Fill the record sheet.
   * PDFLib: the pdf-lib global. template: ArrayBuffer/Uint8Array of the form (blank or a filled copy).
   * m: model from buildFormModel().
   */
  async function fillForm(PDFLib, template, m) {
    const { PDFDocument, StandardFonts, rgb, PDFName } = PDFLib;
    const doc = await PDFDocument.load(template);
    const pages = doc.getPages();
    if (pages.length < 2) throw new Error('This PDF has ' + pages.length + ' page. The brake test record sheet has 2 pages.');

    // Remove typed-in values from a previously filled copy (they are FreeText annotations).
    for (const page of pages) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const keep = [];
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const a = doc.context.lookup(ref);
        const st = a && a.get ? a.get(PDFName.of('Subtype')) : null;
        if (st && String(st) === '/FreeText') continue;
        keep.push(ref);
      }
      if (keep.length) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
      else page.node.delete(PDFName.of('Annots'));
    }

    // The form carries an empty AcroForm with no Fields array; give it one so strict viewers don't complain.
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    if (acro && acro.get && !acro.get(PDFName.of('Fields'))) acro.set(PDFName.of('Fields'), doc.context.obj([]));

    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ink = rgb(0.05, 0.05, 0.1);
    const SIZE = 10.5;

    function fit(text, max) {
      let size = SIZE;
      while (size > 6.5 && font.widthOfTextAtSize(text, size) > max) size -= 0.25;
      return size;
    }
    function left(p, text, x, y, max) {
      text = String(text == null ? '' : text).trim();
      if (!text) return;
      const size = max ? fit(text, max) : SIZE;
      pages[p].drawText(text, { x, y, size, font, color: ink });
    }
    function center(p, text, col, y) {
      text = String(text == null ? '' : text).trim();
      if (!text) return;
      const max = col[1] - col[0] - 6;
      const size = fit(text, max);
      const w = font.widthOfTextAtSize(text, size);
      pages[p].drawText(text, { x: (col[0] + col[1]) / 2 - w / 2, y, size, font, color: ink });
    }
    function cross(p, cx, glyphBottom) {
      const s = LAYOUT.box.half, cy = glyphBottom + LAYOUT.box.dy;
      pages[p].drawLine({ start: { x: cx - s, y: cy - s }, end: { x: cx + s, y: cy + s }, thickness: 1.4, color: ink });
      pages[p].drawLine({ start: { x: cx - s, y: cy + s }, end: { x: cx + s, y: cy - s }, thickness: 1.4, color: ink });
    }

    // Header
    const H = LAYOUT.header, h = m.header || {};
    left(0, h.station, H.leftX, H.station, H.leftMax);
    left(0, h.tester, H.leftX, H.tester, H.leftMax);
    left(0, h.wo, H.leftX, H.wo, H.leftMax);
    left(0, h.hours, H.leftX, H.hours, H.leftMax);
    left(0, h.description, H.leftX, H.description, H.wideMax);
    left(0, h.serial, H.leftX, H.serial, H.wideMax);
    left(0, h.unit, H.leftX, H.unit, H.wideMax);
    left(0, h.date, H.rightX, H.date, H.rightMax);
    left(0, h.cert, H.rightX, H.cert, H.rightMax);
    left(0, h.siteCode, H.rightX, H.siteCode, H.rightMax);
    left(0, h.time, H.rightX, H.time, H.rightMax);

    // Test equipment
    (m.equipment || []).slice(0, 3).forEach((e, i) => {
      const y = LAYOUT.equipment.rows[i], C = LAYOUT.equipment.cols;
      center(0, e.id, C[0], y); center(0, e.serial, C[1], y); center(0, e.lastCal, C[2], y); center(0, e.nextCal, C[3], y);
    });

    // Service and secondary tables
    for (const which of ['service', 'secondary']) {
      const L = LAYOUT[which], t = m[which];
      if (!t) continue;
      t.rows.forEach((r, i) => {
        if (!r) return;
        const y = L.rows[i];
        center(L.page, r.payload, L.cols.payload, y);
        center(L.page, r.testNo, L.cols.testNo, y);
        center(L.page, r.min, L.cols.min, y);
        center(L.page, r.actual, L.cols.actual, y);
        center(L.page, r.respReq, L.cols.respReq, y);
        center(L.page, r.resp, L.cols.resp, y);
        if (r.mark && L.boxes[r.mark]) cross(L.page, L.boxes[r.mark], L.boxRows[i]);
      });
      left(L.page, t.skid, L.skid.x, L.skid.y, L.skid.max);
    }

    // Park brake
    (m.park || []).forEach((r, i) => {
      if (!r) return;
      const P = LAYOUT.park;
      center(P.page, r.gradient, P.gradient, P.rows[i]);
      if (r.mark && P.boxes[r.mark]) cross(P.page, P.boxes[r.mark], P.boxRows[i]);
    });

    // Comments: brake performance per print-out, then the closing note
    const C = LAYOUT.comments, perf = (m.comments && m.comments.perf) || [];
    perf.slice(0, C.rows.length).forEach((p, i) => {
      const y = C.rows[i];
      left(C.page, `#${p.testNo} = ${p.value} %g`, C.x, y);
      if (i === 0) left(C.page, 'Brake Performance BP%', C.labelX, y);
      else left(C.page, '|  |         |  |', C.dittoX, y);
    });
    const note = m.comments && m.comments.note;
    if (note) {
      if (perf.length < C.rows.length) left(C.page, note, C.x, C.rows[perf.length], C.right - C.x);
      else left(C.page, note, C.noteX, C.rows[C.rows.length - 1], C.right - C.noteX);
    }

    // Sign-off (person conducting testing)
    const S = LAYOUT.signoff, so = m.signoff || {};
    left(S.page, so.name, S.nameX, S.y, 230);
    left(S.page, so.date, S.dateX, S.y, 160);
    left(S.page, so.competency, S.compX, S.compY, 160);

    return doc.save();
  }

  /**
   * Turn the app's job + settings + check results into what goes on the form.
   * results: { svcUL: checkTest(...), ... } ; include: { svcUL: true, ... } tests to put on the form
   */
  function buildFormModel(job, settings, results, include) {
    const machine = machineById(job.machineId);
    const model = {
      header: {
        station: settings.stationName, tester: settings.testerName, wo: job.wo,
        hours: job.hours, description: job.description, serial: job.serial, unit: job.unitId,
        date: job.date, cert: settings.certNo, siteCode: settings.siteCode, time: job.time,
      },
      equipment: (settings.equipment || []).filter(e => e && (e.id || e.serial)),
      service: { rows: [null, null, null, null], skid: '' },
      secondary: { rows: [null, null, null, null], skid: '' },
      park: [null, null],
      comments: { perf: [], note: job.finalNote || '' },
      signoff: { name: settings.testerName, date: job.date, competency: settings.competency },
    };
    const perf = [];
    let anyService = false, anySecondary = false;

    for (const t of TESTS) {
      const table = model[t.brake];
      const base = t.load === 'unladen' ? 0 : 2;
      const res = results[t.key];
      if (machine && !machine[t.brake]) {
        table.rows[base] = { mark: 'na' }; table.rows[base + 1] = { mark: 'na' };
        continue;
      }
      if (!include[t.key] || !res || !(res.status === 'pass' || res.status === 'warn')) continue;
      res.slips.forEach((s, i) => {
        const v = s.values;
        table.rows[base + i] = {
          payload: t.load === 'laden' ? job.payload : '',
          testNo: v.testNo, min: fmt(res.limits.min), actual: v.capability,
          respReq: fmt(res.limits.resp), resp: v.reaction, mark: 'pass',
        };
        perf.push({ testNo: v.testNo, value: v.performance });
      });
      if (t.brake === 'service') anyService = true; else anySecondary = true;
    }
    if (anyService) model.service.skid = job.skidService || '';
    if (anySecondary) model.secondary.skid = job.skidSecondary || '';
    if (machine && !machine.secondary) model.secondary.skid = 'N/A';

    ['rev', 'fwd'].forEach((k, i) => {
      const p = job.park && job.park[k];
      if (p && (p.gradient || p.result)) model.park[i] = { gradient: p.gradient, mark: p.result || null };
    });

    perf.sort((a, b) => num(a.testNo) - num(b.testNo));
    model.comments.perf = perf;
    return model;
  }

  /* ------------------------------------------------------------------
   * Small helpers shared with the UI
   * ------------------------------------------------------------------ */
  function todayDMY(d) {
    d = d || new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
  }
  function nowHM(d) {
    d = d || new Date();
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function parseDMY(s) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(String(s || '').trim());
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }

  const API = {
    CRITERIA, MACHINES, TESTS, FIELDS, FIELD_KEYS, LAYOUT,
    machineById, machinesForSerial, limitsFor, speedRangeText,
    cleanNumber, splitTokens, groupLines, labelHits, parseSlipWords, splitSlips, readSlips, slipScore, mergeReads,
    num, fmt, diffPct, checkTest, fillForm, buildFormModel, todayDMY, nowHM, parseDMY,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.BTR = API;
})(typeof window !== 'undefined' ? window : globalThis);
