'use strict';

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════

/** @type {{ mode: string, lang: string, requireArticle: boolean, tags: string[] }} */
const cfg = {
  mode:           'flip',   // 'flip' | 'type'
  lang:           'both',   // 'en' | 'uk' | 'both'
  requireArticle: true,
  tags:           [],       // empty = all; array of strings = filter to any of these tags
};

/** @type {{ words: object[], idx: number, correct: number, wrong: number, skipped: number, flipped: boolean, checked: boolean, startTime: number|null }} */
const sess = {
  words:     [],
  idx:       0,
  correct:   0,
  wrong:     0,
  skipped:   0,
  flipped:   false,
  checked:   false,
  startTime: null,   // Date.now() at session start
};

// ═══════════════════════════════════════════════════════════════
//  STATS YAML PARSER
// ═══════════════════════════════════════════════════════════════

// Indentation constants used when parsing YAML sections
const YAML_INDENT_WORD_STATS = 2;
const YAML_INDENT_SESSION    = 4;

/**
 * Parses the stats.yaml subset used by this app.
 * Handles two top-level sections: `word_stats` and `sessions`.
 * @param {string} text - Raw YAML text content of stats.yaml
 * @returns {{ word_stats: object, sessions: object[] }}
 */
function parseStatsYAML(text) {
  const data  = { word_stats: {}, sessions: [] };
  let section = null, curSess = null;

  for (const raw of text.split('\n')) {
    const line     = raw.trimEnd();
    const stripped = line.trimStart();
    const indent   = line.length - stripped.length;
    if (!stripped || stripped.startsWith('#')) continue;

    if (line === 'word_stats:') { section = 'word_stats'; continue; }
    if (line === 'sessions:')   { section = 'sessions';   continue; }

    if (section === 'word_stats' && indent === YAML_INDENT_WORD_STATS) {
      const m = stripped.match(/^"?(\w+)"?\s*:\s*\{(.+)\}/);
      if (m) {
        const obj = {};
        for (const pair of m[2].split(',')) {
          const ci = pair.indexOf(':');
          if (ci === -1) continue;
          const k = pair.slice(0, ci).trim();
          const v = pair.slice(ci + 1).trim().replace(/^"|"$/g, '');
          obj[k] = /^\d+$/.test(v) ? parseInt(v) : (v === '~' ? null : v);
        }
        data.word_stats[m[1]] = obj;
      }
    } else if (section === 'sessions') {
      if (stripped.startsWith('- ')) {
        if (curSess) data.sessions.push(curSess);
        curSess = {};
        const rest = stripped.slice(2), ci = rest.indexOf(': ');
        if (ci !== -1) curSess[rest.slice(0, ci).trim()] = parseSV(rest.slice(ci + 2));
      } else if (indent === YAML_INDENT_SESSION && curSess) {
        const ci = stripped.indexOf(': ');
        if (ci !== -1) curSess[stripped.slice(0, ci).trim()] = parseSV(stripped.slice(ci + 2));
      }
    }
  }
  if (curSess) data.sessions.push(curSess);
  return data;
}

/**
 * Parses a scalar YAML value: numbers, nulls, or strings.
 * @param {string} v - Raw value string from YAML
 * @returns {number|string|null}
 */
function parseSV(v) {
  v = (v || '').trim().replace(/^"|"$/g, '');
  if (v === '~' || v === 'null' || v === '') return null;
  if (/^\d+$/.test(v)) return parseInt(v);
  return v;
}

// ═══════════════════════════════════════════════════════════════
//  STATS  (persisted to stats.yaml via POST /save-stats)
// ═══════════════════════════════════════════════════════════════

// Thresholds for Stats.weight() and Stats.badgeHTML()
const WEIGHT_UNSEEN          = 10;   // weight for a word never practiced
const WEIGHT_MIN             = 1;    // minimum weight for a fully mastered word
const WEIGHT_WRONG_BASE      = 2;    // base weight added when word has wrong answers
const ACCURACY_GOOD_THRESHOLD = 80;  // % accuracy considered "good"
const ACCURACY_MID_THRESHOLD  = 50;  // % accuracy considered "mid"

const Stats = {
  _ws:       {},   // { [id]: { correct, wrong, skipped, streak, first_seen, last_seen } }
  _sessions: [],   // full session history for reports

  /**
   * Initialises Stats from persisted data loaded at boot.
   * @param {{ word_stats: object, sessions: object[] }} data
   */
  init(data) {
    this._ws       = data.word_stats || {};
    this._sessions = data.sessions   || [];
  },

  /**
   * Returns the stat record for a word, defaulting to zeroes if unseen.
   * @param {number|string} id
   * @returns {{ correct: number, wrong: number, skipped: number, streak: number, first_seen: string|null, last_seen: string|null }}
   */
  get(id) {
    return this._ws[String(id)] || { correct: 0, wrong: 0, skipped: 0, streak: 0, first_seen: null, last_seen: null };
  },

  /**
   * Records one answer outcome for a word and updates its streak.
   * @param {number|string} id
   * @param {'correct'|'wrong'|'skipped'} outcome
   */
  record(id, outcome) {
    const key = String(id);
    if (!this._ws[key]) this._ws[key] = { correct: 0, wrong: 0, skipped: 0, streak: 0, first_seen: null, last_seen: null };
    const s     = this._ws[key];
    const today = new Date().toISOString().slice(0, 10);
    if (!s.first_seen) s.first_seen = today;
    s.last_seen = today;
    s[outcome]  = (s[outcome] || 0) + 1;
    if (outcome === 'correct')    s.streak = (s.streak || 0) + 1;
    else if (outcome === 'wrong') s.streak = 0;
  },

  /**
   * Returns a sampling weight (1–10) for a word.
   * Unseen words always get 10; mastered words fade toward 1.
   * @param {number|string} id
   * @returns {number}
   */
  weight(id) {
    const s = this.get(id), total = s.correct + s.wrong + s.skipped;
    if (total === 0) return WEIGHT_UNSEEN;
    if (s.wrong === 0) return Math.max(WEIGHT_MIN, 4 - Math.floor(total / 2));
    return WEIGHT_WRONG_BASE + (s.wrong / (s.correct + s.wrong)) * 8;
  },

  /**
   * Returns an HTML snippet with a coloured dot and summary stats for a word.
   * Used on the card face to show prior performance at a glance.
   * @param {number|string} id
   * @returns {string} HTML string
   */
  badgeHTML(id) {
    const s = this.get(id), total = s.correct + s.wrong + s.skipped;
    if (total === 0) return '<span class="stat-dot s-new"></span><span>new</span>';
    const answered = s.correct + s.wrong;
    const acc      = answered > 0 ? Math.round(s.correct / answered * 100) : null;
    const cls      = acc === null ? 's-new' : acc >= ACCURACY_GOOD_THRESHOLD ? 's-good' : acc >= ACCURACY_MID_THRESHOLD ? 's-mid' : 's-bad';
    return `<span class="stat-dot ${cls}"></span><span>${total}×${acc !== null ? ` · ${acc}%` : ''}</span>`;
  },

  /**
   * POSTs current word stats and a session record to /save-stats.
   * On success, appends the session to the in-memory history.
   * @param {object|null} sessionData - session summary object, or null
   * @returns {Promise<void>}
   */
  async save(sessionData) {
    try {
      const res = await fetch('/save-stats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word_stats: this._ws, session: sessionData }),
      });
      if (res.ok && sessionData) this._sessions.push(sessionData);
    } catch (e) { console.warn('Could not save stats:', e); }
  },
};

// ═══════════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════════

