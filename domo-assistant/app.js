/* Domo Assistant - a chat card that runs inside Domo.
 * Data queries run HERE, in the user's browser, under their own Domo login, so Domo's PDP
 * (store / district / executive) decides what rows they see. The AI reasoning runs on SERVER.
 *
 * SETUP (see HANDOFF.md in the personal-assistant repo):
 *  - SERVER: the My Assistant server on Render.
 *  - APP_KEY: must equal DOMO_APP_KEY in that server's Render environment. Never commit the real value.
 *  - DATASETS: one entry per dataset wired in manifest.json (same alias). name/description tell the AI what it holds.
 */
var SERVER = 'https://my-assistant-rjme.onrender.com';
var APP_KEY = '__DOMO_APP_KEY__';
var DATASETS = [
  { alias: 'INVENTORY_DISPOSITION_FINAL', name: 'Inventory Disposition Final', description: 'Current inventory by store: one row per unit with its status, condition, category and cost.' }
];
var MAX_ROWS = 100;
var MAX_TURN_STEPS = 8;

var D = window.Domo || window.domo;
var $ = function (id) { return document.getElementById(id); };
var log = $('log'), input = $('input'), sendBtn = $('send'), statusEl = $('status');
var state = { user: { id: '', name: '' }, datasets: [], messages: [], busy: false, speak: false };

function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function add(cls, text) { var m = el('div', 'msg ' + cls, text); log.appendChild(m); log.scrollTop = log.scrollHeight; return m; }
function setStatus(parts) {
  statusEl.textContent = '';
  parts.forEach(function (p) { statusEl.appendChild(el('span', p.ok ? 'ok' : 'bad', (p.ok ? '● ' : '○ ') + p.label)); });
}

// ---------- Domo side ----------
function validSelect(sql) {
  var s = String(sql || '').trim();
  if (!/^select\s/i.test(s)) return 'Only SELECT queries are allowed.';
  if (s.indexOf(';') !== -1) return 'Only one statement is allowed.';
  if (/\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke)\b/i.test(s.replace(/'(?:[^']|'')*'/g, "''"))) return 'Read-only queries only.';
  return '';
}
function toObjects(res) {
  if (Array.isArray(res)) return { columns: res.length ? Object.keys(res[0]) : [], rows: res };
  var cols = (res && res.columns) || [];
  var rows = ((res && res.rows) || []).map(function (r) {
    if (!Array.isArray(r)) return r;
    var o = {}; cols.forEach(function (c, i) { o[c] = r[i]; }); return o;
  });
  return { columns: cols, rows: rows };
}
function runSql(alias, sql) {
  // Domo SQL API for apps: POST /sql/v1/{alias} with the SQL as plain text; the alias is the table name.
  return D.post('/sql/v1/' + encodeURIComponent(alias), sql, { contentType: 'text/plain' }).then(toObjects);
}
function loadUser() {
  return D.get('/domo/environment/v1/').then(function (e) {
    state.user = { id: String(e.userId || ''), name: String(e.userName || e.userDisplayName || '') };
  }).catch(function () {
    var e = D.env || {}; state.user = { id: String(e.userId || ''), name: String(e.userName || '') };
  });
}
function loadDatasets() {
  return Promise.all(DATASETS.map(function (d) {
    return runSql(d.alias, 'SELECT * FROM ' + d.alias + ' LIMIT 1').then(function (r) {
      return { alias: d.alias, name: d.name, description: d.description, columns: r.columns, ok: true };
    }).catch(function (err) {
      return { alias: d.alias, name: d.name, description: d.description, columns: [], ok: false, error: String((err && err.message) || err) };
    });
  })).then(function (list) { state.datasets = list; });
}

// ---------- Server side ----------
function server(path, body) {
  return fetch(SERVER + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-Domo-App-Key': APP_KEY } : { 'X-Domo-App-Key': APP_KEY },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) throw new Error(data.error || ('Server error ' + res.status));
      return data;
    });
  });
}

function showData(call, result) {
  var d = el('details', 'data');
  d.appendChild(el('summary', '', 'Data used: ' + call.input.alias + (result.error ? ' (error)' : ' · ' + result.rowCount + ' row' + (result.rowCount === 1 ? '' : 's'))));
  d.appendChild(el('div', 'sql', call.input.sql));
  if (result.error) d.appendChild(el('div', 'sql', result.error));
  else {
    var rows = el('div', 'rows');
    result.rows.slice(0, 10).forEach(function (r) {
      var row = el('div', 'row');
      Object.keys(r).forEach(function (k) { var s = el('span'); s.appendChild(el('b', '', k)); s.appendChild(document.createTextNode(r[k] == null ? '—' : String(r[k]))); row.appendChild(s); });
      rows.appendChild(row);
    });
    d.appendChild(rows);
    if (result.rows.length > 10) d.appendChild(el('div', '', 'First 10 of ' + result.rows.length + ' rows shown.'));
  }
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}

