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
  limit:          null,     // null = all; number = max words per session
};

/** @type {{ words: object[], idx: number, correct: number, wrong: number, skipped: number, flipped: boolean, checked: boolean, startTime: number|null, history: Array<{word: object, outcome: string}> }} */
const sess = {
  words:     [],
  idx:       0,
  correct:   0,
  wrong:     0,
  skipped:   0,
  flipped:   false,
  checked:   false,
  startTime: null,   // Date.now() at session start
  history:   [],     // [{word, outcome}] for go-back support
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
          obj[k] = /^\d+$/.test(v) ? parseInt(v) : v === 'true' ? true : v === 'false' ? false : (v === '~' ? null : v);
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

  ban(id) {
    const key = String(id);
    if (!this._ws[key]) this._ws[key] = { correct: 0, wrong: 0, skipped: 0, streak: 0, first_seen: null, last_seen: null };
    this._ws[key].banned = true;
    this._saveBan(key);
  },

  unban(id) {
    const key = String(id);
    if (this._ws[key]) { this._ws[key].banned = false; this._saveBan(key); }
  },

  isBanned(id) {
    const s = this._ws[String(id)];
    return s ? s.banned === true : false;
  },

  async _saveBan(key) {
    try {
      await fetch('/save-stats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word_stats: { [key]: this._ws[key] } }),
      });
    } catch (e) { console.warn('Could not save ban:', e); }
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
  const word = sess.words[sess.idx];
  Stats.record(word.id, outcome === 'skip' ? 'skipped' : outcome);

  if (outcome === 'correct') sess.correct++;
  else if (outcome === 'wrong') sess.wrong++;
  else sess.skipped++;

  sess.history.push({ word, outcome });
  sess.idx++;
  updateProgress();
  updateBackBtn();
  saveSession();

  if (sess.idx >= sess.words.length) {
    endSession();
    return;
  }
  showCard(sess.words[sess.idx]);
}

// ═══════════════════════════════════════════════════════════════
//  GO BACK
// ═══════════════════════════════════════════════════════════════

/**
 * Shows or hides the back button based on history depth.
 */
function updateBackBtn() {
  const btn = $('fBtnBack');
  if (!btn) return;
  if (sess.history.length > 0) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

/**
 * Goes back to the previous card, undoing the last outcome from session counters.
 * Stats already written to the server are not reversed (a fresh mark will be added).
 */
function doGoBack() {
  if (sess.history.length === 0) return;
  const { outcome } = sess.history.pop();

  // Undo session counter
  if (outcome === 'correct') sess.correct = Math.max(0, sess.correct - 1);
  else if (outcome === 'wrong') sess.wrong = Math.max(0, sess.wrong - 1);
  else sess.skipped = Math.max(0, sess.skipped - 1);

  sess.idx--;
  updateProgress();
  updateBackBtn();
  saveSession();
  showCard(sess.words[sess.idx]);
}

// ═══════════════════════════════════════════════════════════════
//  SESSION PERSISTENCE
// ═══════════════════════════════════════════════════════════════

let _saveSessionTimer = null;

/**
 * Debounced POST of the current flip-mode session state to /save-session.
 * Called after each advance or go-back so a reload restores exactly where we were.
 */
function saveSession() {
  if (cfg.mode !== 'flip') return;
  clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    const data = {
      wordIds:   sess.words.map(w => w.id),
      idx:       sess.idx,
      correct:   sess.correct,
      wrong:     sess.wrong,
      skipped:   sess.skipped,
      history:   sess.history.map(h => ({ wordId: h.word.id, outcome: h.outcome })),
      startTime: sess.startTime,
      cfg: {
        mode:           cfg.mode,
        lang:           cfg.lang,
        requireArticle: cfg.requireArticle,
        tags:           [...cfg.tags],
        limit:          cfg.limit,
      },
    };
    fetch('/save-session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    }).catch(() => {});
  }, 400);
}

/**
 * Removes the persisted session so the next boot starts fresh.
 */