/**
 * Returns a new array that is a Fisher-Yates shuffle of the input.
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Normalises a string for comparison: trim, lowercase, collapse whitespace.
 * @param {string} s
 * @returns {string}
 */
function norm(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Checks whether a typed answer matches a word's German form,
 * honouring the `cfg.requireArticle` setting.
 * @param {string} typed - The user's raw input
 * @param {{ de: string, article?: string }} word
 * @returns {boolean}
 */
function isCorrectAnswer(typed, word) {
  const t = norm(typed);
  const withArticle    = norm(word.article ? `${word.article} ${word.de}` : word.de);
  const withoutArticle = norm(word.de);
  if (cfg.requireArticle && word.article) return t === withArticle;
  return t === withArticle || t === withoutArticle;
}

// ═══════════════════════════════════════════════════════════════
//  RENDER HELPERS
// ═══════════════════════════════════════════════════════════════

/** Display labels for each grammatical form key used in words.yaml. */
const FORM_LABELS = {
  // noun
  gen: 'GEN', dat: 'DAT', acc: 'ACC', pl: 'PL',
  // verb
  ich: 'ICH', du: 'DU', er: 'ER·SIE·ES', wir: 'WIR',
  prät: 'PRÄT', pp: 'P.P.', aux: 'AUX',
  // adj
  komp: 'KOMP', sup: 'SUP',
};

/**
 * Builds the HTML grid of grammatical forms shown on the card back.
 * @param {object|null} forms - Key-value pairs of form label → value
 * @param {string|null} [notes] - Optional free-text notes line
 * @returns {string} HTML string
 */
function buildFormsHTML(forms, notes) {
  if (!forms) return '';
  let html = '';
  for (const [k, v] of Object.entries(forms)) {
    if (!v) continue;
    const label = FORM_LABELS[k] || k.toUpperCase();
    html += `<span class="form-key">${label}</span><span class="form-val">${v}</span>`;
  }
  if (notes) html += `<span class="back-notes" style="grid-column:1/-1;">※ ${notes}</span>`;
  return html;
}

/**
 * Returns the CSS class corresponding to a German article.
 * @param {'der'|'die'|'das'|undefined} art
 * @returns {string}
 */
function articleClass(art) {
  if (art === 'der') return 'art-der';
  if (art === 'die') return 'art-die';
  if (art === 'das') return 'art-das';
  return 'art-none';
}

// ═══════════════════════════════════════════════════════════════
//  POPULATE CARD FACES
// ═══════════════════════════════════════════════════════════════

/**
 * Writes word data into the DOM elements for one card (front + back).
 * The `prefix` argument distinguishes flip-mode cards ('f') from type-mode ('t').
 * @param {{ id: number, en: string, uk: string, de: string, article?: string, type?: string, forms?: object, notes?: string }} word
 * @param {string} prefix - Element ID prefix ('f' or 't')
 */
function populateCard(word, prefix) {
  // front
  const badge = $(`${prefix}Badge`);
  const main  = $(`${prefix}Main`);
  const sub   = $(`${prefix}Sub`);
  if (badge) badge.textContent = word.type || 'word';

  const statsEl = $(`${prefix}Stats`);
  if (statsEl) statsEl.innerHTML = Stats.badgeHTML(word.id);

  if (cfg.lang === 'en') {
    main.textContent = word.en;
    sub.textContent  = '';
  } else if (cfg.lang === 'uk') {
    main.textContent = word.uk;
    sub.textContent  = '';
  } else {
    main.textContent = word.en;
    sub.textContent  = word.uk;
  }

  // back
  const ba = $(`${prefix}BackArticle`);
  const bw = $(`${prefix}BackWord`);
  const bf = $(`${prefix}BackForms`);

  if (word.article) {
    ba.textContent = word.article;
    ba.className   = `back-article ${articleClass(word.article)}`;
  } else {
    ba.textContent = '';
    ba.className   = 'back-article art-none';
  }
  bw.textContent = word.de;
  bf.innerHTML   = buildFormsHTML(word.forms, word.notes);
}

// ═══════════════════════════════════════════════════════════════
//  PROGRESS
// ═══════════════════════════════════════════════════════════════

/**
 * Refreshes the progress bar and score counters in the header.
 */
function updateProgress() {
  const total = sess.words.length;
  const done  = sess.idx;
  $('progressFill').style.width  = total ? `${(done / total) * 100}%` : '0%';
  $('progressCount').textContent = `${done} / ${total}`;
  $('scoreCorrect').textContent  = `✓ ${sess.correct}`;
  $('scoreWrong').textContent    = `✗ ${sess.wrong}`;
  $('scoreSkip').textContent     = `→ ${sess.skipped}`;
}

// ═══════════════════════════════════════════════════════════════
//  SHOW CARD
// ═══════════════════════════════════════════════════════════════

/**
 * Renders the given word into the active card and resets interaction state.
 * Applies the snap-back fix to prevent the new card's back face from
 * flashing during the flip-in animation.
 * @param {{ id: number, en: string, uk: string, de: string, article?: string, type?: string, forms?: object, notes?: string }} word
 */
function showCard(word) {
  if (cfg.mode === 'flip') {
    // Snap back instantly (no transition) so the new back face is never seen mid-animation
    sess.flipped = false;
    const card = $('flipCard');
    card.style.transition = 'none';
    card.classList.remove('flipped');
    card.offsetHeight; // force reflow
    card.style.transition = '';
    show('flipPreActions');
    hide('flipPostActions');
    populateCard(word, 'f');
  } else {
    // type mode
    sess.checked = false;
    const card = $('typeCard');
    card.style.transition = 'none';
    card.classList.remove('flipped');
    card.offsetHeight; // force reflow
    card.style.transition = '';

    const inp = $('typeInput');
    inp.value    = '';
    inp.disabled = false;
    inp.className = 'type-input';

    $('typeFeedback').textContent = '';
    $('typeFeedback').className   = 'type-feedback';

    const pa = $('typePostActions');
    pa.style.opacity      = '0';
    pa.style.pointerEvents = 'none';

    populateCard(word, 't');
    setTimeout(() => inp.focus(), 60);
  }
}

// ═══════════════════════════════════════════════════════════════
//  ADVANCE
// ═══════════════════════════════════════════════════════════════

/**
 * Records the outcome for the current card, updates counters, and
 * either shows the next card or ends the session.
 * @param {'correct'|'wrong'|'skip'} outcome
 */
function advance(outcome) {
  Stats.record(sess.words[sess.idx].id, outcome === 'skip' ? 'skipped' : outcome);

  if (outcome === 'correct') sess.correct++;
  else if (outcome === 'wrong') sess.wrong++;
  else sess.skipped++;

  sess.idx++;
  updateProgress();

  if (sess.idx >= sess.words.length) {
    endSession();
    return;
  }
  showCard(sess.words[sess.idx]);
}

// ═══════════════════════════════════════════════════════════════
//  FLIP
// ═══════════════════════════════════════════════════════════════

/**
 * Flips the flip-mode card to reveal the answer.
 * No-ops if the card is already flipped.
 */
function doFlip() {
  if (sess.flipped) return;
  sess.flipped = true;
  $('flipCard').classList.add('flipped');
  hide('flipPreActions');
  show('flipPostActions');
}

// ═══════════════════════════════════════════════════════════════
//  TYPE CHECK
// ═══════════════════════════════════════════════════════════════

/**
 * Validates the typed answer, shows feedback, and reveals the card back.
 * No-ops if the answer has already been checked or the input is empty.
 */
function doCheck() {
  if (sess.checked) return;
  const inp = $('typeInput');
  if (!inp.value.trim()) return;

  sess.checked = true;
  inp.disabled = true;

  const word = sess.words[sess.idx];
  const ok   = isCorrectAnswer(inp.value, word);

  inp.classList.add(ok ? 'is-correct' : 'is-wrong');

  const fb = $('typeFeedback');
  if (ok) {
    fb.textContent = '✓ Correct!';
    fb.className   = 'type-feedback correct';
  } else {
    const expected = word.article ? `${word.article} ${word.de}` : word.de;
    fb.textContent = `✗  Answer: ${expected}`;
    fb.className   = 'type-feedback wrong';
  }

  // reveal back
  $('typeCard').classList.add('flipped');

  // show advance buttons
  const pa = $('typePostActions');
  pa.style.opacity      = '1';
  pa.style.pointerEvents = '';
}

// ═══════════════════════════════════════════════════════════════
//  SESSION END
// ═══════════════════════════════════════════════════════════════

/** Percentage thresholds and corresponding motivational messages for the end screen. */
const SESSION_END_MESSAGES = [
  [100, 'Perfekt! Ausgezeichnet!'],
  [80,  'Sehr gut! Keep it up.'],
  [60,  'Gut! A bit more practice and you\'ll nail it.'],
  [40,  'Getting there. Review the missed ones.'],
  [0,   'Don\'t give up — every mistake is a lesson.'],
];

/**
 * Shows the completion screen, displays the session summary, and
 * persists the session + updated word stats to the server.
 */
function endSession() {
  hide('flipMode');
  hide('typeMode');
  $('progressSection').style.visibility = 'hidden';

  $('finalCorrect').textContent = sess.correct;
  $('finalWrong').textContent   = sess.wrong;
  $('finalSkip').textContent    = sess.skipped;

  const pct = Math.round((sess.correct / sess.words.length) * 100);
  $('finalMsg').textContent = (SESSION_END_MESSAGES.find(([t]) => pct >= t) || SESSION_END_MESSAGES[4])[1];
  $('completeScreen').classList.add('active');

  // Persist session + word stats
  const now = new Date();
  Stats.save({
    date:     now.toISOString().slice(0, 10),
    time:     now.toTimeString().slice(0, 5),
    mode:     cfg.mode,
    tag:      cfg.tags.length ? cfg.tags.join(',') : null,
    correct:  sess.correct,
    wrong:    sess.wrong,
    skipped:  sess.skipped,
    total:    sess.words.length,
    duration: sess.startTime ? Math.round((Date.now() - sess.startTime) / 1000) : null,
  });
}

// ═══════════════════════════════════════════════════════════════
//  START / RESTART
// ═══════════════════════════════════════════════════════════════

/**
 * Builds a weighted, shuffled word list for the current settings and
 * starts a fresh session.  Called on boot, shuffle, and settings close.
 */
function startSession() {
  _cfgDirty = false;
  const pool = cfg.tags.length
    ? WORDS_DATA.filter(w => w.tags && cfg.tags.some(t => w.tags.includes(t)))
    : WORDS_DATA;
  // Weighted sort: higher weight (unseen / wrong-heavy) floats to front,
  // with randomness so the order isn't perfectly rigid each session.
  sess.words = [...pool].sort((a, b) => {
    const wa = Stats.weight(a.id) + Math.random() * 2;
    const wb = Stats.weight(b.id) + Math.random() * 2;
    return wb - wa;
  });
  sess.idx       = 0;
  sess.correct   = 0;
  sess.wrong     = 0;
  sess.skipped   = 0;
  sess.startTime = Date.now();

  $('completeScreen').classList.remove('active');
  $('progressSection').style.visibility = '';

  hide('flipMode');
  hide('typeMode');

  if (cfg.mode === 'flip') {
    $('flipMode').classList.remove('hidden');
  } else {
    $('typeMode').classList.remove('hidden');
  }

  updateProgress();
  showCard(sess.words[0]);
}

// ═══════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════

/**
 * Opens the settings panel and its backdrop overlay.
 */
function openSettings()  {
  $('overlay').classList.add('open');
  $('settingsPanel').classList.add('open');
}

/**
 * Closes the settings panel. If any setting changed while the panel was
 * open, automatically restarts the session with the new config.
 */
function closeSettings() {
  $('overlay').classList.remove('open');
  $('settingsPanel').classList.remove('open');
  if (_cfgDirty) {
    _cfgDirty = false;
    startSession();
  }
}

// ═══════════════════════════════════════════════════════════════
//  REPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Opens the report panel and (re-)renders its contents.
 */
function openReport() {
  renderReport();
  $('reportPanel').classList.add('open');
}

/**
 * Closes the report panel.
 */
function closeReport() {
  $('reportPanel').classList.remove('open');
}

// Thresholds used in the report view
const REPORT_MASTERED_MIN_ATTEMPTS  = 5;    // minimum attempts to count as mastered
const REPORT_MASTERED_MIN_ACCURACY  = 0.8;  // minimum accuracy to count as mastered
const REPORT_STRUGGLE_MIN_ATTEMPTS  = 3;    // minimum attempts to appear in "Needs Practice"
const REPORT_STRUGGLE_WRONG_RATE    = 0.4;  // wrong rate above this → "Needs Practice"
const REPORT_STRUGGLE_MAX_DISPLAY   = 8;    // max words shown in "Needs Practice"
const REPORT_MASTERED_MAX_DISPLAY   = 8;    // max words shown in "Mastered"
const REPORT_DAYS_HISTORY           = 7;    // number of days shown in the bar chart
const REPORT_CHART_BAR_MAX_PX       = 80;   // pixel height of the tallest bar

/**
 * Renders the full report (stats summary, 7-day chart, struggling words,
 * recently mastered words) into the `reportBody` element.
 */
function renderReport() {
  const allSessions = Stats._sessions;
  const allWS       = Stats._ws;

  // ── Overall totals ──────────────────────────────────────────
  let totCorrect = 0, totWrong = 0, totSkipped = 0;
  for (const s of Object.values(allWS)) {
    totCorrect  += s.correct  || 0;
    totWrong    += s.wrong    || 0;
    totSkipped  += s.skipped  || 0;
  }
  const totAnswered  = totCorrect + totWrong;
  const overallRate  = totAnswered > 0 ? Math.round(totCorrect / totAnswered * 100) : 0;

  // ── Mastered: ≥5 attempts, ≥80% accuracy ───────────────────
  const mastered = Object.entries(allWS).filter(([, s]) => {
    const att = s.correct + s.wrong;
    return att >= REPORT_MASTERED_MIN_ATTEMPTS && s.correct / att >= REPORT_MASTERED_MIN_ACCURACY;
  });

  // ── Active study days ───────────────────────────────────────
  const studyDays = new Set(allSessions.map(s => s.date).filter(Boolean)).size;

  // ── Last 7 days ─────────────────────────────────────────────
  const days = [];
  const now  = new Date();
  for (let i = REPORT_DAYS_HISTORY - 1; i >= 0; i--) {
    const d    = new Date(now); d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const day  = d.toLocaleDateString('en', { weekday: 'short' });
    const ss   = allSessions.filter(s => s.date === date);
    days.push({
      date, day, isToday: i === 0,
      correct: ss.reduce((n, s) => n + (s.correct || 0), 0),
      wrong:   ss.reduce((n, s) => n + (s.wrong   || 0), 0),
      skipped: ss.reduce((n, s) => n + (s.skipped || 0), 0),
    });
  }
  const maxDay = Math.max(...days.map(d => d.correct + d.wrong + d.skipped), 1);

  /**
   * Maps a count to a bar height in pixels, capped at REPORT_CHART_BAR_MAX_PX.
   * @param {number} n
   * @returns {number}
   */
  function barH(n) { return Math.max(0, Math.round((n / maxDay) * REPORT_CHART_BAR_MAX_PX)); }

  const chartHTML = `
    <div>
      <div class="report-section-title">Last 7 Days</div>
      <div class="chart-wrap">
        ${days.map(d => {
          const total = d.correct + d.wrong + d.skipped;
          return `
          <div class="chart-col${d.isToday ? ' chart-today' : ''}">
            <div class="chart-bars">
              <div class="chart-bar-wrong"   style="height:${barH(d.wrong)}px"></div>
              <div class="chart-bar-skipped" style="height:${barH(d.skipped)}px"></div>
              <div class="chart-bar-correct" style="height:${barH(d.correct)}px"></div>
            </div>
            <div class="chart-day-label">${d.day}</div>
            <div class="chart-day-total">${total || '—'}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="chart-legend">
        <div class="legend-item"><div class="legend-dot" style="background:var(--mint)"></div>correct</div>
        <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div>wrong</div>
        <div class="legend-item"><div class="legend-dot" style="background:var(--bg2);border:1px solid var(--ink-light)"></div>skipped</div>
      </div>
    </div>`;

  // ── Needs practice: ≥3 attempts, >40% wrong ────────────────

  /**
   * Returns the display label for a word: "article de" or "#id".
   * @param {number|string} id
   * @returns {string}
   */
  function wordLabel(id) {
    const w = WORDS_DATA.find(x => String(x.id) === String(id));
    return w ? `${w.article ? w.article + ' ' : ''}${w.de}` : `#${id}`;
  }

  /**
   * Returns the English translation of a word, or empty string if not found.
   * @param {number|string} id
   * @returns {string}
   */
  function wordSub(id) {
    const w = WORDS_DATA.find(x => String(x.id) === String(id));
    return w ? w.en : '';
  }

  /**
   * Returns the CSS modifier class for an accuracy percentage.
   * @param {number} pct
   * @returns {'good'|'mid'|'bad'}
   */
  function accClass(pct) { return pct >= ACCURACY_GOOD_THRESHOLD ? 'good' : pct >= ACCURACY_MID_THRESHOLD ? 'mid' : 'bad'; }

  const struggling = Object.entries(allWS)
    .filter(([, s]) => (s.correct + s.wrong) >= REPORT_STRUGGLE_MIN_ATTEMPTS && s.wrong / (s.correct + s.wrong) > REPORT_STRUGGLE_WRONG_RATE)
    .sort(([, a], [, b]) => (b.wrong / (b.correct + b.wrong)) - (a.wrong / (a.correct + a.wrong)))
    .slice(0, REPORT_STRUGGLE_MAX_DISPLAY);

  const struggleHTML = struggling.length === 0
    ? '<div class="report-empty">No struggling words yet — keep practicing!</div>'
    : `<div class="word-list">${struggling.map(([id, s]) => {
        const att = s.correct + s.wrong, pct = Math.round(s.correct / att * 100);
        return `<div class="word-row">
          <div class="word-row-de">${wordLabel(id)}</div>
          <div class="word-row-en">${wordSub(id)}</div>
          <div class="word-row-acc ${accClass(pct)}">${pct}%</div>
          <div class="word-row-count">${att} tries</div>
        </div>`;
      }).join('')}</div>`;

  // ── Recently mastered ───────────────────────────────────────
  const recentMastered = mastered
    .sort(([, a], [, b]) => (b.last_seen || '').localeCompare(a.last_seen || ''))
    .slice(0, REPORT_MASTERED_MAX_DISPLAY);

  const masteredHTML = recentMastered.length === 0
    ? '<div class="report-empty">No mastered words yet (need ≥ 5 attempts at ≥ 80%).</div>'
    : `<div class="word-list">${recentMastered.map(([id, s]) => {
        const att = s.correct + s.wrong, pct = Math.round(s.correct / att * 100);
        return `<div class="word-row">
          <div class="word-row-de">${wordLabel(id)}</div>
          <div class="word-row-en">${wordSub(id)}</div>
          <div class="word-row-acc ${accClass(pct)}">${pct}%</div>
          <div class="word-row-count">${att} tries</div>
        </div>`;
      }).join('')}</div>`;

  $('reportBody').innerHTML = `
    <div>
      <div class="report-stats-row">
        <div class="report-stat">
          <div class="report-stat-num n">${totAnswered}</div>
          <div class="report-stat-label">Cards Answered</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-num ${overallRate >= 70 ? 'c' : overallRate >= 40 ? 'n' : 'r'}">${overallRate}%</div>
          <div class="report-stat-label">Success Rate</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-num c">${mastered.length}</div>
          <div class="report-stat-label">Mastered</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-num n">${studyDays}</div>
          <div class="report-stat-label">Study Days</div>
        </div>
      </div>
    </div>

    ${chartHTML}

    <div>
      <div class="report-section-title">Needs Practice</div>
      ${struggleHTML}
    </div>

    <div>
      <div class="report-section-title">Mastered (≥ 5 attempts · ≥ 80%)</div>
      ${masteredHTML}
    </div>
  `;
}

