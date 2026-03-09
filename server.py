#!/usr/bin/env python3
"""
Deutsch Karten — local server
Serves static files and persists stats to stats.yaml via POST /save-stats.
Word-addition requests are queued to .word-queue/ for the Claude background agent.

Usage:  python3 server.py [port]   (default: 8080)
"""

import http.server
import json
import os
import sys
import urllib.parse
from datetime import datetime
from pathlib import Path

PORT      = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
BASE_DIR  = Path(__file__).parent
STATS     = BASE_DIR / 'stats.yaml'
QUEUE_DIR = BASE_DIR / '.word-queue'


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
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        # Status poll for a pending word-addition request
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/add-word-queue':
            return self._handle_queue_list()

        if parsed.path == '/add-word-status':
            params     = urllib.parse.parse_qs(parsed.query)
            request_id = params.get('id', [None])[0]
            if not request_id:
                return self._json({'ok': False, 'error': 'missing id'}, 400)
            done_file = QUEUE_DIR / f'{request_id}.done.json'
            if done_file.exists():
                try:
                    result = json.loads(done_file.read_text('utf-8'))
                    return self._json(result)
                except Exception as e:
                    return self._json({'ok': False, 'error': str(e)}, 500)
            return self._json({'ok': True, 'pending': True})

        # Fall through to static file serving
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get('Content-Length', 0))

        if parsed.path == '/save-stats':
            self._handle_save_stats(length)
        elif parsed.path == '/add-word':
            self._handle_add_word(length)
        elif parsed.path == '/add-batch':
            self._handle_add_batch(length)
        else:
            self.send_response(404); self.end_headers()

    def _handle_queue_list(self):
        """Returns all queue items with their current status."""
        items = []
        if QUEUE_DIR.exists():
            for req_file in sorted(QUEUE_DIR.glob('*.json')):
                if req_file.stem.endswith('.done'):
                    continue
                try:
                    req  = json.loads(req_file.read_text('utf-8'))
                    done = QUEUE_DIR / f'{req_file.stem}.done.json'
                    if done.exists():
                        result = json.loads(done.read_text('utf-8'))
                        req['status'] = 'needs_review' if result.get('needs_review') else ('done' if result.get('ok') else 'error')
                        req['result'] = result
                    else:
                        req['status'] = 'pending'
                    items.append(req)
                except Exception:
                    pass
        self._json({'ok': True, 'items': items})

    def _handle_save_stats(self, length):
        try:
            new_data = json.loads(self.rfile.read(length))

            existing = {'word_stats': {}, 'sessions': []}
            if STATS.exists():
                try:    existing = _read_yaml(STATS.read_text('utf-8'))
                except: pass

            for wid, ws in new_data.get('word_stats', {}).items():
                existing['word_stats'][str(wid)] = ws

            if new_data.get('session'):
                existing['sessions'].append(new_data['session'])

            STATS.write_text(_write_yaml(existing), 'utf-8')
            self._json({'ok': True})

        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _handle_add_word(self, length):
        try:
            body = json.loads(self.rfile.read(length))
            word = body.get('word', '').strip()
            hint = body.get('hint', '').strip()

            if not word:
                return self._json({'ok': False, 'error': 'word is required'}, 400)

            QUEUE_DIR.mkdir(exist_ok=True)
            request_id   = str(int(datetime.now().timestamp() * 1000))
            request_file = QUEUE_DIR / f'{request_id}.json'
            request_file.write_text(json.dumps({
                'requestId':   request_id,
                'word':        word,
                'hint':        hint,
                'submittedAt': datetime.now().isoformat(),
            }, ensure_ascii=False), 'utf-8')

            hint_str = f' (hint: "{hint}")' if hint else ''
            print(f'\n⚡ [{datetime.now().strftime("%H:%M:%S")}] New word: "{word}"{hint_str}')
            print(f'   Queued → .word-queue/{request_id}.json')

            self._json({'ok': True, 'requestId': request_id})

        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _handle_add_batch(self, length):
        try:
            import base64
            body   = json.loads(self.rfile.read(length))
            source = body.get('source', '')   # 'image' | 'pdf' | 'url'
            hint   = body.get('hint', '').strip()

            if source not in ('image', 'pdf', 'url'):
                return self._json({'ok': False, 'error': 'source must be image, pdf, or url'}, 400)

            QUEUE_DIR.mkdir(exist_ok=True)
            request_id = str(int(datetime.now().timestamp() * 1000))

            queue_item = {
                'requestId':   request_id,
                'type':        'batch',
                'source':      source,
                'hint':        hint,
                'submittedAt': datetime.now().isoformat(),
            }

            if source in ('image', 'pdf'):
                data     = body.get('data', '')
                filename = body.get('filename', f'upload.{"pdf" if source == "pdf" else "png"}')
                ext      = Path(filename).suffix or ('.pdf' if source == 'pdf' else '.png')
                saved    = QUEUE_DIR / f'{request_id}.source{ext}'
                saved.write_bytes(base64.b64decode(data))
                queue_item['sourcePath'] = str(saved)
                queue_item['filename']   = filename
                print(f'\n📎 [{datetime.now().strftime("%H:%M:%S")}] Batch import: {filename}')
            elif source == 'url':
                url = body.get('url', '').strip()
                if not url:
                    return self._json({'ok': False, 'error': 'url is required'}, 400)
                queue_item['url'] = url
                print(f'\n🌐 [{datetime.now().strftime("%H:%M:%S")}] Batch import URL: {url}')

            req_file = QUEUE_DIR / f'{request_id}.json'
            req_file.write_text(json.dumps(queue_item, ensure_ascii=False), 'utf-8')
            print(f'   Queued → .word-queue/{request_id}.json')

            self._json({'ok': True, 'requestId': request_id})

        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _json(self, data, status=200):
        self.send_response(status)
        self._cors_headers()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _cors_headers(self):
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
    QUEUE_DIR.mkdir(exist_ok=True)
    print(f'  Deutsch Karten  →  http://localhost:{PORT}')
    print(f'  Stats file      →  {STATS}')
    print(f'  Word queue      →  {QUEUE_DIR}')
    print( '  Stop with Ctrl+C\n')
    with http.server.HTTPServer(('', PORT), Handler) as httpd:
        try:    httpd.serve_forever()
        except KeyboardInterrupt: print('\nStopped.')