function clearSession() {
  clearTimeout(_saveSessionTimer);
  fetch('/clear-session', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    '{}',
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
//  BAN
// ═══════════════════════════════════════════════════════════════

/**
 * Bans the current card's word from the pool, removes it from the session,
 * and advances to the next card (or ends the session).
 */
function doBan() {
  if (sess.idx >= sess.words.length) return;
  const word = sess.words[sess.idx];
  Stats.ban(word.id);
  sess.words.splice(sess.idx, 1);
  sess.flipped = false;
  sess.checked = false;
  updateProgress();
  if (sess.words.length === 0 || sess.idx >= sess.words.length) {
    endSession();
  } else {
    showCard(sess.words[sess.idx]);
  }
}

// ═══════════════════════════════════════════════════════════════
//  FLIP
// ═══════════════════════════════════════════════════════════════

/**
 * Toggles the flip-mode card between front (prompt) and back (answer).
 */
function doFlip() {
  sess.flipped = !sess.flipped;
  const card = $('flipCard');
  if (sess.flipped) {
    card.classList.add('flipped');
    hide('flipPreActions');
    show('flipPostActions');
  } else {
    card.classList.remove('flipped');
    show('flipPreActions');
    hide('flipPostActions');
  }
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

  clearSession();

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
  clearSession();
  _cfgDirty = false;
  let pool = cfg.tags.length
    ? WORDS_DATA.filter(w => w.tags && cfg.tags.some(t => w.tags.includes(t)))
    : [...WORDS_DATA];
  pool = pool.filter(w => !Stats.isBanned(w.id));
  // Weighted sort: higher weight (unseen / wrong-heavy) floats to front,
  // with randomness so the order isn't perfectly rigid each session.
  sess.words = pool.sort((a, b) => {
    const wa = Stats.weight(a.id) + Math.random() * 2;
    const wb = Stats.weight(b.id) + Math.random() * 2;
    return wb - wa;
  });
  if (cfg.limit) sess.words = sess.words.slice(0, cfg.limit);
  sess.idx       = 0;
  sess.correct   = 0;
  sess.wrong     = 0;
  sess.skipped   = 0;
  sess.startTime = Date.now();
  sess.history   = [];

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

  // ── Banned words ─────────────────────────────────────────────
  const banned = Object.entries(allWS).filter(([, s]) => s.banned === true);
  const bannedHTML = banned.length === 0
    ? '<div class="report-empty">No banned words.</div>'
    : `<div class="word-list">${banned.map(([id, s]) => {
        const label = wordLabel(id);
        const sub   = wordSub(id);
        return `<div class="word-row">
          <div class="word-row-de">${label}</div>
          <div class="word-row-en">${sub}</div>
          <button class="btn-unban" onclick="Stats.unban('${id}'); renderReport();">unban</button>
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

    ${banned.length > 0 ? `
    <div>
      <div class="report-section-title">Banned (${banned.length})</div>
      ${bannedHTML}
    </div>` : ''}
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
$('fBtnBan').addEventListener('click',   e => { e.stopPropagation(); doBan(); });
$('fBtnBack').addEventListener('click',  e => { e.stopPropagation(); doGoBack(); });

// Type mode
$('btnCheck').addEventListener('click', doCheck);
$('tBtnWrong').addEventListener('click', () => advance('wrong'));
$('tBtnSkip').addEventListener('click',  () => advance('skip'));
$('tBtnRight').addEventListener('click', () => advance('correct'));
$('tBtnBan').addEventListener('click',   () => doBan());

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
  if (g === 'limit')   cfg.limit = v ? +v : null;
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

  // Ban current word (any time during a card)
  if ((e.key === 'b' || e.key === 'B') && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    doBan();
    return;
  }

  if (cfg.mode === 'flip') {
    if (e.key === 'ArrowUp') { e.preventDefault(); doGoBack(); }
    else if (e.key === ' ' || e.code === 'Space') {
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
//  BOOT — load words.yaml + stats.yaml + session in parallel
// ═══════════════════════════════════════════════════════════════
const fetchWords = fetch('words.yaml')
  .then(r => { if (!r.ok) throw new Error('words.yaml not found'); return r.text(); })
  .then(t => parseYAML(t));

const fetchStats = fetch('stats.yaml')
  .then(r => r.ok ? r.text() : '')
  .then(t => t ? parseStatsYAML(t) : { word_stats: {}, sessions: [] })
  .catch(() => ({ word_stats: {}, sessions: [] }));

const fetchSession = fetch('/session')
  .then(r => r.ok ? r.json() : { ok: false })
  .catch(() => ({ ok: false }));

/**
 * Applies all cfg values to the settings panel UI (called after restoring a saved session).
 */
function syncCfgToUI() {
  applyOpt('mode',    cfg.mode);
  applyOpt('lang',    cfg.lang);
  applyOpt('article', cfg.requireArticle ? 'yes' : 'no');
  applyOpt('limit',   cfg.limit ? String(cfg.limit) : '');
  renderTagOpts();
}

Promise.all([fetchWords, fetchStats, fetchSession])
  .then(([words, statsData, savedSession]) => {
    window.WORDS_DATA = words;
    Stats.init(statsData);
    buildTagFilter();

    // Attempt to restore a persisted flip-mode session
    let restored = false;
    if (savedSession.ok && savedSession.cfg && savedSession.cfg.mode === 'flip'
        && Array.isArray(savedSession.wordIds) && savedSession.wordIds.length > 0
        && typeof savedSession.idx === 'number' && savedSession.idx < savedSession.wordIds.length) {
      const wordMap = new Map(words.map(w => [w.id, w]));
      const restoredWords = savedSession.wordIds.map(id => wordMap.get(id)).filter(Boolean);

      if (restoredWords.length > 0 && savedSession.idx < restoredWords.length) {
        // Restore cfg
        const sc = savedSession.cfg;
        cfg.mode           = sc.mode;
        cfg.lang           = sc.lang           || cfg.lang;
        cfg.requireArticle = sc.requireArticle ?? cfg.requireArticle;
        cfg.tags           = Array.isArray(sc.tags) ? sc.tags : [];
        cfg.limit          = sc.limit          || null;

        // Restore session state
        sess.words     = restoredWords;
        sess.idx       = savedSession.idx;
        sess.correct   = savedSession.correct  || 0;
        sess.wrong     = savedSession.wrong    || 0;
        sess.skipped   = savedSession.skipped  || 0;
        sess.startTime = savedSession.startTime || Date.now();
        sess.history   = (savedSession.history || [])
          .map(h => ({ word: wordMap.get(h.wordId), outcome: h.outcome }))
          .filter(h => h.word);

        hide('flipMode');
        hide('typeMode');
        $('flipMode').classList.remove('hidden');
        $('completeScreen').classList.remove('active');
        $('progressSection').style.visibility = '';

        syncCfgToUI();
        updateProgress();
        updateBackBtn();
        showCard(sess.words[sess.idx]);
        restored = true;
      }
    }

    if (!restored) startSession();
    // Stamp initial history state so popstate always has a typed state object
    const initState = _parseRoute();
    history.replaceState(initState, '', window.location.href);
    // Route to the correct panel based on URL, falling back to localStorage
    if (Object.keys(initState).length > 0) {
      _applyRoute(initState);
    } else if (localStorage.getItem(_W_OPEN_KEY) === '1') {
      // Restore write panel from previous session (no URL params present)
      _navReplace({ panel: 'write' });
      _applyRoute({ panel: 'write' });
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
  _clearWordMatch();
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
  _clearWordMatch();
  $('addWordInput').focus();
}

// ═══════════════════════════════════════════════════════════════
// ── Duplicate Detection ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/** Current suggestion list (for keyboard nav). */
let _matchSuggestions = [];
let _matchFocusIdx    = -1;
let _matchDebounce    = null;

/** Normalises a string for match comparison. */
function _normMatch(s) { return (s || '').trim().toLowerCase(); }

/** Strips a leading article token ("der/die/das") from a typed string. */
function _stripArticle(s) { return s.replace(/^(der|die|das)\s+/i, '').trim(); }

/**
 * Tokenises a normalised string into a Set of meaningful words,
 * stripping German articles and short stop-words.
 */
const _STOP = new Set(['der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'in', 'im',
  'an', 'am', 'auf', 'zu', 'zur', 'zum', 'von', 'vom', 'mit', 'bei', 'nach',
  'für', 'fur', 'über', 'uber', 'unter', 'durch', 'gegen', 'ohne', 'um',
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'and', 'or', 'be']);

function _tokenSet(s) {
  return new Set(s.split(/\s+/).filter(t => t.length > 1 && !_STOP.has(t)));
}

/**
 * Searches WORDS_DATA for exact, prefix, contains, and phrase-similarity matches.
 * Returns { exact: word|null, suggestions: word[], similar: word[] }.
 * `similar` contains entries whose German text shares >= 50% of query words.
 */
function _matchWords(query) {
  const q = _normMatch(_stripArticle(query));
  if (q.length < 3) return { exact: null, suggestions: [], similar: [] };

  const qTokens   = _tokenSet(q);
  const isPhrase  = qTokens.size >= 2;

  const exact = [], prefix = [], contains = [], similar = [];
  for (const w of (window.WORDS_DATA || [])) {
    const de = _normMatch(w.de);
    const en = _normMatch(w.en || '');
    if (de === q) { exact.push(w); continue; }
    if (de.startsWith(q)) { prefix.push(w); continue; }
    if (de.includes(q) || en.includes(q)) { contains.push(w); continue; }

    // Phrase similarity: word-set intersection
    if (isPhrase) {
      const wTokens    = _tokenSet(de);
      if (wTokens.size === 0) continue;
      const shared     = [...qTokens].filter(t => wTokens.has(t)).length;
      const coverage   = shared / qTokens.size;   // fraction of query words found in entry
      if (coverage >= 0.5) similar.push({ word: w, coverage });
    }
  }

  similar.sort((a, b) => b.coverage - a.coverage);

  return {
    exact:       exact[0] || null,
    suggestions: [...prefix, ...contains].slice(0, 5),
    similar:     similar.slice(0, 3).map(s => s.word),
  };
}

/** Hides the match area and resets suggestion state. */
function _clearWordMatch() {
  const el = $('addWordMatch');
  if (el) el.innerHTML = '';
  _matchSuggestions = [];
  _matchFocusIdx    = -1;
}

/** Updates the visual focus highlight on suggestion rows. */
function _updateMatchFocus() {
  document.querySelectorAll('.aw-suggestion-row').forEach((el, i) => {
    el.classList.toggle('focused', i === _matchFocusIdx);
  });
}

/** Fills the input with the selected suggestion and re-runs match. */
function _selectSuggestion(word) {
  const full = (word.article && word.article !== '~') ? `${word.article} ${word.de}` : word.de;
  $('addWordInput').value = full;
  _matchFocusIdx = -1;
  _renderWordMatch(full);
}

/**
 * Runs the duplicate check and renders the match area.
 * Shows an exact-match preview or a suggestion list.
 */
function _renderWordMatch(query) {
  const { exact, suggestions } = _matchWords(query);
  const el = $('addWordMatch');

  if (exact) {
    _matchSuggestions = [];
    _matchFocusIdx    = -1;
    const de   = (exact.article && exact.article !== '~') ? `${exact.article} ${exact.de}` : exact.de;
    const tags = (exact.tags || []).join(', ');
    el.innerHTML = `
      <div class="aw-preview aw-exists">
        <div class="aw-exists-label" style="padding:12px 16px 4px;">⚑ Already in your deck</div>
        <div class="aw-preview-de">${de}</div>
        <div class="aw-preview-meta">${exact.type || 'word'} · #${exact.id}</div>
        <div class="aw-preview-trans">${exact.en || ''} · ${exact.uk || ''}</div>
        ${tags ? `<div class="aw-preview-tags">${tags}</div>` : ''}
        <div class="aw-preview-actions">
          <button class="btn btn-primary" id="awMatchStudy" style="margin-left:0;">Study now →</button>
          <button class="btn" id="awMatchIgnore" style="margin-left:0;">Add anyway</button>
        </div>
      </div>`;
    $('awMatchStudy').addEventListener('click',  () => _studyNewWord(exact.id));
    $('awMatchIgnore').addEventListener('click', _clearWordMatch);

  } else if (suggestions.length > 0) {
    _matchSuggestions = suggestions;
    _matchFocusIdx    = -1;
    el.innerHTML = `<div class="aw-suggestion-list">${suggestions.map((w, i) => {
      const de = (w.article && w.article !== '~') ? `${w.article} ${w.de}` : w.de;
      return `<div class="aw-suggestion-row" data-idx="${i}">
        <span class="aw-suggestion-de">${de}</span>
        <span class="aw-suggestion-en">${w.en || ''}</span>
        <span class="aw-suggestion-stat">${Stats.badgeHTML(w.id)}</span>
      </div>`;
    }).join('')}</div>`;

  } else {
    _clearWordMatch();
  }
}

// Click-to-select on suggestions (event delegation)
$('addWordMatch').addEventListener('click', e => {
  const row = e.target.closest('.aw-suggestion-row');
  if (!row) return;
  const idx = +row.dataset.idx;
  if (_matchSuggestions[idx]) _selectSuggestion(_matchSuggestions[idx]);
});

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
  // Keyboard navigation for suggestion list
  if (e.key === 'ArrowDown' && _matchSuggestions.length) {
    e.preventDefault();
    _matchFocusIdx = Math.min(_matchFocusIdx + 1, _matchSuggestions.length - 1);
    _updateMatchFocus();
    return;
  }
  if (e.key === 'ArrowUp' && _matchSuggestions.length) {
    e.preventDefault();
    _matchFocusIdx = Math.max(_matchFocusIdx - 1, -1);
    _updateMatchFocus();
    return;
  }
  if (e.key === 'Enter' && _matchFocusIdx >= 0) {
    e.preventDefault();
    _selectSuggestion(_matchSuggestions[_matchFocusIdx]);
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); submitWord(); }
  if (e.key === 'Escape') { _clearWordMatch(); closeAddWord(); }
});
$('addWordInput').addEventListener('input', () => {
  clearTimeout(_matchDebounce);
  const q = $('addWordInput').value.trim();
  if (q.length < 3) { _clearWordMatch(); return; }
  _matchDebounce = setTimeout(() => _renderWordMatch(q), 220);
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

/** Opens the full-screen writing panel and pushes a history entry. */
function openWrite() {
  _navPush({ panel: 'write' });
  $('writePanel').classList.add('open');
  _wShowView('student');
  _wLoadTexts();
  $('wTextarea').focus();
  localStorage.setItem(_W_OPEN_KEY, '1');
}

/** Closes the writing panel and replaces history state with main. */
function closeWrite() {
  $('writePanel').classList.remove('open');
  localStorage.removeItem(_W_OPEN_KEY);
  _navReplace({});
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

// Draft persistence — save unsaved (new) text to localStorage
const _W_DRAFT_KEY  = 'write_draft';
const _W_OPEN_KEY   = 'write_panel_open';
let   _wDraftTimer  = null;

function _wSaveDraft() {
  if (_wCurrentSlug !== null) return;  // only save unsaved new texts
  localStorage.setItem(_W_DRAFT_KEY, $('wTextarea').value);
}

function _wClearDraft() {
  localStorage.removeItem(_W_DRAFT_KEY);
}

// Update word count as student types, and save draft
$('wTextarea').addEventListener('input', () => {
  const n = $('wTextarea').value.trim().split(/\s+/).filter(Boolean).length;
  $('wWordCount').textContent = n === 1 ? '1 Wort' : `${n} Wörter`;
  clearTimeout(_wDraftTimer);
  _wDraftTimer = setTimeout(_wSaveDraft, 800);
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

// Live diff: update on every keystroke; autosave correction after a pause
let _wCorrTimer = null;
$('wCorrectionArea').addEventListener('input', () => {
  _wUpdateDiff();
  clearTimeout(_wCorrTimer);
  _wCorrTimer = setTimeout(_wSaveCorrection, 1200);
});

$('btnTeacherBack').addEventListener('click', () => {
  _navPush({ panel: 'write' });
  _wShowView('student');
});

// New text: reset to student view
$('btnWriteNew').addEventListener('click', () => {
  $('wTextarea').value = '';
  $('wWordCount').textContent = '0 Wörter';
  _wOriginal = '';
  _wCurrentSlug = null;
  _wClearDraft();
  _wRenderStrip();
  _navPush({ panel: 'write' });
  _wShowView('student');
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

/** Levenshtein distance between two strings. */
function _editDist(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Uint16Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/** Character-level LCS diff. Returns [{type:'equal'|'delete'|'insert', ch}]. */
function _charDiff(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const raw = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      raw.push({ type: 'equal',  ch: a[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      raw.push({ type: 'insert', ch: b[j-1] }); j--;
    } else {
      raw.push({ type: 'delete', ch: a[i-1] }); i--;
    }
  }
  return raw.reverse();
}

/**
 * Renders a word substitution as a stacked widget:
 *   correction (mint, small) on top
 *   original   (red, struck-through changed chars) below
 * Only changed characters are highlighted; shared characters appear normally.
 */
function _renderSubst(del, ins) {
  const chars = _charDiff(del, ins);
  let topHtml = '', botHtml = '';
  for (const { type, ch } of chars) {
    const esc = _escHtml(ch);
    if (type === 'equal') {
      topHtml += esc;
      botHtml += esc;
    } else if (type === 'delete') {
      botHtml += `<span class="diff-char-del">${esc}</span>`;
    } else {
      topHtml += `<span class="diff-char-ins">${esc}</span>`;
    }
  }
  return `<span class="diff-subst"><span class="diff-subst-top">${topHtml}</span><span class="diff-subst-bot">${botHtml}</span></span>`;
}

/**
 * Renders the diff of original vs corrected as tracked-changes HTML.
 *
 * Three cases:
 *  • equal                        → plain text
 *  • delete+insert (similar word) → stacked character-level widget
 *  • delete+insert (diff word)    → whole-word del then ins
 *  • pure delete                  → red strikethrough word
 *  • pure insert                  → green left-border word with + marker
 */
function _renderDiff(original, corrected) {
  const chunks = _wComputeDiff(original, corrected);

  let html   = '';
  let prevNl = true;
  let ci     = 0;

  /** Emit a space unless at line-start. */
  function sp() { if (!prevNl) html += ' '; prevNl = false; }

  while (ci < chunks.length) {
    const chunk = chunks[ci];

    // ── equal ────────────────────────────────────────────────
    if (chunk.type === 'equal') {
      for (const t of chunk.tokens) {
        if (t === '\n') { html += '<br>'; prevNl = true; }
        else { sp(); html += _escHtml(t); }
      }
      ci++;
      continue;
    }

    // ── delete — look ahead for matching insert ────────────
    if (chunk.type === 'delete') {
      const next = chunks[ci + 1];
      if (next && next.type === 'insert') {
        // Pair del/ins tokens greedily, one-for-one up to min length
        const dels = chunk.tokens.filter(t => t !== '\n');
        const ins  = next.tokens.filter(t => t !== '\n');
        const pairs = Math.min(dels.length, ins.length);

        for (let k = 0; k < pairs; k++) {
          const d = dels[k], iv = ins[k];
          sp();
          const maxLen = Math.max(d.length, iv.length);
          const similar = maxLen > 0 && _editDist(d.toLowerCase(), iv.toLowerCase()) / maxLen <= 0.6;
          if (similar) {
            html += _renderSubst(d, iv);
          } else {
            html += `<span class="diff-del">${_escHtml(d)}</span> <span class="diff-ins">${_escHtml(iv)}</span>`;
          }
        }
        // leftover deletions
        for (let k = pairs; k < dels.length; k++) {
          sp(); html += `<span class="diff-del">${_escHtml(dels[k])}</span>`;
        }
        // leftover insertions
        for (let k = pairs; k < ins.length; k++) {
          sp(); html += `<span class="diff-ins-new"><span class="diff-ins-marker">+</span>${_escHtml(ins[k])}</span>`;
        }
        // handle any newlines
        for (const t of [...chunk.tokens, ...next.tokens]) {
          if (t === '\n') { html += '<br>'; prevNl = true; }
        }
        ci += 2;
        continue;
      }

      // pure deletion
      for (const t of chunk.tokens) {
        if (t === '\n') { html += '<br>'; prevNl = true; }
        else { sp(); html += `<span class="diff-del">${_escHtml(t)}</span>`; }
      }
      ci++;
      continue;
    }

    // ── pure insert ──────────────────────────────────────────
    for (const t of chunk.tokens) {
      if (t === '\n') { html += '<br>'; prevNl = true; }
      else { sp(); html += `<span class="diff-ins-new"><span class="diff-ins-marker">+</span>${_escHtml(t)}</span>`; }
    }
    ci++;
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
 * Sets up teacher mode UI for a full entry object {name, slug, text, correction?, …}.
 * Does NOT touch history — callers handle navigation.
 */
function _wOpenTeacherUI(entry) {
  _wCurrentSlug = entry.slug;
  _wOriginal    = entry.text || '';
  $('wCorrectionArea').value = entry.correction || entry.text || '';
  _wUpdateDiff();
  _wRenderStrip();
  _wShowView('teacher');
  _wResetExerciseBtn();
  // Show doc name as the copyable review link (URL already updated by caller)
  const el = $('wReviewUrl');
  el.textContent = entry.name;
  el.dataset.url = window.location.href;
  el.classList.remove('hidden');
  $('wCorrectionArea').focus();
}

/**
 * Navigates to teacher mode for a full entry object and sets up the UI.
 * Pushes a ?review=slug history entry.
 */
function _wOpenTeacher(entry) {
  _navPush({ panel: 'review', slug: entry.slug });
  _wOpenTeacherUI(entry);
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
    _navPush({ panel: 'write' });
    _wShowView('student');
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
      _wClearDraft();
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

// ═══════════════════════════════════════════════════════════════
//  QUICK-QUEUE (double-click a word in writing/review views)
// ═══════════════════════════════════════════════════════════════

let _qqToastTimer        = null;
let _qqPopoverWord       = null;   // word currently shown in the popover
let _qqPollInterval      = null;
let _qqIgnoreNextClick   = false;  // suppress the click that immediately follows mouseup

/** Show a brief toast at the bottom of the screen. */
function _qqToast(msg, kind = 'ok') {
  let el = document.getElementById('qqToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qqToast';
    el.className = 'qq-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `qq-toast qq-${kind} qq-show`;
  clearTimeout(_qqToastTimer);
  _qqToastTimer = setTimeout(() => { el.classList.remove('qq-show'); }, 2400);
}

/** Dismiss the confirmation popover. */
function _qqClosePopover() {
  const el = document.getElementById('qqPopover');
  if (el) el.remove();
  _qqPopoverWord = null;
}

/**
 * Show a confirmation popover near the mouse position.
 * Checks WORDS_DATA for an existing match, shows status, and offers a Queue button.
 * @param {string} word   Already-stripped word.
 * @param {MouseEvent} ev The dblclick event (for positioning).
 */
function _qqShowPopover(word, ev) {
  _qqClosePopover();
  _qqPopoverWord = word;

  const { exact, similar } = _matchWords(word);
  const hasDup = exact || similar.length > 0;

  // Build status HTML
  let statusHtml = '';
  if (exact) {
    const art = (exact.article && exact.article !== '~') ? exact.article + ' ' : '';
    statusHtml = `<div class="qq-pop-exists">
      Already in deck: <strong>${art}${_escHtml(exact.de)}</strong>
      <span class="qq-pop-meta">${_escHtml(exact.en || '')}${exact.uk ? ' · ' + _escHtml(exact.uk) : ''}</span>
    </div>`;
  } else if (similar.length > 0) {
    const rows = similar.map(w => {
      const art = (w.article && w.article !== '~') ? w.article + ' ' : '';
      return `<div class="qq-pop-similar-row">
        <strong>${art}${_escHtml(w.de)}</strong>
        <span class="qq-pop-meta">${_escHtml(w.en || '')}${w.uk ? ' · ' + _escHtml(w.uk) : ''}</span>
      </div>`;
    }).join('');
    statusHtml = `<div class="qq-pop-exists qq-pop-similar">Similar in deck:${rows}</div>`;
  }

  const pop = document.createElement('div');
  pop.id        = 'qqPopover';
  pop.className = 'qq-pop' + (hasDup ? ' qq-pop-dup' : '');
  pop.innerHTML = `
    <div class="qq-pop-word">${_escHtml(word)}</div>
    ${statusHtml}
    <div class="qq-pop-actions">
      <button class="qq-pop-btn qq-pop-confirm" id="qqBtnConfirm">
        ${hasDup ? 'Queue anyway' : 'Add to vocabulary'}
      </button>
      <button class="qq-pop-btn qq-pop-cancel" id="qqBtnCancel">✕</button>
    </div>`;

  document.body.appendChild(pop);
  _qqIgnoreNextClick = true; // the click event following mouseup would close us immediately

  // Position near click, keep within viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = 260, ph = similar.length > 0 ? 180 : 110;
  let x = ev.clientX + 12, y = ev.clientY + 12;
  if (x + pw > vw - 12) x = ev.clientX - pw - 4;
  if (y + ph > vh - 12) y = ev.clientY - ph - 4;
  pop.style.left = x + 'px';
  pop.style.top  = y + 'px';

  document.getElementById('qqBtnConfirm').addEventListener('click', () => {
    _qqClosePopover();
    _qqSubmit(word);
  });
  document.getElementById('qqBtnCancel').addEventListener('click', _qqClosePopover);
}

/**
 * POST word to /add-word, then poll and show toast with result.
 * @param {string} word
 */
async function _qqSubmit(word) {
  _qqToast(`Queuing: ${word}…`, 'ok');
  try {
    const res  = await fetch('/add-word', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ word }),
    });
    const data = await res.json();
    if (!data.ok) { _qqToast(`✗ ${data.error || 'error'}`, 'err'); return; }

    const id = data.requestId;
    let polls = 0;
    if (_qqPollInterval) clearInterval(_qqPollInterval);
    _qqPollInterval = setInterval(async () => {
      polls++;
      try {
        const r = await fetch(`/add-word-status?id=${id}`);
        const d = await r.json();
        if (d.pending) {
          if (polls === 2) _qqToast(`⏳ ${word} — processing…`, 'ok');
          return;
        }
        clearInterval(_qqPollInterval);
        if (d.skipped)   _qqToast(`↩ Already in deck: ${word}`, 'skip');
        else if (d.ok)   _qqToast(`✓ Added: ${word}`, 'ok');
        else             _qqToast(`✗ ${d.error || 'error'}`, 'err');
      } catch (_) {}
    }, 2000);
    setTimeout(() => clearInterval(_qqPollInterval), 60000);
  } catch (e) {
    _qqToast(`✗ ${e.message}`, 'err');
  }
}

/** Strip punctuation/quotes from the edges of a raw selection. */
function _qqCleanWord(raw) {
  return raw.replace(/^[«"„'"'\s]+|[»"'"'\s.,!?;:()]+$/g, '').trim();
}

/** Handle mouseup on a textarea — works for both dblclick-word and dragged phrase. */
function _qqHandleTextarea(ta, ev) {
  const raw  = ta.value.substring(ta.selectionStart, ta.selectionEnd);
  const word = _qqCleanWord(raw);
  if (word.length >= 2) _qqShowPopover(word, ev);
}

/** Handle mouseup on a div/span — use Selection API. */
function _qqHandleSelection(ev) {
  const raw  = (window.getSelection() || '').toString();
  const word = _qqCleanWord(raw);
  if (word.length >= 2) _qqShowPopover(word, ev);
}

// Close popover on outside click (but ignore the click that immediately follows mouseup)
document.addEventListener('click', e => {
  if (_qqIgnoreNextClick) { _qqIgnoreNextClick = false; return; }
  const pop = document.getElementById('qqPopover');
  if (pop && !pop.contains(e.target)) _qqClosePopover();
});

// Escape key closes popover
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('qqPopover')) {
    e.stopPropagation();
    _qqClosePopover();
  }
});

// Attach to student textarea, teacher correction area, and diff output.
// dblclick handles single-word selection (browser selects word during dblclick, after mouseup).
// mouseup handles drag-selected phrases (selection is ready by mouseup).
// Both have the word.length >= 2 guard so they don't interfere with each other.
function _qqAttach(el, handler) {
  el.addEventListener('dblclick', handler);
  el.addEventListener('mouseup',  handler);
}
_qqAttach($('wTextarea'),       ev => _qqHandleTextarea($('wTextarea'), ev));
_qqAttach($('wCorrectionArea'), ev => _qqHandleTextarea($('wCorrectionArea'), ev));
_qqAttach($('wDiffOutput'),     _qqHandleSelection);

// ── Generate Exercises button (teacher view) ─────────────────

let _exGenState = 'idle'; // 'idle' | 'pending' | 'ready'
let _exGenSlug  = null;

$('btnGenerateExercises').addEventListener('click', async () => {
  if (_exGenState === 'pending') return;

  if (_exGenState === 'ready' && _exGenSlug) {
    closeWrite();
    openExercises();
    _exStart(_exGenSlug);
    return;
  }

  const slug       = _wCurrentSlug;
  const original   = _wOriginal;
  const correction = $('wCorrectionArea').value.trim();
  if (!slug || !correction) return;

  const btn = $('btnGenerateExercises');
  _exGenState = 'pending';
  btn.textContent = '⟳ Generating…';
  btn.disabled = true;

  const textName = (_wTexts.find(t => t.slug === slug) || {}).name || slug;
  const requestId = await _exQueueGenerate({
    sourceType: 'writing', sourceRef: slug,
    original, correction,
    name: `Mistakes — ${textName}`,
  });

  if (!requestId) {
    _exGenState = 'idle';
    btn.textContent = '⊞ Exercises';
    btn.disabled = false;
    return;
  }

  _exPollStatus(requestId, (exerciseSlug) => {
    _exGenState = 'ready';
    _exGenSlug  = exerciseSlug;
    btn.textContent = 'Practice Mistakes →';
    btn.disabled = false;
  });
});

// Reset exercise gen state when text changes
function _wResetExerciseBtn() {
  _exGenState = 'idle';
  _exGenSlug  = null;
  $('btnGenerateExercises').textContent = '⊞ Exercises';
  $('btnGenerateExercises').disabled = false;
}

// Click doc name to copy its review URL
$('wReviewUrl').addEventListener('click', () => {
  const el  = $('wReviewUrl');
  const url = el.dataset.url;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1500);
  });
});

// ═══════════════════════════════════════════════════════════════
//  ROUTING  (hash-free, history API)
// ═══════════════════════════════════════════════════════════════

/*
 * URL scheme:
 *   (none)          → main flashcard view
 *   ?write          → writing panel, student mode
 *   ?review=slug    → writing panel, teacher mode
 *   ?exercises      → exercise panel, library
 *   ?exercise=slug  → exercise panel, practice set
 */

function _routeUrl(state) {
  const { panel, slug } = state || {};
  if (panel === 'write')     return '?write';
  if (panel === 'review')    return `?review=${encodeURIComponent(slug)}`;
  if (panel === 'exercises') return '?exercises';
  if (panel === 'exercise')  return `?exercise=${encodeURIComponent(slug)}`;
  return window.location.pathname;
}

function _navPush(state) {
  history.pushState(state, '', _routeUrl(state));
}

function _navReplace(state) {
  history.replaceState(state, '', _routeUrl(state));
}

/** Parse the current URL search string into a state object. */
function _parseRoute() {
  const p = new URLSearchParams(window.location.search);
  if (p.has('review'))    return { panel: 'review',    slug: p.get('review') };
  if (p.has('exercise'))  return { panel: 'exercise',  slug: p.get('exercise') };
  if (p.has('write'))     return { panel: 'write' };
  if (p.has('exercises')) return { panel: 'exercises' };
  return {};
}

/** Close all navigable panels — UI only, no history change. */
function _closeAllPanelsUI() {
  $('writePanel').classList.remove('open');
  $('exercisePanel').classList.remove('open');
  localStorage.removeItem(_W_OPEN_KEY);
}

/**
 * Apply a route state object to the UI.
 * Called from the popstate listener and on initial page load.
 * Does NOT push/replace history — callers manage that.
 */
async function _applyRoute(state) {
  _closeAllPanelsUI();
  const { panel, slug } = state || {};

  if (panel === 'review' && slug) {
    $('writePanel').classList.add('open');
    localStorage.setItem(_W_OPEN_KEY, '1');
    await _wLoadTexts();
    try {
      const r     = await fetch(`/text/${slug}`);
      const entry = await r.json();
      if (entry.ok !== false) _wOpenTeacherUI(entry);
      else _wShowView('student');
    } catch (_) { _wShowView('student'); }

  } else if (panel === 'write') {
    $('writePanel').classList.add('open');
    localStorage.setItem(_W_OPEN_KEY, '1');
    _wShowView('student');
    await _wLoadTexts();
    const draft = localStorage.getItem(_W_DRAFT_KEY);
    if (draft) {
      $('wTextarea').value = draft;
      const n = draft.trim().split(/\s+/).filter(Boolean).length;
      $('wWordCount').textContent = n === 1 ? '1 Wort' : `${n} Wörter`;
    }
    $('wTextarea').focus();

  } else if (panel === 'exercise' && slug) {
    $('exercisePanel').classList.add('open');
    await _exLoadSets();
    await _exStartUI(slug);

  } else if (panel === 'exercises') {
    $('exercisePanel').classList.add('open');
    _exShowView('library');
    await _exLoadSets();
  }
}

window.addEventListener('popstate', e => _applyRoute(e.state || {}));

// ═══════════════════════════════════════════════════════════════
//  SPECIALIZED EXERCISE SETS  (hardcoded — no server fetch)
// ═══════════════════════════════════════════════════════════════

const SPECIALIZED_SETS = {
  'prep-faelle': {
    name: 'Präpositionen: Welcher Fall?',
    exercises: [
      { id:1,  type:'select', focus:'Akkusativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'durch', blank:'Akkusativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"durch" immer Akkusativ: durch den Wald / durch die Stadt fahren.' },
      { id:2,  type:'select', focus:'Akkusativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'für', blank:'Akkusativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"für" immer Akkusativ: Das ist für dich / für einen Freund.' },
      { id:3,  type:'select', focus:'Akkusativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'ohne', blank:'Akkusativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"ohne" immer Akkusativ: ohne einen Fehler / ohne mich.' },
      { id:4,  type:'select', focus:'Akkusativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'gegen', blank:'Akkusativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"gegen" immer Akkusativ: gegen den Wind / gegen Kopfschmerzen.' },
      { id:5,  type:'select', focus:'Akkusativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'um', blank:'Akkusativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"um" immer Akkusativ: um den Tisch / um 8 Uhr.' },
      { id:6,  type:'select', focus:'Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'mit', blank:'Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"mit" immer Dativ: mit dem Bus / mit einem Freund.' },
      { id:7,  type:'select', focus:'Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'von', blank:'Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"von" immer Dativ: von dem (→ vom) Bahnhof.' },
      { id:8,  type:'select', focus:'Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'nach', blank:'Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"nach" immer Dativ: nach der Arbeit / nach Berlin fahren.' },
      { id:9,  type:'select', focus:'Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'seit', blank:'Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"seit" immer Dativ: seit einem Jahr / seit der Schule.' },
      { id:10, type:'select', focus:'Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'außer', blank:'Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"außer" immer Dativ: außer mir / außer dem Chef.' },
      { id:11, type:'select', focus:'Akkusativ + Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'in', blank:'Akkusativ + Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"in" ist Wechselpräposition: in die Stadt (Wohin? → Akk), in der Stadt (Wo? → Dat).' },
      { id:12, type:'select', focus:'Akkusativ + Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'auf', blank:'Akkusativ + Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"auf" ist Wechselpräposition: auf den Tisch (Wohin?), auf dem Tisch (Wo?).' },
      { id:13, type:'select', focus:'Akkusativ + Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'an', blank:'Akkusativ + Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"an" ist Wechselpräposition: ans Meer fahren (Wohin?), am Meer (Wo?).' },
      { id:14, type:'select', focus:'Akkusativ + Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'unter', blank:'Akkusativ + Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"unter" ist Wechselpräposition: unter den Tisch (Wohin?), unter dem Tisch (Wo?).' },
      { id:15, type:'select', focus:'Akkusativ + Dativ',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'neben', blank:'Akkusativ + Dativ',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"neben" ist Wechselpräposition: neben den Stuhl (Wohin?), neben dem Stuhl (Wo?).' },
      { id:16, type:'select', focus:'Genitiv',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'wegen', blank:'Genitiv',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"wegen" regiert Genitiv: wegen des Regens. (Umgangsspr. auch Dativ möglich.)' },
      { id:17, type:'select', focus:'Genitiv',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'während', blank:'Genitiv',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"während" regiert Genitiv: während des Sommers / während der Nacht.' },
      { id:18, type:'select', focus:'Genitiv',
        instruction:'Welchen Fall regiert diese Präposition?',
        prompt:'trotz', blank:'Genitiv',
        options:['Akkusativ','Dativ','Genitiv','Akkusativ + Dativ'],
        explanation:'"trotz" regiert Genitiv: trotz des schlechten Wetters.' },
    ]
  },

  'prep-wo-wohin': {
    name: 'Präpositionen: Wo / Wohin?',
    exercises: [
      { id:1,  type:'select', focus:'Wohin? → Akkusativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle den richtigen Artikel.',
        prompt:'Ich lege das Buch ___ Tisch. (auf)',
        blank:'auf den',
        options:['auf den','auf dem'],
        explanation:'legen = Bewegung an einen Ort → Wohin? → Akkusativ. "Tisch" mask. → auf den.' },
      { id:2,  type:'select', focus:'Wo? → Dativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle den richtigen Artikel.',
        prompt:'Das Buch liegt ___ Tisch. (auf)',
        blank:'auf dem',
        options:['auf den','auf dem'],
        explanation:'liegen = statische Lage → Wo? → Dativ. "Tisch" mask. → auf dem.' },
      { id:3,  type:'select', focus:'Wohin? → Akkusativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle die richtige Form.',
        prompt:'Das Kind läuft ___ Zimmer. (in)',
        blank:'ins',
        options:['ins','im'],
        explanation:'laufen in = Bewegung hinein → Wohin? → Akkusativ. "Zimmer" neutr. → in das → ins.' },
      { id:4,  type:'select', focus:'Wo? → Dativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle die richtige Form.',
        prompt:'Das Kind spielt ___ Zimmer. (in)',
        blank:'im',
        options:['ins','im'],
        explanation:'spielen = statische Aktivität → Wo? → Dativ. "Zimmer" neutr. → in dem → im.' },
      { id:5,  type:'select', focus:'Wohin? → Akkusativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle den richtigen Artikel.',
        prompt:'Er hängt das Bild ___ Wand. (an)',
        blank:'an die',
        options:['an die','an der'],
        explanation:'hängen (transitiv) = aufhängen → Wohin? → Akkusativ. "Wand" fem. → an die.' },
      { id:6,  type:'select', focus:'Wo? → Dativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle den richtigen Artikel.',
        prompt:'Das Bild hängt ___ Wand. (an)',
        blank:'an der',
        options:['an die','an der'],
        explanation:'hängen (intransitiv) = hängen bleiben → Wo? → Dativ. "Wand" fem. → an der.' },
      { id:7,  type:'select', focus:'Wohin? → Akkusativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle die richtige Form.',
        prompt:'Er stellt die Flasche ___ Regal. (in)',
        blank:'ins',
        options:['ins','im'],
        explanation:'stellen = aufrecht hinstellen → Wohin? → Akkusativ. "Regal" neutr. → in das → ins.' },
      { id:8,  type:'select', focus:'Wo? → Dativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle die richtige Form.',
        prompt:'Die Flasche steht ___ Regal. (in)',
        blank:'im',
        options:['ins','im'],
        explanation:'stehen = statische Lage → Wo? → Dativ. "Regal" neutr. → in dem → im.' },
      { id:9,  type:'select', focus:'Wohin? → Akkusativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle den richtigen Artikel.',
        prompt:'Wir fahren ___ Berge. (in)',
        blank:'in die',
        options:['in die','in den'],
        explanation:'fahren in = Bewegung in Richtung → Wohin? → Akkusativ. "Berge" Plural Akk → in die.' },
      { id:10, type:'select', focus:'Wo? → Dativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle den richtigen Artikel.',
        prompt:'Wir wandern ___ Bergen. (in)',
        blank:'in den',
        options:['in die','in den'],
        explanation:'wandern = Aktivität am Ort → Wo? → Dativ. Plural Dativ → in den.' },
      { id:11, type:'select', focus:'Wohin? → Akkusativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle den richtigen Artikel.',
        prompt:'Sie geht ___ Supermarkt. (in)',
        blank:'in den',
        options:['in den','im'],
        explanation:'gehen in = Bewegung hinein → Wohin? → Akkusativ. "Supermarkt" mask. → in den.' },
      { id:12, type:'select', focus:'Wo? → Dativ',
        instruction:'Wo? (Dativ) oder Wohin? (Akkusativ) — wähle die richtige Form.',
        prompt:'Sie kauft ___ Supermarkt ein. (in)',
        blank:'im',
        options:['in den','im'],
        explanation:'einkaufen = Aktivität am Ort → Wo? → Dativ. "Supermarkt" mask. → in dem → im.' },
    ]
  },

  'prep-kontraktionen': {
    name: 'Präpositionen: Kontraktionen',
    exercises: [
      { id:1, type:'fill', focus:'Dativ',
        instruction:'Schreibe die Kontraktion.',
        prompt:'von + dem = ___',
        blank:'vom',
        explanation:'"von + dem" → vom. Ich komme vom Bahnhof / vom Arzt.' },
      { id:2, type:'fill', focus:'Dativ',
        instruction:'Schreibe die Kontraktion.',
        prompt:'zu + dem = ___',
        blank:'zum',
        explanation:'"zu + dem" → zum. Ich gehe zum Arzt / zum Bahnhof.' },
      { id:3, type:'fill', focus:'Dativ',
        instruction:'Schreibe die Kontraktion.',
        prompt:'bei + dem = ___',
        blank:'beim',
        explanation:'"bei + dem" → beim. Beim Essen, beim Arzt.' },
      { id:4, type:'fill', focus:'Dativ',
        instruction:'Schreibe die Kontraktion.',
        prompt:'zu + der = ___',
        blank:'zur',
        explanation:'"zu + der" → zur. Zur Schule, zur Arbeit, zur Polizei.' },
      { id:5, type:'fill', focus:'Dativ (Wechselpräp.)',
        instruction:'Schreibe die Kontraktion.',
        prompt:'in + dem = ___',
        blank:'im',
        explanation:'"in + dem" → im. Im Zimmer, im Sommer (Wo? → Dativ).' },
      { id:6, type:'fill', focus:'Dativ (Wechselpräp.)',
        instruction:'Schreibe die Kontraktion.',
        prompt:'an + dem = ___',
        blank:'am',
        explanation:'"an + dem" → am. Am Tisch, am Montag (Wo? → Dativ).' },
      { id:7, type:'fill', focus:'Akkusativ (Wechselpräp.)',
        instruction:'Schreibe die Kontraktion.',
        prompt:'an + das = ___',
        blank:'ans',
        explanation:'"an + das" → ans. Ans Fenster gehen (Wohin? → Akkusativ).' },
      { id:8, type:'fill', focus:'Akkusativ (Wechselpräp.)',
        instruction:'Schreibe die Kontraktion.',
        prompt:'in + das = ___',
        blank:'ins',
        explanation:'"in + das" → ins. Ins Kino gehen, ins Zimmer laufen (Wohin? → Akkusativ).' },
      { id:9, type:'fill', focus:'Akkusativ (Wechselpräp.)',
        instruction:'Schreibe die Kontraktion.',
        prompt:'auf + das = ___',
        blank:'aufs',
        explanation:'"auf + das" → aufs. Aufs Land fahren (Wohin? → Akkusativ).' },
    ]
  },

  'prep-richtige': {
    name: 'Präpositionen: Welche Präposition?',
    exercises: [
      { id:1,  type:'select', focus:'Richtung / Ziel',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Ich fahre ___ Berlin.',
        blank:'nach',
        options:['nach','in','zu','durch'],
        explanation:'"nach" steht vor Städte- und Ländernamen (ohne Artikel): nach Berlin, nach Deutschland.' },
      { id:2,  type:'select', focus:'Zweck / Zugehörigkeit',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Das Paket ist ___ dich.',
        blank:'für',
        options:['für','von','zu','gegen'],
        explanation:'"für" + Akkusativ drückt Zweck oder Empfänger aus: Das ist für dich.' },
      { id:3,  type:'select', focus:'Verkehrsmittel',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Sie fährt ___ dem Fahrrad zur Arbeit.',
        blank:'mit',
        options:['mit','auf','in','an'],
        explanation:'Verkehrsmittel werden mit "mit" + Dativ ausgedrückt: mit dem Bus, mit dem Zug.' },
      { id:4,  type:'select', focus:'Herkunft / Verlassen eines Ortes',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Er kommt gerade ___ der Schule.',
        blank:'aus',
        options:['aus','von','nach','bei'],
        explanation:'"aus" = Herkunft aus einem Gebäude/Land. "von" = Wegpunkt (von einer Person, von der Arbeit).' },
      { id:5,  type:'select', focus:'Erwartung / Ziel',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Wir warten ___ den nächsten Bus.',
        blank:'auf',
        options:['auf','an','für','bei'],
        explanation:'"warten auf" + Akkusativ: auf jemanden/etwas warten (fixed phrase).' },
      { id:6,  type:'select', focus:'Zeitdauer (Gegenwart)',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Ich lerne Deutsch ___ einem Jahr.',
        blank:'seit',
        options:['seit','vor','ab','für'],
        explanation:'"seit" + Dativ = Zeitraum, der in der Vergangenheit begann und noch andauert.' },
      { id:7,  type:'select', focus:'Position / Lage',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Das Café ist direkt ___ dem Bahnhof.',
        blank:'gegenüber',
        options:['gegenüber','neben','vor','hinter'],
        explanation:'"gegenüber" + Dativ = direkt auf der anderen Seite. Kann auch nachgestellt werden: dem Bahnhof gegenüber.' },
      { id:8,  type:'select', focus:'Zufriedenheit (feste Verbindung)',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Wir sind ___ den Ergebnissen sehr zufrieden.',
        blank:'mit',
        options:['mit','von','über','zu'],
        explanation:'"zufrieden sein mit" + Dativ ist eine feste Verbindung.' },
      { id:9,  type:'select', focus:'Fortbewegung',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Er geht immer ___ Fuß.',
        blank:'zu',
        options:['zu','mit','auf','per'],
        explanation:'"zu Fuß" ist eine feste Wendung = on foot. Immer ohne Artikel.' },
      { id:10, type:'select', focus:'Interesse (feste Verbindung)',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Ich interessiere mich sehr ___ Musik.',
        blank:'für',
        options:['für','an','mit','über'],
        explanation:'"sich interessieren für" + Akkusativ ist eine feste Verbindung.' },
      { id:11, type:'select', focus:'Durchquerung',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Wir fahren ___ den Tunnel.',
        blank:'durch',
        options:['durch','über','um','an'],
        explanation:'"durch" + Akkusativ = Bewegung durch etwas hindurch.' },
      { id:12, type:'select', focus:'Herkunft (von einer Person/Stelle)',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Er kommt direkt ___ der Arbeit.',
        blank:'von',
        options:['von','aus','nach','ab'],
        explanation:'"von" + Dativ = Wegpunkt (von der Arbeit ≠ aus dem Büro: "aus" betont das Gebäude).' },
      { id:13, type:'select', focus:'Nettigkeit (feste Verbindung)',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Das ist sehr nett ___ dir!',
        blank:'von',
        options:['von','für','zu','bei'],
        explanation:'"nett von jemandem" = it\'s nice of you. Im Deutschen: von + Dativ.' },
      { id:14, type:'select', focus:'Übereinstimmung (feste Verbindung)',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Ich bin ___ dir einverstanden.',
        blank:'mit',
        options:['mit','zu','von','bei'],
        explanation:'"einverstanden sein mit" + Dativ = to agree with someone.' },
      { id:15, type:'select', focus:'Ziel (Richtung zu einer Person)',
        instruction:'Wähle die richtige Präposition.',
        prompt:'Ich gehe morgen ___ dem Arzt.',
        blank:'zu',
        options:['zu','nach','bei','an'],
        explanation:'"zu" + Dativ = Ziel bei Personen und bestimmten Institutionen: zum Arzt, zum Bäcker.' },
    ]
  },

  'prep-deklination': {
    name: 'Präpositionen: Deklination',
    exercises: [
      { id:1,  type:'select', focus:'Dativ maskulin',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'mit ___ (der Bus)',
        blank:'dem Bus',
        options:['dem Bus','den Bus','der Bus','des Busses'],
        explanation:'"mit" regiert immer Dativ. Maskulin Dativ → dem: mit dem Bus.' },
      { id:2,  type:'select', focus:'Akkusativ feminin',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'für ___ (die Frau)',
        blank:'die Frau',
        options:['die Frau','der Frau','den Frauen','der Frauen'],
        explanation:'"für" regiert Akkusativ. Feminin Akkusativ → die (gleich wie Nominativ): für die Frau.' },
      { id:3,  type:'select', focus:'Akkusativ neutrum',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'durch ___ (das Dorf)',
        blank:'das Dorf',
        options:['das Dorf','dem Dorf','des Dorfes','den Dörfern'],
        explanation:'"durch" regiert Akkusativ. Neutrum Akkusativ → das (gleich wie Nominativ): durch das Dorf.' },
      { id:4,  type:'select', focus:'Dativ feminin',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'seit ___ (die Kindheit)',
        blank:'der Kindheit',
        options:['der Kindheit','die Kindheit','dem Kindheit','des Kindheit'],
        explanation:'"seit" regiert Dativ. Feminin Dativ → der: seit der Kindheit.' },
      { id:5,  type:'select', focus:'Dativ neutrum',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'nach ___ (das Konzert)',
        blank:'dem Konzert',
        options:['dem Konzert','das Konzert','des Konzerts','den Konzerten'],
        explanation:'"nach" regiert Dativ. Neutrum Dativ → dem: nach dem Konzert.' },
      { id:6,  type:'select', focus:'Genitiv maskulin',
        instruction:'Dekliniere den Artikel (+ Nomen) nach der Präposition.',
        prompt:'wegen ___ (der Regen)',
        blank:'des Regens',
        options:['des Regens','dem Regen','den Regen','der Regen'],
        explanation:'"wegen" regiert Genitiv. Maskulin Genitiv → des + Nomen-(e)s: des Regens.' },
      { id:7,  type:'select', focus:'Genitiv neutrum',
        instruction:'Dekliniere den Artikel (+ Nomen) nach der Präposition.',
        prompt:'trotz ___ (das Wetter)',
        blank:'des Wetters',
        options:['des Wetters','dem Wetter','das Wetter','der Wetters'],
        explanation:'"trotz" regiert Genitiv. Neutrum Genitiv → des + Nomen-(e)s: des Wetters.' },
      { id:8,  type:'select', focus:'Genitiv feminin',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'während ___ (die Nacht)',
        blank:'der Nacht',
        options:['der Nacht','die Nacht','dem Nacht','des Nacht'],
        explanation:'"während" regiert Genitiv. Feminin Genitiv → der (kein -s am Nomen): während der Nacht.' },
      { id:9,  type:'select', focus:'Dativ maskulin (Wechselpräp., Wo?)',
        instruction:'Wo? → Dativ. Dekliniere den Artikel.',
        prompt:'Das Buch liegt auf ___ (der Tisch).',
        blank:'dem Tisch',
        options:['dem Tisch','den Tisch','der Tisch','des Tisches'],
        explanation:'liegen = Wo? → Dativ. Maskulin Dativ → dem: auf dem Tisch.' },
      { id:10, type:'select', focus:'Akkusativ maskulin (Wechselpräp., Wohin?)',
        instruction:'Wohin? → Akkusativ. Dekliniere den Artikel.',
        prompt:'Ich lege das Buch auf ___ (der Tisch).',
        blank:'den Tisch',
        options:['den Tisch','dem Tisch','der Tisch','des Tisches'],
        explanation:'legen = Wohin? → Akkusativ. Maskulin Akkusativ → den: auf den Tisch.' },
      { id:11, type:'select', focus:'Dativ neutrum (Wechselpräp., Wo?)',
        instruction:'Wo? → Dativ. Dekliniere den Artikel.',
        prompt:'Sie sitzt in ___ (das Café).',
        blank:'dem Café',
        options:['dem Café','das Café','des Cafés','den Cafés'],
        explanation:'sitzen = Wo? → Dativ. Neutrum Dativ → dem: in dem Café (→ im Café).' },
      { id:12, type:'select', focus:'Akkusativ feminin (Wechselpräp., Wohin?)',
        instruction:'Wohin? → Akkusativ. Dekliniere den Artikel.',
        prompt:'Er hängt das Bild an ___ (die Wand).',
        blank:'die Wand',
        options:['die Wand','der Wand','das Wand','den Wand'],
        explanation:'hängen (tr.) = Wohin? → Akkusativ. Feminin Akkusativ → die: an die Wand.' },
      { id:13, type:'select', focus:'Dativ Plural',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'mit ___ (die Kinder)',
        blank:'den Kindern',
        options:['den Kindern','die Kinder','der Kinder','des Kindes'],
        explanation:'Plural Dativ → den + Nomen + (-n wenn nötig): mit den Kindern.' },
      { id:14, type:'select', focus:'Akkusativ maskulin',
        instruction:'Dekliniere den Artikel nach der Präposition.',
        prompt:'ohne ___ (der Fehler)',
        blank:'einen Fehler',
        options:['einen Fehler','einem Fehler','ein Fehler','eines Fehlers'],
        explanation:'"ohne" regiert Akkusativ. Maskulin Akkusativ indef. → einen: ohne einen Fehler.' },
    ]
  },
};

// ═══════════════════════════════════════════════════════════════
//  EXERCISES MODE
// ═══════════════════════════════════════════════════════════════

let _exSets        = [];   // [{name, slug, source_type, source_ref, generated, count}]
let _exCurrentSlug = null;
let _exExercises   = [];   // exercises array for current set
let _exIdx         = 0;
let _exResults     = [];   // {id, correct} per exercise
let _exAnswered    = false;
let _exPollTimer   = null;

/** Opens the full-screen exercise panel and pushes a history entry. */
function openExercises() {
  _navPush({ panel: 'exercises' });
  $('exercisePanel').classList.add('open');
  _exShowView('library');
  _exLoadSets();
}

/** Closes the exercise panel and replaces history state with main. */
function closeExercises() {
  $('exercisePanel').classList.remove('open');
  _navReplace({});
}

/**
 * Switches between exercise sub-views.
 * @param {'library'|'practice'|'end'} view
 */
function _exShowView(view) {
  const views = { library: 'exViewLibrary', practice: 'exViewPractice', end: 'exViewEnd' };
  const subtitles = {
    library:  'Exercise Library',
    practice: _exCurrentSlug || 'Practice',
    end:      'Results',
  };
  for (const [k, id] of Object.entries(views))
    $(id).classList.toggle('hidden', k !== view);
  $('exSubtitle').textContent = subtitles[view];
}

/** Fetches /list-exercises and re-renders the library. */
async function _exLoadSets() {
  try {
    const r = await fetch('/list-exercises');
    _exSets = r.ok ? (await r.json()).sets || [] : [];
  } catch (_) { _exSets = []; }
  _exRenderLibrary();
}

/** Renders set chips, specialized section, and empty state. */
function _exRenderLibrary() {
  const strip = $('exSetsStrip');
  strip.innerHTML = _exSets.map(s => {
    const label = s.name.length > 26 ? s.name.slice(0, 24) + '…' : s.name;
    return `<button class="ex-set-chip${s.slug === _exCurrentSlug ? ' active' : ''}" data-slug="${s.slug}">` +
      `<span class="ex-chip-count">${s.count}</span>${_escHtml(label)}` +
      `<span class="ex-chip-del" data-del="${s.slug}">×</span></button>`;
  }).join('');

  $('exLibraryEmpty').classList.toggle('hidden', _exSets.length > 0);

  const specialStrip = $('exSpecialStrip');
  specialStrip.innerHTML = Object.entries(SPECIALIZED_SETS).map(([key, s]) => {
    const active = key === _exCurrentSlug;
    return `<button class="ex-special-chip${active ? ' active' : ''}" data-special="${key}">` +
      `<span class="ex-chip-count">${s.exercises.length}</span>${_escHtml(s.name)}</button>`;
  }).join('');
}

/** Starts a built-in specialized exercise set (no server fetch). */
async function _exStartBuiltin(key) {
  const set = SPECIALIZED_SETS[key];
  if (!set) return;
  _exCurrentSlug = key;
  _exExercises   = set.exercises.map((ex, i) => ({ ...ex, id: i + 1 }));
  _exIdx         = 0;
  _exResults     = [];
  _navPush({ panel: 'exercise', slug: key });
  _exShowView('practice');
  _exRenderCard();
}

// Strip click — start practice or delete
$('exSetsStrip').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); _exDeleteSet(del.dataset.del); return; }
  const chip = e.target.closest('.ex-set-chip');
  if (chip && chip.dataset.slug) _exStart(chip.dataset.slug);
});

// Specialized set click
$('exSpecialStrip').addEventListener('click', e => {
  const chip = e.target.closest('.ex-special-chip');
  if (chip && chip.dataset.special) _exStartBuiltin(chip.dataset.special);
});

/** Sets up and starts an exercise set — UI only, no history change. */
async function _exStartUI(slug) {
  try {
    const r    = await fetch(`/exercise/${slug}`);
    const data = await r.json();
    if (!data.ok) return;
    _exCurrentSlug = slug;
    _exExercises   = data.exercises || [];
    _exIdx         = 0;
    _exResults     = [];
    _exShowView('practice');
    _exRenderCard();
  } catch (_) {}
}

/** Navigates to an exercise set and starts it. Pushes a history entry. */
async function _exStart(slug) {
  _navPush({ panel: 'exercise', slug });
  await _exStartUI(slug);
}

/** Renders the current exercise card. */
function _exRenderCard() {
  const ex = _exExercises[_exIdx];
  if (!ex) { _exShowEnd(); return; }

  _exAnswered = false;
  $('exCounter').textContent = `${_exIdx + 1} / ${_exExercises.length}`;
  $('exProgressFill').style.width = `${(_exIdx / _exExercises.length) * 100}%`;
  $('btnExNext').classList.add('hidden');

  const focusHtml = ex.focus
    ? `<div class="ex-focus">${_escHtml(ex.focus.replace(/-/g, ' '))}</div>` : '';

  let answerHtml;
  if (ex.type === 'select') {
    const opts = [...(ex.options || [])].sort(() => Math.random() - 0.5);
    answerHtml = `<div class="ex-options">${
      opts.map(o =>
        `<button class="ex-opt" data-opt="${_escHtml(o)}">${_escHtml(o)}</button>`
      ).join('')
    }</div>`;
  } else {
    answerHtml = `<div class="ex-fill-area">
      <input class="ex-fill-input" id="exFillInput" type="text"
        placeholder="Deine Antwort…"
        autocorrect="off" autocapitalize="off" spellcheck="false">
      <button class="btn btn-primary" id="btnExCheck">Check →</button>
    </div>`;
  }

  $('exCard').innerHTML = `
    ${focusHtml}
    <div class="ex-instruction">${_escHtml(ex.instruction || '')}</div>
    <div class="ex-prompt">${_exFormatPrompt(ex.prompt || '')}</div>
    <div>${answerHtml}</div>
    <div class="ex-result hidden" id="exResult">
      <div class="ex-verdict" id="exVerdict"></div>
      <p class="ex-exp-text hidden" id="exExpText"></p>
    </div>`;

  if (ex.type === 'select') {
    $('exCard').querySelectorAll('.ex-opt').forEach(btn =>
      btn.addEventListener('click', () => _exCheckAnswer(btn.dataset.opt))
    );
  } else {
    const input = $('exFillInput');
    input.focus();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !_exAnswered) _exCheckAnswer(input.value);
      else if (e.key === 'Enter' && _exAnswered) $('btnExNext').click();
    });
    $('btnExCheck').addEventListener('click', () => _exCheckAnswer(input.value));
  }
}

/** Highlights the blank placeholder in the prompt HTML. */
function _exFormatPrompt(prompt) {
  return _escHtml(prompt).replace(/___/g, '<span class="ex-blank">___</span>');
}

/** Normalizes an answer for comparison: trim, lowercase, umlaut-substitution. */
function _exNormalize(s) {
  return (s || '').trim().toLowerCase()
    .replace(/ae/g, 'ä').replace(/oe/g, 'ö').replace(/ue(?!r)/g, 'ü').replace(/\bss\b/g, 'ß');
}

/** Checks the submitted answer, shows result, reveals Next button. */
function _exCheckAnswer(answer) {
  if (_exAnswered) return;
  _exAnswered = true;

  const ex      = _exExercises[_exIdx];
  const correct = _exNormalize(answer) === _exNormalize(ex.blank);
  _exResults.push({ id: ex.id, correct });

  const resultEl  = $('exResult');
  const verdictEl = $('exVerdict');
  const expEl     = $('exExpText');

  resultEl.classList.remove('hidden');
  if (correct) {
    verdictEl.className = 'ex-verdict ex-verdict-ok';
    verdictEl.textContent = '✓ Richtig!';
  } else {
    verdictEl.className = 'ex-verdict ex-verdict-err';
    verdictEl.innerHTML = `✗ Falsch — <span class="ex-correct-answer">${_escHtml(ex.blank)}</span>`;
  }
  if (ex.explanation) {
    expEl.classList.remove('hidden');
    expEl.textContent = ex.explanation;
  }

  if (ex.type === 'select') {
    $('exCard').querySelectorAll('.ex-opt').forEach(btn => {
      btn.disabled = true;
      if (_exNormalize(btn.dataset.opt) === _exNormalize(ex.blank))
        btn.classList.add('ex-opt-correct');
      else if (_exNormalize(btn.dataset.opt) === _exNormalize(answer))
        btn.classList.add('ex-opt-wrong');
    });
  } else {
    const input = $('exFillInput');
    input.disabled = true;
    input.classList.add(correct ? 'ex-fill-correct' : 'ex-fill-wrong');
    const checkBtn = document.getElementById('btnExCheck');
    if (checkBtn) checkBtn.disabled = true;
  }

  $('btnExNext').classList.remove('hidden');
  $('btnExNext').focus();
}

/** Shows the end-of-set summary screen. */
function _exShowEnd() {
  $('exProgressFill').style.width = '100%';
  const total   = _exResults.length;
  const correct = _exResults.filter(r => r.correct).length;
  const pct     = total ? Math.round(correct / total * 100) : 0;
  const label   = pct >= 80 ? 'Sehr gut!' : pct >= 60 ? 'Gut gemacht!' : 'Weiter üben!';

  $('exEndWrap').innerHTML = `
    <div class="ex-end-score">${correct} / ${total}</div>
    <div class="ex-end-pct">${pct}%</div>
    <div class="ex-end-label">${_escHtml(label)}</div>`;

  const wrongIds = new Set(_exResults.filter(r => !r.correct).map(r => r.id));
  const retryBtn = $('btnExRetryWrong');
  retryBtn.disabled = wrongIds.size === 0;
  retryBtn.onclick = () => {
    _exExercises = _exExercises.filter(ex => wrongIds.has(ex.id));
    _exIdx = 0; _exResults = [];
    _exShowView('practice');
    _exRenderCard();
  };

  _exShowView('end');
}

/** Deletes an exercise set. */
async function _exDeleteSet(slug) {
  try {
    await fetch('/delete-exercise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    if (_exCurrentSlug === slug) _exCurrentSlug = null;
    await _exLoadSets();
  } catch (_) {}
}

/** POSTs a generation request to /queue-exercises. Returns requestId or null. */
async function _exQueueGenerate({ sourceType, sourceRef, original, correction, name }) {
  try {
    const res  = await fetch('/queue-exercises', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ source_type: sourceType, source_ref: sourceRef, original, correction, name }),
    });
    const data = await res.json();
    return data.ok ? data.requestId : null;
  } catch (_) { return null; }
}

/** Polls /exercise-status every 2s; calls onReady(slug) when done. */
function _exPollStatus(requestId, onReady) {
  if (_exPollTimer) clearInterval(_exPollTimer);
  let polls = 0;
  _exPollTimer = setInterval(async () => {
    polls++;
    try {
      const r = await fetch(`/exercise-status?id=${requestId}`);
      const d = await r.json();
      if (d.pending) return;
      clearInterval(_exPollTimer); _exPollTimer = null;
      if (d.ok && d.slug) onReady(d.slug);
    } catch (_) {}
    if (polls > 150) { clearInterval(_exPollTimer); _exPollTimer = null; } // 5 min cap
  }, 2000);
}

// Topic generation from library bar
$('btnGenTopic').addEventListener('click', async () => {
  const tag = $('exTopicInput').value.trim();
  if (!tag) return;
  const btn = $('btnGenTopic');
  btn.textContent = '⟳ Generating…';
  btn.disabled = true;

  const requestId = await _exQueueGenerate({
    sourceType: 'topic', sourceRef: tag,
    name: `Topic — ${tag}`,
  });
  if (!requestId) {
    btn.textContent = '✗ Error';
    setTimeout(() => { btn.textContent = 'Generate →'; btn.disabled = false; }, 2000);
    return;
  }
  _exPollStatus(requestId, async (slug) => {
    btn.textContent = 'Generate →';
    btn.disabled = false;
    $('exTopicInput').value = '';
    await _exLoadSets();
    _exStart(slug);
  });
});
$('exTopicInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btnGenTopic').click();
});

// Nav / close buttons
$('btnExercises').addEventListener('click', openExercises);
$('btnExerciseClose').addEventListener('click', closeExercises);
$('btnExNext').addEventListener('click', () => { _exIdx++; _exRenderCard(); });
$('btnExBack').addEventListener('click', () => {
  _navPush({ panel: 'exercises' });
  _exShowView('library');
  _exRenderLibrary();
});
$('btnExBackLib').addEventListener('click', () => {
  _navPush({ panel: 'exercises' });
  _exShowView('library');
  _exRenderLibrary();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('exercisePanel').classList.contains('open')) closeExercises();
});