/**
 * Applies a visual selection state to all option buttons in a group,
 * marking the chosen value as selected.
 * @param {string} group - The `data-g` attribute value identifying the option group
 * @param {string} value - The `data-v` attribute value of the chosen option
 */
function applyOpt(group, value) {
  document.querySelectorAll(`[data-g="${group}"]`).forEach(el => {
    const isMe = el.dataset.v === value;
    el.classList.toggle('sel', isMe);
    el.querySelector('.opt-check').textContent = isMe ? '✓' : '';
  });
}

// ═══════════════════════════════════════════════════════════════
//  DOM HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Shorthand for `document.getElementById`.
 * @param {string} id
 * @returns {HTMLElement}
 */
function $(id) { return document.getElementById(id); }

/**
 * Removes the `hidden` class from the element with the given ID.
 * @param {string} id
 */
function show(id) { $(id).classList.remove('hidden'); }

/**
 * Adds the `hidden` class to the element with the given ID.
 * @param {string} id
 */
function hide(id) { $(id).classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════

// Header buttons
$('btnReport').addEventListener('click', openReport);
$('btnReportClose').addEventListener('click', closeReport);
$('btnSettings').addEventListener('click', openSettings);
$('btnShuffle').addEventListener('click', () => { startSession(); closeSettings(); });
$('overlay').addEventListener('click', closeSettings);
$('btnRestart').addEventListener('click', startSession);

// Flip mode
$('flipScene').addEventListener('click', doFlip);
$('btnFlip').addEventListener('click',  e => { e.stopPropagation(); doFlip(); });
$('fBtnWrong').addEventListener('click', () => advance('wrong'));
$('fBtnSkip').addEventListener('click',  () => advance('skip'));
$('fBtnRight').addEventListener('click', () => advance('correct'));

// Type mode
$('btnCheck').addEventListener('click', doCheck);
$('tBtnWrong').addEventListener('click', () => advance('wrong'));
$('tBtnSkip').addEventListener('click',  () => advance('skip'));
$('tBtnRight').addEventListener('click', () => advance('correct'));

$('typeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!sess.checked) doCheck();
  }
});