function runCall(call) {
  var a = call.input || {};
  var known = state.datasets.some(function (d) { return d.alias === a.alias; });
  var bad = !known ? 'Unknown dataset alias.' : validSelect(a.sql);
  var p = bad ? Promise.resolve({ error: bad }) : runSql(a.alias, a.sql).then(function (r) {
    var truncated = r.rows.length > MAX_ROWS;
    return { columns: r.columns, rows: r.rows.slice(0, MAX_ROWS), rowCount: r.rows.length, truncated: truncated };
  }).catch(function (err) { return { error: 'Query failed: ' + String((err && (err.message || err.statusText)) || err).slice(0, 400) }; });
  return p.then(function (result) {
    showData(call, result);
    var text = JSON.stringify(result); if (text.length > 12000) text = text.slice(0, 12000) + '…[truncated]';
    return { type: 'tool_result', tool_use_id: call.id, content: text, is_error: !!result.error };
  });
}

function turn(step) {
  var payload = { user: state.user, datasets: state.datasets.filter(function (d) { return d.ok; }), messages: state.messages };
  return server('/domo/chat', payload).then(function (out) {
    state.messages = out.messages || state.messages;
    if (out.status !== 'needs_client') return out.text;
    if (step >= MAX_TURN_STEPS) return (out.text ? out.text + '\n\n' : '') + 'I stopped after several steps. Ask again a little more specifically.';
    return Promise.all(out.calls.map(runCall)).then(function (results) {
      state.messages.push({ role: 'user', content: results });
      return turn(step + 1);
    });
  });
}

function ask(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true; sendBtn.disabled = true;
  add('user', text.trim());
  var before = state.messages.slice();
  state.messages.push({ role: 'user', content: text.trim() });
  var thinking = add('note', 'Working on it…');
  turn(0).then(function (answer) {
    thinking.remove(); add('bot', answer); speak(answer);
  }).catch(function (err) {
    thinking.remove(); add('err', String((err && err.message) || err));
    // Put the conversation back exactly as it was before this question, so the next one starts clean.
    state.messages = before;
  }).then(function () {
    // Keep the conversation bounded; always start on a plain user message.
    if (state.messages.length > 40) { state.messages = state.messages.slice(-30); while (state.messages.length && typeof state.messages[0].content !== 'string') state.messages.shift(); }
    state.busy = false; sendBtn.disabled = false; input.focus();
  });
}

// ---------- Voice (when the browser and Domo allow it) ----------
function speak(text) {
  if (!state.speak || !window.speechSynthesis) return;
  try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 1200))); } catch (e) { /* ignore */ }
}
$('speaker').addEventListener('click', function () {
  state.speak = !state.speak; this.classList.toggle('on', state.speak); this.textContent = state.speak ? '🔊' : '🔈';
  if (!state.speak && window.speechSynthesis) speechSynthesis.cancel();
});
(function setupMic() {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition; var mic = $('mic');
  if (!SR) return;
  mic.hidden = false; var rec = null;
  mic.addEventListener('click', function () {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = false;
    rec.onresult = function (e) { var t = e.results[0][0].transcript; if (t) ask(t); };
    rec.onerror = function (e) { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { mic.hidden = true; add('note', 'The microphone is not available here. Type your question.'); } };
    rec.onend = function () { rec = null; mic.classList.remove('on'); };
    mic.classList.add('on'); try { rec.start(); } catch (e) { rec = null; mic.classList.remove('on'); }
  });
})();

// ---------- UI wiring ----------
$('form').addEventListener('submit', function (e) { e.preventDefault(); var t = input.value; input.value = ''; input.style.height = 'auto'; ask(t); });
input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); } });
input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });
$('clear').addEventListener('click', function () { state.messages = []; log.textContent = ''; greet(); });

function greet() {
  var ok = state.datasets.filter(function (d) { return d.ok; });
  add('bot', 'Hi' + (state.user.name ? ' ' + state.user.name.split(' ')[0] : '') + '. Ask me about ' + (ok.length ? ok.map(function (d) { return d.name; }).join(', ') : 'your data') + '.');
}

// ---------- Boot + connection test ----------
(function boot() {
  if (!D) { setStatus([{ ok: false, label: 'Domo' }]); add('err', 'This app must be opened inside Domo (domo.js did not load).'); return; }
  var serverOk = false, serverMsg = '';
  var ping = server('/domo/ping').then(function (p) {
    serverOk = !!(p.ok && p.ready && p.keyAccepted);
    if (!p.ready) serverMsg = 'The AI server is reachable but not set up yet (DOMO_APP_KEY or the AI key is missing).';
    else if (!p.keyAccepted) serverMsg = 'The AI server did not accept this app\'s key (APP_KEY must match DOMO_APP_KEY).';
  }).catch(function (err) { serverMsg = 'Could not reach the AI server from inside Domo: ' + String((err && err.message) || err); });
  Promise.all([loadUser(), loadDatasets(), ping]).then(function () {
    var dataOk = state.datasets.some(function (d) { return d.ok; });
    setStatus([{ ok: dataOk, label: 'Domo data' }, { ok: serverOk, label: 'AI' }]);
    state.datasets.filter(function (d) { return !d.ok; }).forEach(function (d) { add('err', 'Could not read ' + d.name + ': ' + d.error); });
    if (serverMsg) add('err', serverMsg);
    greet();
  });
})();
