# Deutsch Karten

A local German flashcard app for vocabulary practice. No frameworks, no database — just a Python server, a YAML word list, and a single HTML file.

## Quick Start

```bash
cd ~/memo
python3 server.py        # default port 8080
# open http://localhost:8080
```

## Features

- **Flip mode** — reveal the German word, mark right / wrong / skip
- **Type mode** — type the answer (with optional article check)
- **Tag filtering** — study by topic (e.g. `b1-lektion-3`, `emotions`, `letter`)
- **Weighted shuffle** — unseen and weak words appear more often
- **Stats** — per-word streaks and session history, persisted to `stats.yaml`
- **Report panel** — 7-day bar chart, mastered words, needs-practice list

## Files

| File | Purpose |
|------|---------|
| `words.yaml` | All vocabulary — the only file you edit to add words |
| `words.js` | Minimal YAML parser (no external deps) |
| `index.html` | Entire app — CSS + JS inline, no build step |
| `server.py` | Static file server + `POST /save-stats` endpoint |
| `stats.yaml` | Auto-generated session and word stats (gitignored) |

## Adding Words

Open `words.yaml` and append an entry following this format:

```yaml
- id: 787          # next sequential integer
  en: example      # English prompt
  uk: приклад      # Ukrainian prompt
  de: Beispiel     # German answer
  article: das     # der / die / das / ~ (for verbs/phrases)
  type: noun       # noun | verb | adj | phrase | adv
  forms:
    pl: die Beispiele   # include forms worth memorising
  tags: [basics]   # one or more tags for filtering
```

Ask Claude to add words — it knows the format and can translate.