// Settings — event delegation (covers static + dynamically built tag options)
let _cfgDirty = false;
$('settingsPanel').addEventListener('click', e => {
  const el = e.target.closest('.opt');
  if (!el) return;
  const g = el.dataset.g, v = el.dataset.v;
  if (!g) return;

  if (g === 'tag') {
    if (!v) {
      cfg.tags = [];            // "All words" clears selection
    } else {
      const idx = cfg.tags.indexOf(v);
      if (idx >= 0) cfg.tags.splice(idx, 1);
      else          cfg.tags.push(v);
    }
    renderTagOpts();
    _cfgDirty = true;
    return;
  }

  applyOpt(g, v);
  if (g === 'mode')    cfg.mode = v;
  if (g === 'lang')    cfg.lang = v;
  if (g === 'article') cfg.requireArticle = v === 'yes';
  _cfgDirty = true;
});

let _allTags = [], _tagCounts = {};

/**
 * Builds tag metadata from loaded vocabulary and renders the tag list.
 * Called once after WORDS_DATA is available, and after new words are added.
 */
function buildTagFilter() {
  const counts = {};
  for (const w of WORDS_DATA) {
    for (const t of (w.tags || [])) counts[t] = (counts[t] || 0) + 1;
  }
  _allTags   = Object.keys(counts).sort();
  _tagCounts = counts;
  renderTagOpts();
}

