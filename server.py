#!/usr/bin/env python3
"""
Deutsch Karten — local server
Serves static files and persists stats to stats.yaml via POST /save-stats.

Usage:  python3 server.py [port]   (default: 8080)
"""

import http.server
import json
import os
import sys
from datetime import datetime
from pathlib import Path

PORT     = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
BASE_DIR = Path(__file__).parent
STATS    = BASE_DIR / 'stats.yaml'


# ── YAML serialiser (stdlib only) ─────────────────────────────────────────

def _scalar(v):
    if v is None:            return '~'
    if isinstance(v, bool):  return 'true' if v else 'false'
    if isinstance(v, int):   return str(v)
    if isinstance(v, float): return str(round(v, 4))
    s = str(v)
    # Quote if contains special chars
    if any(c in s for c in (':','#','"',"'",'\n')) or s.startswith(' '):
        return '"' + s.replace('\\','\\\\').replace('"','\\"') + '"'
    return s

def _write_yaml(data: dict) -> str:
    lines = [
        '# ─── Deutsch Karten Statistics ──────────────────────────────────',
        f'# Updated: {datetime.now().strftime("%Y-%m-%d %H:%M")}',
        '',
    ]

    # word_stats — one word per line as flow mapping for readability
    lines.append('word_stats:')
    for wid, s in sorted(data.get('word_stats', {}).items(), key=lambda x: int(x[0])):
        keys = ['correct', 'wrong', 'skipped', 'streak', 'first_seen', 'last_seen']
        parts = ', '.join(f'{k}: {_scalar(s[k])}' for k in keys if k in s)
        lines.append(f'  "{wid}": {{ {parts} }}')

    # sessions — block sequence
    lines.append('')
    lines.append('sessions:')
    for sess in data.get('sessions', []):
        first = True
        for k, v in sess.items():
            prefix = '  - ' if first else '    '
            first  = False
            lines.append(f'{prefix}{k}: {_scalar(v)}')

    return '\n'.join(lines) + '\n'


# ── YAML parser (mirrors the JS parser) ───────────────────────────────────

def _parse_scalar(v: str):
    v = v.strip().strip('"').strip("'")
    if v in ('~', 'null', ''): return None
    if v == 'true':  return True
    if v == 'false': return False
    try:    return int(v)
    except ValueError: pass
    try:    return float(v)
    except ValueError: pass
    return v

def _read_yaml(text: str) -> dict:
    data    = {'word_stats': {}, 'sessions': []}
    section = None
    cur_s   = None

    for raw in text.splitlines():
        line     = raw.rstrip()
        stripped = line.lstrip()
        indent   = len(line) - len(stripped)

        if not stripped or stripped.startswith('#'):
            continue

        if line == 'word_stats:': section = 'word_stats'; continue
        if line == 'sessions:':   section = 'sessions';   continue

        if section == 'word_stats' and indent == 2:
            # "1": { correct: 5, wrong: 2, ... }
            import re
            m = re.match(r'"?(\w+)"?\s*:\s*\{(.+)\}', stripped)
            if m:
                obj = {}
                for pair in m.group(2).split(','):
                    pair = pair.strip()
                    if ':' in pair:
                        k, _, v = pair.partition(':')
                        obj[k.strip()] = _parse_scalar(v)
                data['word_stats'][m.group(1)] = obj

        elif section == 'sessions':
            if stripped.startswith('- '):
                if cur_s: data['sessions'].append(cur_s)
                cur_s = {}
                rest = stripped[2:]
                if ': ' in rest:
                    k, _, v = rest.partition(': ')
                    cur_s[k.strip()] = _parse_scalar(v)
            elif indent == 4 and cur_s is not None:
                if ': ' in stripped:
                    k, _, v = stripped.partition(': ')
                    cur_s[k.strip()] = _parse_scalar(v)

    if cur_s: data['sessions'].append(cur_s)
    return data


# ── HTTP handler ───────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def do_OPTIONS(self):
        self._cors(); self.end_headers()

    def do_POST(self):
        if self.path != '/save-stats':
            self.send_response(404); self.end_headers(); return

        length = int(self.headers.get('Content-Length', 0))
        try:
            new_data = json.loads(self.rfile.read(length))

            # Load existing stats
            existing = {'word_stats': {}, 'sessions': []}
            if STATS.exists():
                try:    existing = _read_yaml(STATS.read_text('utf-8'))
                except: pass

            # Merge word_stats (overwrite per-word entries)
            for wid, ws in new_data.get('word_stats', {}).items():
                existing['word_stats'][str(wid)] = ws

            # Append session record if provided
            if new_data.get('session'):
                existing['sessions'].append(new_data['session'])

            STATS.write_text(_write_yaml(existing), 'utf-8')

            self._cors()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _cors(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, fmt, *args):
        # Suppress 200/304 noise; only log errors
        if args and str(args[1]) not in ('200', '304'):
            super().log_message(fmt, *args)


# ── Main ──────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    os.chdir(BASE_DIR)
    print(f'  Deutsch Karten  →  http://localhost:{PORT}')
    print(f'  Stats file      →  {STATS}')
    print( '  Stop with Ctrl+C\n')
    with http.server.HTTPServer(('', PORT), Handler) as httpd:
        try:    httpd.serve_forever()
        except KeyboardInterrupt: print('\nStopped.')
