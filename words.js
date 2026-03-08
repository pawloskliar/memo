// YAML parser — handles the subset used in words.yaml.
// Exposed as window.parseYAML for use by index.html.
(function () {
  function parseVal(s) {
    s = (s || '').trim();
    if (!s || s === '~' || s === 'null') return null;
    if (s === 'true')  return true;
    if (s === 'false') return false;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.startsWith('[') && s.endsWith(']'))
      return s.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
    if ((s[0] === '"' && s[s.length - 1] === '"') ||
        (s[0] === "'" && s[s.length - 1] === "'"))
      return s.slice(1, -1);
    return s;
  }

  function parseKV(s) {
    const i = s.indexOf(': ');
    if (i === -1) return s.endsWith(':') ? [s.slice(0, -1).trim(), null] : null;
    return [s.slice(0, i).trim(), parseVal(s.slice(i + 2))];
  }

  window.parseYAML = function (src) {
    const items = [];
    let cur = null;
    let inForms = false;

    for (const raw of src.split('\n')) {
      const line = raw.trimEnd();
      if (!line || line.trimStart().startsWith('#')) continue;

      const indent = line.length - line.trimStart().length;

      if (line.startsWith('- ')) {
        if (cur) items.push(cur);
        cur = {};
        inForms = false;
        const kv = parseKV(line.slice(2));
        if (kv) cur[kv[0]] = kv[1];
        continue;
      }

      if (!cur) continue;

      if (inForms && indent >= 4) {
        const kv = parseKV(line.trimStart());
        if (kv) cur.forms[kv[0]] = kv[1];
        continue;
      }

      if (indent === 2) {
        inForms = false;
        const kv = parseKV(line.trimStart());
        if (!kv) continue;
        const [k, v] = kv;
        if (k === 'forms' && v === null) { cur.forms = {}; inForms = true; }
        else cur[k] = v;
      }
    }

    if (cur) items.push(cur);
    return items;
  };
})();