/**
 * Returns true if every character of query appears in order inside str.
 * @param {string} query
 * @param {string} str
 */
function _fuzzyMatch(query, str) {
  query = query.toLowerCase();
  str   = str.toLowerCase();
  let qi = 0;
  for (let i = 0; i < str.length && qi < query.length; i++) {
    if (str[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Re-renders the tag option list, applying the current fuzzy search query
 * and highlighting all currently selected tags.
 */
function renderTagOpts() {
  const query      = ($('tagSearch').value || '').trim();
  const cap        = s => s.charAt(0).toUpperCase() + s.slice(1);
  const visible    = query ? _allTags.filter(t => _fuzzyMatch(query, t)) : _allTags;
  const matchCount = cfg.tags.length
    ? WORDS_DATA.filter(w => w.tags && cfg.tags.some(t => w.tags.includes(t))).length
    : WORDS_DATA.length;
  const allSel     = cfg.tags.length === 0;

  let html = `<div class="opt${allSel ? ' sel' : ''}" data-g="tag" data-v="">All words (${matchCount}) <span class="opt-check">${allSel ? '✓' : ''}</span></div>`;
  for (const t of visible) {
    const sel = cfg.tags.includes(t);
    html += `<div class="opt${sel ? ' sel' : ''}" data-g="tag" data-v="${t}">${cap(t)} (${_tagCounts[t]}) <span class="opt-check">${sel ? '✓' : ''}</span></div>`;
  }
  $('tagOpts').innerHTML = html;
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  const settingsOpen = $('settingsPanel').classList.contains('open');
  const writeOpen    = $('writePanel').classList.contains('open');
  const doneScreen   = $('completeScreen').classList.contains('active');

  if (settingsOpen || writeOpen) return;

  if (doneScreen) {
    if (e.key === 'Enter') startSession();
    return;
  }

  if (cfg.mode === 'flip') {
    if ((e.key === ' ' || e.code === 'Space') && !sess.flipped) {
      e.preventDefault();
      doFlip();
    } else if (e.key === 'ArrowLeft'  && sess.flipped) advance('wrong');
    else if    (e.key === 'ArrowRight' && sess.flipped) advance('correct');
    else if    (e.key === 'ArrowDown'  && sess.flipped) advance('skip');

  } else {
    // type mode — Enter handled by input listener
    if (e.key === 'ArrowLeft'  && sess.checked) advance('wrong');
    else if (e.key === 'ArrowRight' && sess.checked) advance('correct');
    else if (e.key === 'ArrowDown'  && sess.checked) advance('skip');
  }
});

// ═══════════════════════════════════════════════════════════════
//  BOOT — load words.yaml + stats.yaml in parallel, then start
// ═══════════════════════════════════════════════════════════════
const fetchWords = fetch('words.yaml')
  .then(r => { if (!r.ok) throw new Error('words.yaml not found'); return r.text(); })
  .then(t => parseYAML(t));

const fetchStats = fetch('stats.yaml')
  .then(r => r.ok ? r.text() : '')
  .then(t => t ? parseStatsYAML(t) : { word_stats: {}, sessions: [] })
  .catch(() => ({ word_stats: {}, sessions: [] }));

Promise.all([fetchWords, fetchStats])
  .then(([words, statsData]) => {
    window.WORDS_DATA = words;
    Stats.init(statsData);
    buildTagFilter();
    startSession();
    // Auto-open review mode if URL has ?review=slug
    const reviewSlug = new URLSearchParams(window.location.search).get('review');
    if (reviewSlug) {
      openWrite();
      fetch(`/text/${reviewSlug}`)
        .then(r => r.json())
        .then(entry => { if (entry.ok !== false) _wOpenTeacher(entry); })
        .catch(() => {});
    }
  })
  .catch(() => {
    $('mainArea').innerHTML = `
      <div style="max-width:480px;text-align:center;display:flex;flex-direction:column;gap:20px;align-items:center;">
        <div style="font-family:var(--font-word);font-size:52px;font-weight:900;line-height:1;">Oops.</div>
        <div style="font-size:15px;font-weight:600;color:var(--ink-mid);line-height:1.5;">
          The app needs a local server to load <code style="font-family:var(--font-mono);background:var(--bg2);padding:2px 6px;">words.yaml</code>.<br>
          Opening as <code style="font-family:var(--font-mono);background:var(--bg2);padding:2px 6px;">file://</code> blocks file fetching.
        </div>
        <div style="border:var(--border);padding:20px 24px;text-align:left;width:100%;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:var(--ink-light);margin-bottom:10px;">Run once in terminal:</div>
          <code style="font-family:var(--font-mono);font-size:14px;">cd ~/memo &amp;&amp; python3 server.py</code>
        </div>
        <div style="font-size:13px;color:var(--ink-light);">Then open <strong>http://localhost:8080</strong> in your browser.</div>
      </div>`;
  });

// ═══════════════════════════════════════════════════════════════
//  ADD WORD
// ═══════════════════════════════════════════════════════════════

/** Interval handle for the status-poll loop, or null when idle. */
let _addWordPollInterval = null;

/**
 * Opens the Add Word panel and focuses the word input.
 */
function openAddWord() {
  $('addWordPanel').classList.add('open');
  $('overlay').classList.add('open');
  setTimeout(() => $('addWordInput').focus(), 60);
}

/**
 * Closes the Add Word panel and cancels any in-progress poll.
 */
function closeAddWord() {
  $('addWordPanel').classList.remove('open');
  $('overlay').classList.remove('open');
  _stopPoll();
}

/**
 * Submits the word from the input to POST /add-word, then
 * starts polling /add-word-status until the agent responds.
 */
async function submitWord() {
  const word = $('addWordInput').value.trim();
  const hint = $('addWordHint').value.trim();
  if (!word) { $('addWordInput').focus(); return; }

  _setAddWordLoading(true);
  $('addWordStatus').innerHTML = `
    <div class="aw-status-pending">
      <div class="aw-spinner"></div>
      Claude is processing…
    </div>`;

  try {
    const res  = await fetch('/add-word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, hint }),
    });
    const data = await res.json();

    if (!data.ok) throw new Error(data.error || 'Server error');

    _startPoll(data.requestId);

  } catch (e) {
    _setAddWordLoading(false);
    $('addWordStatus').innerHTML = `<div class="aw-status-error">✗ ${e.message}</div>`;
  }
}

/**
 * Starts polling /add-word-status every 2 seconds for the given requestId.
 * @param {string} requestId
 */
function _startPoll(requestId) {
  _stopPoll();
  _addWordPollInterval = setInterval(async () => {
    try {
      const res  = await fetch(`/add-word-status?id=${requestId}`);
      const data = await res.json();

      if (data.pending) return; // still processing
      if (data.skipped) { _onWordExists(data.entry); return; }

      _stopPoll();
      _setAddWordLoading(false);

      if (data.needs_review) {
        _showNeedsReview(data.question);
      } else if (data.ok && data.entries) {
        _onBatchAdded(data.entries, data.skippedCount || 0);
      } else if (data.ok && data.entry) {
        _onWordAdded(data.entry);
      } else {
        $('addWordStatus').innerHTML = `<div class="aw-status-error">✗ ${data.error || 'Unknown error'}</div>`;
      }
    } catch (_) { /* network hiccup — keep polling */ }
  }, 2000);
}

/**
 * Cancels the active poll interval.
 */
function _stopPoll() {
  if (_addWordPollInterval) { clearInterval(_addWordPollInterval); _addWordPollInterval = null; }
}

/**
 * Enables or disables the add-word form while a request is in flight.
 * @param {boolean} loading
 */
function _setAddWordLoading(loading) {
  $('addWordInput').disabled  = loading;
  $('addWordHint').disabled   = loading;
  $('btnSubmitWord').disabled = loading;
  $('btnSubmitWord').textContent = loading ? '…' : 'ADD →';
}

/**
 * Called when the agent successfully processes a word.
 * Pushes it into WORDS_DATA, rebuilds the tag filter, shows a preview,
 * and optionally injects it at the front of the current session.
 * @param {object} entry - The new word entry returned by the agent
 */
function _onWordAdded(entry) {
  // Add to live word list
  window.WORDS_DATA.push(entry);
  buildTagFilter();

  const de = entry.article ? `${entry.article} ${entry.de}` : entry.de;
  const tags = (entry.tags || []).join(', ');

  $('addWordStatus').innerHTML = `
    <div class="aw-preview">
      <div class="aw-preview-de">${de}</div>
      <div class="aw-preview-meta">${entry.type || ''} · #${entry.id}</div>
      <div class="aw-preview-trans">${entry.en} · ${entry.uk}</div>
      <div class="aw-preview-tags">${tags}</div>
      <div class="aw-preview-actions">
        <button class="btn btn-primary" onclick="_studyNewWord(${entry.id})" style="margin-left:0;">Study now →</button>
        <button class="btn" onclick="_resetAddWordForm()">Add another</button>
      </div>
    </div>`;

  // Reset inputs ready for the next submission
  $('addWordInput').value = '';
  $('addWordHint').value  = '';
}

/**
 * Called when the submitted word already exists in the deck.
 * Shows its entry details without re-adding it.
 * @param {object} entry
 */
function _onWordExists(entry) {
  const de   = (entry.article && entry.article !== '~') ? `${entry.article} ${entry.de}` : entry.de;
  const tags = (entry.tags || []).join(', ');
  $('addWordStatus').innerHTML = `
    <div class="aw-preview aw-exists">
      <div class="aw-exists-label">Already in your deck</div>
      <div class="aw-preview-de">${de}</div>
      <div class="aw-preview-meta">${entry.type || ''} · #${entry.id}</div>
      <div class="aw-preview-trans">${entry.en || ''} · ${entry.uk || ''}</div>
      <div class="aw-preview-tags">${tags}</div>
      <div class="aw-preview-actions">
        <button class="btn btn-primary" onclick="_studyNewWord(${entry.id})" style="margin-left:0;">Study it now →</button>
        <button class="btn" onclick="_resetAddWordForm()">Add another</button>
      </div>
    </div>`;
  $('addWordInput').value = '';
  $('addWordHint').value  = '';
}

/**
 * Shows a "needs review" message when the agent cannot confidently process a word.
 * @param {string} question - The question from the agent
 */
function _showNeedsReview(question) {
  $('addWordStatus').innerHTML = `
    <div class="aw-needs-review">
      <div class="aw-needs-review-label">⚠ Needs review</div>
      ${question || 'Check the terminal — Claude needs clarification.'}
    </div>`;
}

/**
 * Injects the newly added word at the front of the current session
 * (weight 10 so it appears as the next card) and navigates to it.
 * @param {number} id
 */
function _studyNewWord(id) {
  const word = window.WORDS_DATA.find(w => w.id === id);
  if (!word) return;
  sess.words.splice(sess.idx, 0, word);
  showCard(sess.words[sess.idx]);
  closeAddWord();
}

/**
 * Resets the add-word form and status area for a fresh submission.
 */
function _resetAddWordForm() {
  $('addWordStatus').innerHTML = '';
  $('addWordInput').focus();
}

// ═══════════════════════════════════════════════════════════════
// ── Batch Import ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/** Currently selected file for batch import, or null. */
let _batchFile = null;

/** Sets up drag-and-drop and click-to-select on the drop zone. */
function _initDropzone() {
  const zone  = $('awDropzone');
  const input = $('awFileInput');
  const inner = $('awDropInner');

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) _setBatchFile(input.files[0]);
  });

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) _setBatchFile(e.dataTransfer.files[0]);
  });
}

