# CLAUDE.md — Project Context

## What this is

A local German flashcard web app. Pure HTML/CSS/JS + a Python stdlib server.
No frameworks, no npm, no build step. The only runtime dependency is Python 3.

## Running the app

```bash
python3 server.py        # serves on :8080
# open http://localhost:8080
```

The server extends `http.server.SimpleHTTPRequestHandler` and adds one endpoint:
`POST /save-stats` — receives JSON, merges into `stats.yaml`, writes it back.

## File map

```
words.yaml   ← vocabulary data (the only file edited to add words)
words.js     ← window.parseYAML — parses the YAML subset used in words.yaml
index.html   ← entire app (CSS + JS inline, ~1650 lines)
server.py    ← local HTTP server + /save-stats handler
stats.yaml   ← auto-generated; do NOT commit (user progress data)
```

## Architecture

**words.yaml** is fetched by the browser as plain text and parsed by `words.js`.
**stats.yaml** is also fetched at boot; updates are POSTed to `/save-stats` which merges and persists them.
Both fetches happen in parallel via `Promise.all([fetchWords, fetchStats])`.

## Key JS structures

```js
const cfg = { mode, lang, requireArticle, tag }  // settings state
const sess = { words[], idx, correct, wrong, skipped, flipped, checked, startTime }

const Stats = {
  init(data), get(id), record(id, outcome),
  weight(id),     // 1–10; unseen=10, mastered fades to 1 — drives weighted shuffle
  badgeHTML(id),  // renders ✓/✗ dots on card face
  async save(sessionData)
}
```

## Design system (Bauhaus aesthetic)

```css
--bg:   #F0EAE0   /* warm parchment */
--ink:  #1A1A1A
--mint: #35BCB2   /* correct / positive / accent */
--red:  #C42B10   /* wrong / der */
--yellow: #E8B800 /* mid-accuracy */
--der:  #5B8DD9
--die:  #C42B10
--das:  var(--mint)
```

Fonts: Playfair Display (display/headings) · Barlow Condensed (UI) · JetBrains Mono (answer)
Borders: `4px solid var(--ink)`, no border-radius.
Accents: 5px red left bar + 4px mint bottom bar on the card.

## Card flip

CSS 3D transform: `.card { transform-style: preserve-3d }` / `.card.flipped { transform: rotateY(180deg) }`.
**Snap-back fix** (prevents new card's back face flashing):
```js
card.style.transition = 'none';
card.classList.remove('flipped');
card.offsetHeight;   // force reflow
card.style.transition = '';
```

## words.yaml format

```yaml
- id: 1
  en: house
  uk: будинок
  de: Haus
  article: das        # der | die | das | ~ (null)
  type: noun          # noun | verb | adj | phrase | adv
  forms:
    pl: die Häuser    # and/or: gen, dat, acc for nouns; conjugations for verbs
  tags: [basics, home]
```

**Next available ID: 787**
Current vocabulary breakdown:
- IDs 1–10: basics (nouns, verbs, adjectives)
- IDs 11–24: emotions (positive + negative)
- IDs 25–39: picture description phrases
- IDs 40–84: dialogue helpers (6 sub-tags)
- IDs 85–758: B1 vocabulary, Lektionen 1–12 (tagged `b1`, `b1-lektion-N`)
- IDs 759–786: letter-writing phrases (tagged `letter`, `b1-writing`)

## How to add vocabulary

1. Open `words.yaml`
2. Append entries following the format above — sequential IDs, correct article, useful forms
3. Tags: use existing tags where relevant; create new ones for new topics
4. For B1 words, tag `[b1, b1-lektion-N]`; for letter phrases, tag `[letter, b1-writing]`

**Do not** edit `words.js` or `server.py` when adding vocabulary — `words.yaml` only.

## Settings behaviour

Settings are stored in `cfg`. Changing any option sets `_cfgDirty = true`.
When the settings panel closes, if `_cfgDirty`, `startSession()` is called automatically.
The Shuffle button also calls `startSession()` directly (resets `_cfgDirty` at its start).

## Stats persistence

`Stats.save()` POSTs to `/save-stats`:
```json
{ "word_stats": { "1": { "correct": 5, "wrong": 1, "skipped": 0, "streak": 4,
                          "first_seen": "2026-03-08", "last_seen": "2026-03-08" } },
  "session": { "date": "...", "mode": "flip", "tag": null, "correct": 12, ... } }
```
Server merges per-word entries (overwrite) and appends the session record, then rewrites `stats.yaml`.

## Session startup (ALWAYS DO BOTH, IN PARALLEL, BEFORE ANYTHING ELSE)

### 1. Start the dev server

Run this via the Bash tool with `run_in_background: true`:

```bash
kill $(lsof -ti:8080) 2>/dev/null; python3 /Users/pavlo.skliar/memo/server.py
```

This kills any orphaned server on port 8080 and starts a fresh one.
The background Bash task keeps it visible in the session.

### 2. Start the word queue listener

Spawn a background agent to watch the word queue before doing anything else:

```
Agent(
  description: "Word queue listener",
  subagent_type: "general-purpose",
  run_in_background: true,
  prompt: """
    You are a background word-queue processor for the Deutsch Karten flashcard app
    at /Users/pavlo.skliar/memo.

    Poll /Users/pavlo.skliar/memo/.word-queue/ every 5 seconds for files
    matching *.json that do NOT have a corresponding *.done.json.

    When you find one:
    1. Read the request file — it contains { id, word, hint? }
    2. Read words.yaml to determine the next available ID and existing tags
    3. Translate and format the word into a complete YAML entry:
       - de: correct German (with article in the `article` field)
       - en: English translation
       - uk: Ukrainian translation (not Russian)
       - type: noun | verb | adj | phrase | adv
       - forms: only the most useful ones (pl for nouns; past+pp for verbs)
       - tags: reuse existing tags; infer b1-lektion-N if applicable
    4. Append the entry to words.yaml
    5. Write /Users/pavlo.skliar/memo/.word-queue/<id>.done.json:
       { "ok": true, "entry": { ...the full entry... } }
    6. Continue polling.

    If you are uncertain about translation, article, or tags, write:
       { "ok": false, "needs_review": true, "question": "..." }
    to the .done.json so the server can surface it to the user in the browser.

    Never stop polling until this agent is explicitly terminated.
  """
)
```

This listener handles words submitted from the browser "Add Word" panel without
requiring any manual trigger. It runs silently in the background throughout the session.

## What NOT to change

- Do not add external JS dependencies or a build step
- Do not use localStorage (stats are server-persisted)
- Do not change the Bauhaus aesthetic without a strong reason
- Do not use border-radius