/**
 * Registers the selected file and updates the drop zone display.
 * @param {File} file
 */
function _setBatchFile(file) {
  _batchFile = file;
  $('awDropInner').innerHTML = `
    <span class="aw-drop-icon">✓</span>
    ${file.name}<br>
    <span class="aw-drop-sub">click to change</span>`;
  $('awDropzone').classList.add('has-file');
}

/**
 * Submits the batch import (file or URL) to POST /add-batch.
 */
async function submitBatch() {
  const url  = $('awUrlInput').value.trim();
  const hint = $('awBatchHint').value.trim();

  if (!_batchFile && !url) {
    $('awBatchStatus').innerHTML = `<div class="aw-status-error">Drop a file or enter a URL.</div>`;
    return;
  }

  $('btnSubmitBatch').disabled    = true;
  $('btnSubmitBatch').textContent = '…';
  $('awBatchStatus').innerHTML    = `<div class="aw-status-pending"><div class="aw-spinner"></div> Queuing import…</div>`;

  try {
    let body;
    if (_batchFile) {
      const b64 = await _fileToBase64(_batchFile);
      body = {
        source:   _batchFile.type === 'application/pdf' ? 'pdf' : 'image',
        data:     b64,
        filename: _batchFile.name,
        hint,
      };
    } else {
      body = { source: 'url', url, hint };
    }

    const res  = await fetch('/add-batch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();

    if (!data.ok) throw new Error(data.error || 'Server error');

    $('awBatchStatus').innerHTML = `<div class="aw-status-pending"><div class="aw-spinner"></div> Processing… check queue below</div>`;
    _startPoll(data.requestId);

    // Reset for next import
    _batchFile = null;
    $('awFileInput').value   = '';
    $('awUrlInput').value    = '';
    $('awBatchHint').value   = '';
    $('awDropInner').innerHTML = `<span class="aw-drop-icon">⊕</span> Drop image or PDF<br><span class="aw-drop-sub">or click to select</span>`;
    $('awDropzone').classList.remove('has-file');

  } catch (e) {
    $('awBatchStatus').innerHTML = `<div class="aw-status-error">✗ ${e.message}</div>`;
  } finally {
    $('btnSubmitBatch').disabled    = false;
    $('btnSubmitBatch').textContent = 'IMPORT →';
  }
}

/**
 * Called when a batch import completes successfully.
 * @param {object[]} entries - Array of newly added entries
 * @param {number}   skippedCount - Number of duplicates skipped
 */
function _onBatchAdded(entries, skippedCount) {
  // Add all new entries to the live word list
  for (const entry of entries) {
    if (!window.WORDS_DATA.find(w => w.id === entry.id)) {
      window.WORDS_DATA.push(entry);
    }
  }
  buildTagFilter();

  const lines = entries.map(e => {
    const de = (e.article && e.article !== '~') ? `${e.article} ${e.de}` : e.de;
    return `<div class="aw-batch-row"><span class="aw-batch-de">${de}</span> <span class="aw-batch-trans">${e.en}</span></div>`;
  }).join('');

  const skipNote = skippedCount > 0 ? `<div class="aw-batch-skip">${skippedCount} duplicate(s) skipped</div>` : '';

  $('awBatchStatus').innerHTML = `
    <div class="aw-preview">
      <div class="aw-preview-meta">✓ Added ${entries.length} word${entries.length !== 1 ? 's' : ''}</div>
      <div class="aw-batch-list">${lines}</div>
      ${skipNote}
    </div>`;
}

/**
 * Reads a File as a base64 string (without the data: URI prefix).
 * @param {File} file
 * @returns {Promise<string>}
 */
function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Batch import event listeners
$('btnSubmitBatch').addEventListener('click', submitBatch);
$('awUrlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitBatch(); }
});
_initDropzone();

// Add Word event listeners
$('btnAddWord').addEventListener('click', openAddWord);
$('btnSubmitWord').addEventListener('click', submitWord);
$('addWordInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitWord(); }
  if (e.key === 'Escape') closeAddWord();
});
$('addWordHint').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitWord(); }
  if (e.key === 'Escape') closeAddWord();
});

// Tag search — fuzzy filter the tag list as the user types
$('tagSearch').addEventListener('input', renderTagOpts);
$('tagSearch').addEventListener('keydown', e => { if (e.key === 'Escape') $('tagSearch').value = '', renderTagOpts(); });

// Close add-word panel when overlay is clicked (overlay is shared with settings)
// Override the existing overlay listener to handle both panels
$('overlay').removeEventListener('click', closeSettings);
$('overlay').addEventListener('click', () => {
  if ($('settingsPanel').classList.contains('open')) closeSettings();
  if ($('addWordPanel').classList.contains('open'))  closeAddWord();
});

// ═══════════════════════════════════════════════════════════════
//  QUEUE VISUALISER
// ═══════════════════════════════════════════════════════════════

/** Interval handle for the queue poll, or null when panel is closed. */
let _queuePollInterval = null;

/**
 * Fetches /add-word-queue and re-renders the queue list and pending badge.
 * Called on panel open and every 2 seconds while the panel is open.
 */
async function refreshQueue() {
  try {
    const res   = await fetch('/add-word-queue');
    const data  = await res.json();
    if (!data.ok) return;
    _renderQueue(data.items || []);
    _updatePendingBadge(data.items || []);
  } catch (_) { /* ignore network hiccups */ }
}

/**
 * Renders the queue item list into #addWordQueue.
 * @param {object[]} items
 */
function _renderQueue(items) {
  const el = $('addWordQueue');
  if (items.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  const ICON = { pending: '○', done: '✓', needs_review: '⚠', error: '✗' };

  el.innerHTML = `
    <div class="aw-queue-title">Queue (${items.length})</div>
    ${items.map(item => {
      const icon  = ICON[item.status] || '○';
      const de    = item.result?.entry ? (item.result.entry.article ? `${item.result.entry.article} ${item.result.entry.de}` : item.result.entry.de) : '';
      const spin  = item.status === 'pending' ? '<div class="aw-spinner" style="width:12px;height:12px;flex-shrink:0"></div>' : `<span class="aw-queue-icon ${item.status}">${icon}</span>`;
      return `
        <div class="aw-queue-item">
          ${spin}
          <span class="aw-queue-word">${item.word}</span>
          ${de ? `<span class="aw-queue-de">${de}</span>` : ''}
        </div>`;
    }).join('')}`;
}

/**
 * Updates the pending count badge on the + button.
 * Shows the badge only when there are pending items.
 * @param {object[]} items
 */
function _updatePendingBadge(items) {
  const count = items.filter(i => i.status === 'pending').length;
  const badge = $('pendingBadge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/**
 * Starts the queue poll (every 2s). Called when the add-word panel opens.
 */
function _startQueuePoll() {
  _stopQueuePoll();
  refreshQueue();
  _queuePollInterval = setInterval(refreshQueue, 2000);
}

/**
 * Stops the queue poll. Called when the add-word panel closes.
 */
function _stopQueuePoll() {
  if (_queuePollInterval) { clearInterval(_queuePollInterval); _queuePollInterval = null; }
}

// Patch openAddWord / closeAddWord to start/stop the queue poll
const _origOpenAddWord  = openAddWord;
const _origCloseAddWord = closeAddWord;

openAddWord = function () {
  _origOpenAddWord();
  _startQueuePoll();
};

closeAddWord = function () {
  _origCloseAddWord();
  _stopQueuePoll();
};

// Keep the badge updated globally (poll even when panel is closed)
setInterval(async () => {
  try {
    const res  = await fetch('/add-word-queue');
    const data = await res.json();
    if (data.ok) _updatePendingBadge(data.items || []);
  } catch (_) {}
}, 5000);

// ═══════════════════════════════════════════════════════════════
//  WRITING MODE
// ═══════════════════════════════════════════════════════════════

/** Opens the full-screen writing panel. */
function openWrite() {
  $('writePanel').classList.add('open');
  _wShowView('student');
  _wLoadTexts();
  $('wTextarea').focus();
}

/** Closes the writing panel. */
function closeWrite() {
  $('writePanel').classList.remove('open');
}

/**
 * Switches between the two writing sub-views.
 * @param {'student'|'teacher'} view
 */
function _wShowView(view) {
  const views     = { student: 'wViewStudent', teacher: 'wViewTeacher' };
  const subtitles = { student: 'Student Mode', teacher: 'Teacher Mode' };
  for (const [k, id] of Object.entries(views))
    $(id).classList.toggle('hidden', k !== view);
  $('wSubtitle').textContent = subtitles[view];
}

// Update word count as student types
$('wTextarea').addEventListener('input', () => {
  const n = $('wTextarea').value.trim().split(/\s+/).filter(Boolean).length;
  $('wWordCount').textContent = n === 1 ? '1 Wort' : `${n} Wörter`;
});

/** Holds the student's original text while the teacher edits. */
let _wOriginal = '';

/** Updates the live diff panel from the current correction textarea value. */
function _wUpdateDiff() {
  $('wDiffOutput').innerHTML = _renderDiff(_wOriginal, $('wCorrectionArea').value);
}

// Share for Review: prompt for name, save, then open teacher mode
$('btnSendToTeacher').addEventListener('click', () => {
  const text = $('wTextarea').value.trim();
  if (!text) return;
  $('wSaveRow').classList.remove('hidden');
  $('wSaveName').value = '';
  $('wSaveName').focus();
});

// Live diff: update on every keystroke
$('wCorrectionArea').addEventListener('input', _wUpdateDiff);

$('btnTeacherBack').addEventListener('click', () => _wShowView('student'));

// New text: reset to student view
$('btnWriteNew').addEventListener('click', () => {
  $('wTextarea').value = '';
  $('wWordCount').textContent = '0 Wörter';
  _wOriginal = '';
  _wCurrentSlug = null;
  _wRenderStrip();
  _wShowView('student');
  history.replaceState(null, '', window.location.pathname);
  $('wTextarea').focus();
});

$('btnWriteClose').addEventListener('click', closeWrite);
$('btnWrite').addEventListener('click', openWrite);

// Escape closes the write panel
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('writePanel').classList.contains('open')) closeWrite();
});

// ── Diff algorithm ───────────────────────────────────────────

/**
 * Splits text into word tokens, treating newlines as paragraph-break sentinels.
 * @param {string} text
 * @returns {string[]}
 */
function _wTokenize(text) {
  const tokens = [];
  const lines  = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const w of lines[i].split(/\s+/)) if (w) tokens.push(w);
    if (i < lines.length - 1) tokens.push('\n');
  }
  // Trim trailing newline sentinels
  while (tokens.length && tokens[tokens.length - 1] === '\n') tokens.pop();
  return tokens;
}

/**
 * LCS-based word-level diff.
 * Returns array of {type:'equal'|'delete'|'insert', tokens:string[]}.
 * @param {string} original
 * @param {string} corrected
 */
function _wComputeDiff(original, corrected) {
  const a = _wTokenize(original);
  const b = _wTokenize(corrected);
  const m = a.length, n = b.length;

  // Build LCS DP table
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  // Backtrack
  const raw = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      raw.push({ type: 'equal',  token: a[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      raw.push({ type: 'insert', token: b[j-1] }); j--;
    } else {
      raw.push({ type: 'delete', token: a[i-1] }); i--;
    }
  }
  raw.reverse();

  // Merge consecutive same-type items into chunks
  const chunks = [];
  for (const item of raw) {
    if (chunks.length && chunks[chunks.length - 1].type === item.type)
      chunks[chunks.length - 1].tokens.push(item.token);
    else
      chunks.push({ type: item.type, tokens: [item.token] });
  }
  return chunks;
}

/**
 * Escapes HTML special characters.
 * @param {string} s
 */
function _escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders the diff of original vs corrected as tracked-changes HTML.
 * Deletions are shown with red strikethrough; insertions with green underline.
 * @param {string} original
 * @param {string} corrected
 * @returns {string} HTML string
 */
function _renderDiff(original, corrected) {
  const chunks = _wComputeDiff(original, corrected);
  // Flatten to a stream of {type, token} so we can control spacing precisely
  const stream = chunks.flatMap(c => c.tokens.map(t => ({ type: c.type, token: t })));

  let html = '';
  let prevNl = true; // treat start as after-newline to skip leading space

  for (let i = 0; i < stream.length; i++) {
    const { type, token } = stream[i];

    if (token === '\n') {
      html += '<br>';
      prevNl = true;
      continue;
    }

    if (!prevNl) html += ' ';
    prevNl = false;

    const esc = _escHtml(token);
    if      (type === 'equal')  html += esc;
    else if (type === 'delete') html += `<span class="diff-del">${esc}</span>`;
    else                        html += `<span class="diff-ins">${esc}</span>`;
  }
  return html;
}

// ═══════════════════════════════════════════════════════════════
//  TEXT LIBRARY  (save / load writing practice texts)
// ═══════════════════════════════════════════════════════════════

let _wCurrentSlug = null;  // slug of the currently loaded text, or null if unsaved
let _wTexts       = [];    // [{name, slug, saved, hasCorrection}]

/** Fetches /list-texts and refreshes the chip strip. */
async function _wLoadTexts() {
  try {
    const r = await fetch('/list-texts');
    _wTexts = r.ok ? (await r.json()).texts || [] : [];
  } catch (_) {
    _wTexts = [];
  }
  _wRenderStrip();
}

/** Renders saved-text chips. Always ends with a "+ New" chip. */
function _wRenderStrip() {
  const strip = $('wTextsStrip');
  const chips = _wTexts.map(t => {
    const label   = t.name.length > 22 ? t.name.slice(0, 20) + '…' : t.name;
    const corrDot = t.hasCorrection ? '<span class="write-chip-corr" title="Has correction">·</span>' : '';
    return `<button class="write-chip${t.slug === _wCurrentSlug ? ' active' : ''}" data-slug="${t.slug}">${corrDot}${_escHtml(label)}<span class="write-chip-del" data-del="${t.slug}">×</span></button>`;
  }).join('');
  strip.innerHTML = chips + `<button class="write-chip write-chip-new" data-new>+ New</button>`;
}

/** POSTs to /save-text, updates _wCurrentId, reloads strip. */
/** Briefly flashes a button label to confirm a save. */
function _wFlashSaved(btnId, label) {
  const btn = $(btnId);
  btn.textContent = 'Saved ✓';
  setTimeout(() => { btn.textContent = label; }, 1500);
}

/** Saves the teacher's correction for the current (always-named) text. */
async function _wSaveCorrection() {
  if (!_wCurrentSlug) return;
  const correction = $('wCorrectionArea').value;
  try {
    const res  = await fetch('/save-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: _wCurrentSlug, correction }),
    });
    const data = await res.json();
    if (data.ok) { await _wLoadTexts(); _wFlashSaved('btnSaveCorrection', 'Save Correction'); }
  } catch (_) {}
}

/** Deletes a saved text by slug. */
async function _wDeleteText(slug) {
  try {
    await fetch('/delete-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    if (_wCurrentSlug === slug) { _wCurrentSlug = null; _wShowView('student'); }
    await _wLoadTexts();
  } catch (_) {}
}

function _hideSaveRow() {
  $('wSaveRow').classList.add('hidden');
  $('wSaveName').value = '';
}

/**
 * Opens teacher mode for a full entry object {name, slug, text, correction?, …}.
 * Updates the URL to ?review=slug without a page reload.
 */
function _wOpenTeacher(entry) {
  _wCurrentSlug = entry.slug;
  _wOriginal    = entry.text || '';
  $('wCorrectionArea').value = entry.correction || entry.text || '';
  _wUpdateDiff();
  _wRenderStrip();
  _wShowView('teacher');
  $('wCorrectionArea').focus();
  // Update browser URL so the review link is shareable
  history.replaceState(null, '', `?review=${entry.slug}`);
  // Show the review URL in the toolbar
  $('wReviewUrl').textContent = window.location.href;
  $('wReviewUrl').classList.remove('hidden');
}

// Strip click — open teacher mode, delete ×, or new
$('wTextsStrip').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); _wDeleteText(del.dataset.del); return; }

  const chip = e.target.closest('.write-chip');
  if (!chip) return;

  if ('new' in chip.dataset) {
    _wCurrentSlug = null;
    $('wTextarea').value = '';
    $('wWordCount').textContent = '0 Wörter';
    _wRenderStrip();
    _hideSaveRow();
    _wShowView('student');
    history.replaceState(null, '', window.location.pathname);
    $('wTextarea').focus();
    return;
  }

  // Fetch full text from server then open teacher mode
  const slug = chip.dataset.slug;
  if (!slug) return;
  try {
    const r     = await fetch(`/text/${slug}`);
    const entry = await r.json();
    if (entry.ok !== false) _wOpenTeacher(entry);
  } catch (_) {}
});

// Share for Review: save text with name, then open teacher mode
$('btnSaveConfirm').addEventListener('click', async () => {
  const name = $('wSaveName').value.trim();
  const text = $('wTextarea').value.trim();
  if (!name || !text) return;
  _hideSaveRow();
  try {
    const res  = await fetch('/save-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text }),
    });
    const data = await res.json();
    if (data.ok) {
      await _wLoadTexts();
      const r     = await fetch(`/text/${data.slug}`);
      const entry = await r.json();
      if (entry.ok !== false) _wOpenTeacher(entry);
    }
  } catch (_) {}
});

$('wSaveName').addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); $('btnSaveConfirm').click(); }
  if (e.key === 'Escape') _hideSaveRow();
});

$('btnSaveCancel').addEventListener('click', _hideSaveRow);

$('btnSaveCorrection').addEventListener('click', _wSaveCorrection);

// Click review URL to copy it
$('wReviewUrl').addEventListener('click', () => {
  const url = $('wReviewUrl').textContent;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    const el = $('wReviewUrl');
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1500);
  });
});
