// My Assistant - vanilla JS front end. All text is rendered with textContent (no innerHTML).
const $ = (s) => document.querySelector(s);
const view = $('#view');

// ---------- DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const clear = (el) => { while (el.firstChild) el.firstChild.remove(); };
const present = (list) => list.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
function show(...nodes) { clear(view); view.append(...present(nodes)); view.scrollTop = 0; }

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'MyAssistant', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && state.me && !path.startsWith('/auth/')) { state.me = null; route(); }
  if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

// ---------- State ----------
const state = { me: null, integrations: null, messages: [], pending: [], sending: false };
const isOwner = () => state.me?.role === 'owner';
const isAdmin = () => ['owner', 'admin'].includes(state.me?.role);
const fmtTime = (iso) => { const d = new Date(iso); return iso && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; };
const num = (n) => Number(n || 0).toLocaleString();

// ---------- Voice ----------
const voice = {
  speakerOn: localStorage.getItem('speaker') !== 'off',
  Recognition: window.SpeechRecognition || window.webkitSpeechRecognition,
  rec: null, listening: false,
};
function renderSpeaker() {
  $('#speakerBtn').textContent = voice.speakerOn ? '🔊' : '🔇';
  $('#speakerBtn').setAttribute('aria-pressed', String(voice.speakerOn));
}
$('#speakerBtn').addEventListener('click', () => {
  voice.speakerOn = !voice.speakerOn;
  localStorage.setItem('speaker', voice.speakerOn ? 'on' : 'off');
  if (!voice.speakerOn) stopSpeaking();
  renderSpeaker();
});
function speak(text) {
  if (!voice.speakerOn || !('speechSynthesis' in window) || !text) return;
  const clean = String(text).replace(/[*_#`>|]/g, '').replace(/https?:\/\/\S+/g, 'link').slice(0, 3000);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.onend = u.onerror = () => { $('#stopTalk').hidden = true; };
  $('#stopTalk').hidden = false;
  speechSynthesis.speak(u);
}
function stopSpeaking() { if ('speechSynthesis' in window) speechSynthesis.cancel(); $('#stopTalk').hidden = true; }
$('#stopTalk').addEventListener('click', stopSpeaking);

function setupMic() {
  const mic = $('#micBtn');
  if (!voice.Recognition) { mic.hidden = true; return; }
  mic.hidden = false;
  mic.addEventListener('click', () => {
    if (voice.listening) { voice.rec?.stop(); return; }
    stopSpeaking();
    const rec = new voice.Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      $('#chatInput').value = (finalText + interim).trim();
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed') toast('Microphone permission was blocked.'); };
    rec.onend = () => {
      voice.listening = false; mic.classList.remove('listening'); mic.setAttribute('aria-label', 'Talk');
      const text = $('#chatInput').value.trim();
      if (finalText.trim() && text) sendChat(text);
    };
    voice.rec = rec; voice.listening = true;
    mic.classList.add('listening'); mic.setAttribute('aria-label', 'Stop listening');
    try { rec.start(); } catch { voice.listening = false; mic.classList.remove('listening'); }
  });
}

// ---------- Notices (in-flow, never floating) ----------
function toast(text, ms = 5000) {
  const n = h('div', { class: 'notice' }, h('div', { class: 'main' }, text), h('button', { class: 'btn small', onclick: () => n.remove() }, 'OK'));
  $('#notices').append(n);
  if (ms) setTimeout(() => n.remove(), ms);
}

// ---------- Reminders polling ----------
let reminderTimer = null;
async function pollReminders() {
  if (!state.me || state.me.mustChangePassword) return;
  try {
    const { reminders } = await api('/api/reminders/due');
    for (const r of reminders) {
      await api(`/api/reminders/${r.id}/delivered`, { method: 'POST', body: {} });
      const n = h('div', { class: 'notice' }, h('div', { class: 'main' }, h('strong', {}, '⏰ Reminder: '), r.text),
        h('button', { class: 'btn small', onclick: () => n.remove() }, 'Got it'));
      $('#notices').append(n);
      speak(`Reminder: ${r.text}`);
    }
  } catch { /* offline */ }
}

// ---------- Router ----------
const TITLES = { chat: 'My Assistant', todos: 'To-dos', reminders: 'Reminders', notes: 'Notes', more: 'More', memory: 'Memory',
  activity: 'Activity', settings: 'Settings', apps: 'Apps', admin: 'Admin' };

function setChrome(tab, { back = null, composer = false } = {}) {
  $('#title').textContent = TITLES[tab] || 'My Assistant';
  $('#nav').hidden = !state.me || state.me.mustChangePassword;
  $('#composer').hidden = !composer;
  const b = $('#backBtn');
  b.hidden = !back;
  b.onclick = back ? () => { location.hash = back; } : null;
  const navTab = ['chat', 'todos', 'reminders', 'notes'].includes(tab) ? tab : 'more';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === navTab));
}

async function route() {
  if (!state.me) {
    try {
      const me = await api('/api/me');
      state.me = me.user; state.integrations = me.integrations;
    } catch { state.me = null; }
  }
  if (!state.me) return renderAuth();
  if (state.me.mustChangePassword) return renderForcePassword();
  if (!reminderTimer) { pollReminders(); reminderTimer = setInterval(pollReminders, 30000); }

  const [path, query] = (location.hash.slice(1) || 'chat').split('?');
  const [tab, ...rest] = path.split('/');
  const params = new URLSearchParams(query || '');
  try {
    switch (tab) {
      case 'todos': return await renderTodos();
      case 'reminders': return await renderReminders();
      case 'notes': return await renderNotes();
      case 'more': return renderMore();
      case 'memory': return await renderMemory();
      case 'activity': return await renderActivity();
      case 'settings': return await renderSettings(params);
      case 'apps': return isOwner() ? await (rest[0] ? renderAppDetail(rest[0]) : renderApps()) : renderChat();
      case 'admin': return isAdmin() ? await renderAdmin(rest) : renderChat();
      default: return await renderChat();
    }
  } catch (e) {
    show(h('div', { class: 'card error' }, e.message || 'Something went wrong.'));
  }
}
window.addEventListener('hashchange', route);

// ---------- Auth ----------
async function renderAuth() {
  setChrome('chat');
  $('#nav').hidden = true;
  let status = { firstUser: false, signupOpen: false };
  try { status = await api('/auth/status'); } catch { /* ignore */ }
  let mode = status.firstUser ? 'signup' : 'signin';
  const err = h('p', { class: 'error' });
  const form = h('form', { class: 'card auth' });
  const draw = () => {
    clear(form); err.textContent = '';
    const signup = mode === 'signup';
    form.append(...present([
      h('h2', {}, signup ? (status.firstUser ? 'Create the owner account' : 'Sign up') : 'Sign in'),
      status.firstUser ? h('p', { class: 'muted' }, 'This first account becomes the owner.') : null,
      signup ? h('label', { class: 'field' }, h('span', {}, 'Your name'), h('input', { type: 'text', name: 'name', autocomplete: 'name' })) : null,
      h('label', { class: 'field' }, h('span', {}, 'Email'), h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
      h('label', { class: 'field' }, h('span', {}, 'Password (8+ characters)'), h('input', { type: 'password', name: 'password', required: true, autocomplete: signup ? 'new-password' : 'current-password' })),
      signup && !status.firstUser ? h('label', { class: 'field' }, h('span', {}, 'Invite code'), h('input', { type: 'text', name: 'inviteCode', autocomplete: 'off' })) : null,
      err,
      h('button', { class: 'btn primary full', type: 'submit' }, signup ? 'Create account' : 'Sign in'),
      !status.firstUser && status.signupOpen ? h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = signup ? 'signin' : 'signup'; draw(); } },
        signup ? 'Have an account? Sign in' : 'Have an invite code? Sign up')) : null,
    ]));
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      const body = { ...f, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      await api(mode === 'signup' ? '/auth/signup' : '/auth/signin', { method: 'POST', body });
      state.me = null; location.hash = '#chat'; route();
    } catch (ex) { err.textContent = ex.message; }
  });
  draw();
  show(form);
}

function renderForcePassword() {
  setChrome('settings');
  $('#nav').hidden = true;
  const err = h('p', { class: 'error' });
  const form = h('form', { class: 'card auth' },
    h('h2', {}, 'Set your own password'),
    h('p', { class: 'muted' }, 'You signed in with a temporary password. Choose a new one to continue.'),
    h('label', { class: 'field' }, h('span', {}, 'Temporary password'), h('input', { type: 'password', name: 'currentPassword', required: true, autocomplete: 'current-password' })),
    h('label', { class: 'field' }, h('span', {}, 'New password (8+ characters)'), h('input', { type: 'password', name: 'newPassword', required: true, autocomplete: 'new-password' })),
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: signOut }, 'Sign out')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/auth/change-password', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); state.me = null; route(); } catch (ex) { err.textContent = ex.message; }
  });
  show(form);
}

async function signOut() {
  try { await api('/auth/signout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  state.me = null; clearInterval(reminderTimer); reminderTimer = null; location.hash = '#chat'; route();
}

// ---------- Chat ----------
const msgList = h('div', { class: 'msgs' });
const approvals = h('div');
const tiles = h('div', { class: 'tiles' });

function tile(numText, label, href, alert = false) {
  return h('button', { class: `tile${alert ? ' alert' : ''}`, onclick: () => { location.hash = href; } },
    h('div', { class: 'num' }, numText), h('div', { class: 'lbl' }, label));
}

async function loadTiles() {
  try {
    const s = await api('/api/summary');
    clear(tiles);
    tiles.append(tile(num(s.openTodos), 'Open to-dos', '#todos'), tile(num(s.remindersToday), 'Reminders today', '#reminders'));
    if (s.pendingApprovals) tiles.append(tile(num(s.pendingApprovals), 'Waiting for approval', '#chat', true));
    if (s.appsAvailable) {
      const t = tile('…', 'Apps', '#apps');
      tiles.append(t);
      api('/api/apps').then((a) => {
        t.querySelector('.num').textContent = `${a.count} apps`;
        t.querySelector('.lbl').textContent = `${a.failing} failing`;
        if (a.failing) t.classList.add('alert');
      }).catch(() => { t.querySelector('.lbl').textContent = 'Apps: unavailable'; });
    }
  } catch { /* ignore */ }
}

function renderMessages() {
  clear(msgList);
  if (!state.messages.length) msgList.append(h('div', { class: 'empty' }, `Hi${state.me.name ? ` ${state.me.name}` : ''}. Tap the mic or type to start.`));
  for (const m of state.messages) msgList.append(h('div', { class: `msg ${m.role}${m.pending ? ' pending' : ''}` }, m.content));
  clear(approvals);
  for (const p of state.pending) {
    approvals.append(h('div', { class: 'card approval' },
      h('div', { class: 'muted' }, 'Needs your approval'),
      h('div', { class: 'what' }, p.summary),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => decide(p.id, 'approve') }, 'Approve'),
        h('button', { class: 'btn', onclick: () => decide(p.id, 'cancel') }, 'Cancel'))));
  }
  requestAnimationFrame(() => { view.scrollTop = view.scrollHeight; });
}

async function renderChat() {
  setChrome('chat', { composer: true });
  show(tiles, msgList, approvals);
  loadTiles();
  try {
    const d = await api('/api/chat/history');
    state.messages = d.messages; state.pending = d.pending;
  } catch { /* ignore */ }
  renderMessages();
}

async function sendChat(text) {
  if (state.sending || !text.trim()) return;
  state.sending = true;
  $('#chatInput').value = '';
  autosize();
  if (!location.hash.startsWith('#chat') && location.hash) location.hash = '#chat';
  state.messages.push({ role: 'user', content: text }, { role: 'assistant', content: 'Thinking…', pending: true });
  renderMessages();
  try {
    const d = await api('/api/chat', { method: 'POST', body: { message: text } });
    state.messages.pop();
    state.messages.push({ role: 'assistant', content: d.reply });
    state.pending = d.pending || [];
    speak(d.reply);
  } catch (e) {
    state.messages.pop();
    state.messages.push({ role: 'assistant', content: e.message });
  } finally {
    state.sending = false;
    renderMessages();
    loadTiles();
  }
}

async function decide(id, action) {
  state.pending = state.pending.filter((p) => p.id !== id);
  state.messages.push({ role: 'assistant', content: action === 'approve' ? 'Working on it…' : 'Cancelling…', pending: true });
  renderMessages();
  try {
    const d = await api(`/api/actions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
    state.messages.pop();
    state.messages.push({ role: 'assistant', content: d.reply });
    state.pending = d.pending || [];
    speak(d.reply);
  } catch (e) {
    state.messages.pop();
    state.messages.push({ role: 'assistant', content: e.data?.reply || e.message });
    state.pending = e.data?.pending || state.pending;
  }
  renderMessages();
  loadTiles();
}

function autosize() { const t = $('#chatInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }
$('#chatInput').addEventListener('input', autosize);
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('#chatInput').value); } });
$('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chatInput').value); });

// ---------- To-dos ----------
async function renderTodos() {
  setChrome('todos');
  const { todos } = await api('/api/todos?all=1');
  const open = todos.filter((t) => !t.done); const done = todos.filter((t) => t.done);
  const form = h('form', { class: 'card' },
    h('div', { class: 'row' }, h('input', { type: 'text', name: 'title', placeholder: 'New to-do', required: true, class: 'grow' })),
    h('div', { class: 'row mt8' },
      h('input', { type: 'date', name: 'due_date', class: 'grow', 'aria-label': 'Due date' }),
      h('select', { name: 'priority', class: 'grow', 'aria-label': 'Priority' }, h('option', { value: 'normal' }, 'Normal'), h('option', { value: 'high' }, 'High'), h('option', { value: 'low' }, 'Low')),
      h('button', { class: 'btn primary', type: 'submit' }, 'Add')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!f.due_date) delete f.due_date;
    try { await api('/api/todos', { method: 'POST', body: f }); renderTodos(); } catch (ex) { toast(ex.message); }
  });
  const item = (t) => h('div', { class: `card list-item${t.done ? ' done' : ''}` },
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Done',
      onchange: async (e) => { await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { done: e.target.checked } }); renderTodos(); } })),
    h('div', { class: 'main' }, h('div', { class: 'title' }, t.title),
      h('div', { class: 'muted' }, [t.due_date ? `Due ${t.due_date}` : '', t.priority !== 'normal' ? `${t.priority} priority` : ''].filter(Boolean).join(' · '))),
    h('button', { class: 'btn small danger', onclick: async () => { await api(`/api/todos/${t.id}`, { method: 'DELETE' }); renderTodos(); } }, 'Delete'));
  show(form,
    h('div', { class: 'section-title' }, `Open (${open.length})`), open.length ? open.map(item) : h('div', { class: 'empty' }, 'Nothing open.'),
    done.length ? [h('div', { class: 'section-title' }, `Done (${done.length})`), done.slice(0, 30).map(item)] : null);
}

// ---------- Reminders ----------
async function renderReminders() {
  setChrome('reminders');
  const { reminders } = await api('/api/reminders?all=1');
  const upcoming = reminders.filter((r) => !r.delivered); const past = reminders.filter((r) => r.delivered).reverse();
  const form = h('form', { class: 'card' },
    h('input', { type: 'text', name: 'text', placeholder: 'Remind me to…', required: true }),
    h('div', { class: 'row mt8' },
      h('input', { type: 'datetime-local', name: 'due', required: true, class: 'grow', 'aria-label': 'When' }),
      h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
    h('div', { class: 'muted' }, `Times are in your timezone (${state.me.timezone}).`));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/reminders', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); renderReminders(); } catch (ex) { toast(ex.message); }
  });
  const item = (r) => h('div', { class: 'card list-item' },
    h('div', { class: 'main' }, h('div', {}, r.text), h('div', { class: 'muted' }, r.dueLocal)),
    h('button', { class: 'btn small danger', onclick: async () => { await api(`/api/reminders/${r.id}`, { method: 'DELETE' }); renderReminders(); } }, 'Delete'));
  show(form, h('div', { class: 'section-title' }, `Upcoming (${upcoming.length})`), upcoming.length ? upcoming.map(item) : h('div', { class: 'empty' }, 'No reminders.'),
    past.length ? [h('div', { class: 'section-title' }, 'Delivered'), past.slice(0, 20).map(item)] : null);
}

// ---------- Notes ----------
async function renderNotes(q = '') {
  setChrome('notes');
  const { notes } = await api(`/api/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const search = h('input', { type: 'text', placeholder: 'Search notes', value: q, 'aria-label': 'Search notes' });
  search.addEventListener('change', () => renderNotes(search.value.trim()));
  const form = h('form', { class: 'card' },
    h('input', { type: 'text', name: 'title', placeholder: 'Title (optional)' }),
    h('textarea', { name: 'body', rows: 3, placeholder: 'Note', required: true, class: 'mt8' }),
    h('div', { class: 'row mt8' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save note')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/notes', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); renderNotes(); } catch (ex) { toast(ex.message); }
  });
  show(form, h('div', { class: 'card' }, search),
    notes.length ? notes.map((n) => h('div', { class: 'card list-item' },
      h('div', { class: 'main' }, n.title ? h('h3', {}, n.title) : null, h('div', { class: 'pre-wrap' }, n.body), h('div', { class: 'muted' }, fmtTime(n.created_at))),
      h('button', { class: 'btn small danger', onclick: async () => { await api(`/api/notes/${n.id}`, { method: 'DELETE' }); renderNotes(q); } }, 'Delete')))
      : h('div', { class: 'empty' }, q ? 'No matches.' : 'No notes yet.'));
}

// ---------- More ----------
function renderMore() {
  setChrome('more');
  const link = (href, label) => h('a', { href }, h('span', {}, label), h('span', { class: 'muted' }, '›'));
  show(h('div', { class: 'card menu' },
    link('#memory', 'Memory'), link('#activity', 'Activity'), link('#settings', 'Settings'),
    isOwner() ? link('#apps', 'Apps (Render)') : null,
    isAdmin() ? link('#admin', 'Admin console') : null),
  h('p', { class: 'muted center' }, `Signed in as ${state.me.email} (${state.me.role})`));
}

async function renderMemory() {
  setChrome('memory', { back: '#more' });
  const { facts } = await api('/api/memory');
  show(h('p', { class: 'muted' }, 'Things the assistant remembers about you. Say "remember that…" in chat to add.'),
    facts.length ? facts.map((f) => h('div', { class: 'card list-item' }, h('div', { class: 'main' }, f.fact),
      h('button', { class: 'btn small danger', onclick: async () => { await api(`/api/memory/${f.id}`, { method: 'DELETE' }); renderMemory(); } }, 'Forget')))
      : h('div', { class: 'empty' }, 'Nothing saved yet.'));
}

function activityList(rows) {
  return rows.length ? rows.map((a) => h('div', { class: 'card' },
    h('div', { class: 'row' }, h('strong', {}, a.tool), h('span', { class: `chip ${a.outcome === 'ok' ? 'ok' : /error|denied|failed/.test(a.outcome) ? 'bad' : 'warn'}` }, a.outcome.slice(0, 40)),
      a.approved ? h('span', { class: 'chip ok' }, 'approved') : null),
    h('div', { class: 'muted' }, a.summary), h('div', { class: 'muted' }, fmtTime(a.created_at))))
    : h('div', { class: 'empty' }, 'No activity yet.');
}
async function renderActivity() {
  setChrome('activity', { back: '#more' });
  const { activity } = await api('/api/activity');
  show(activityList(activity));
}

// ---------- Settings ----------
async function renderSettings(params) {
  setChrome('settings', { back: '#more' });
  const me = await api('/api/me');
  state.me = me.user; state.integrations = me.integrations;
  const I = me.integrations;
  if (params?.get('google') === 'connected') toast('Google connected.');
  if (params?.get('google') === 'failed') toast('Google connection failed. Try again.');

  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [state.me.timezone];
  if (!zones.includes(state.me.timezone)) zones.unshift(state.me.timezone);
  const profile = h('form', { class: 'card' }, h('h2', {}, 'Profile'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', name: 'name', value: state.me.name })),
    h('label', { class: 'field' }, h('span', {}, 'Timezone'), h('select', { name: 'timezone' }, zones.map((z) => h('option', { value: z, selected: z === state.me.timezone }, z)))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: () => { profile.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } }, 'Use this device\'s timezone')));
  profile.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const d = await api('/api/me', { method: 'PATCH', body: Object.fromEntries(new FormData(profile)) }); state.me = d.user; toast('Saved.'); } catch (ex) { toast(ex.message); }
  });

  const voiceCard = h('div', { class: 'card' }, h('h2', {}, 'Voice'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: voice.speakerOn, onchange: (e) => { voice.speakerOn = e.target.checked; localStorage.setItem('speaker', voice.speakerOn ? 'on' : 'off'); renderSpeaker(); } }), 'Read replies aloud'),
    h('div', { class: 'muted' }, voice.Recognition ? 'Voice input is available in this browser.' : 'Voice input is not supported in this browser - type instead.'));

  const google = h('div', { class: 'card' }, h('h2', {}, 'Google (Gmail + Calendar)'),
    !I.google.configured ? h('p', { class: 'muted' }, 'Not configured yet.')
      : I.google.connected ? [h('p', {}, `Connected${I.google.email ? ` as ${I.google.email}` : ''}.`),
        h('button', { class: 'btn danger', onclick: async () => { await api('/api/google/disconnect', { method: 'POST', body: {} }); renderSettings(); } }, 'Disconnect')]
        : h('a', { class: 'btn primary linkbtn', href: '/auth/google/start' }, 'Connect Google'));

  const domoInput = h('input', { type: 'password', placeholder: 'Paste your Domo access token', autocomplete: 'off' });
  const domo = h('div', { class: 'card' }, h('h2', {}, 'Domo'),
    !I.domo.configured ? h('p', { class: 'muted' }, 'Not configured yet.') : [
      h('p', {}, I.domo.tokenSet ? `Your token is set (ends ${I.domo.last4}).` : 'No token set - Domo data questions are off.'),
      h('p', { class: 'muted' }, 'Generate it in Domo under your own account. Domo shows you only the data your account is allowed to see.'),
      domoInput,
      h('div', { class: 'row mt8' },
        h('button', { class: 'btn primary', onclick: async () => { try { await api('/api/me/domo-token', { method: 'PUT', body: { token: domoInput.value } }); renderSettings(); } catch (ex) { toast(ex.message); } } }, 'Save token'),
        I.domo.tokenSet ? h('button', { class: 'btn danger', onclick: async () => { await api('/api/me/domo-token', { method: 'DELETE' }); renderSettings(); } }, 'Clear') : null)]);

  const pw = h('form', { class: 'card' }, h('h2', {}, 'Change password'),
    h('label', { class: 'field' }, h('span', {}, 'Current password'), h('input', { type: 'password', name: 'currentPassword', autocomplete: 'current-password', required: true })),
    h('label', { class: 'field' }, h('span', {}, 'New password'), h('input', { type: 'password', name: 'newPassword', autocomplete: 'new-password', required: true })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Change password'));
  pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/auth/change-password', { method: 'POST', body: Object.fromEntries(new FormData(pw)) }); pw.reset(); toast('Password changed.'); } catch (ex) { toast(ex.message); }
  });

  const chatCard = h('div', { class: 'card' }, h('h2', {}, 'Chat history'),
    h('button', { class: 'btn danger', onclick: async () => { if (confirm('Clear your chat history?')) { await api('/api/chat/clear', { method: 'POST', body: {} }); toast('Cleared.'); } } }, 'Clear chat history'));

  show(profile, voiceCard, google, domo, pw, chatCard, h('button', { class: 'btn full', onclick: signOut }, 'Sign out'));
}

// ---------- Apps (owner) ----------
const deployChip = (s) => {
  if (s.suspended) return h('span', { class: 'chip warn' }, 'suspended');
  if (!s.lastDeploy) return h('span', { class: 'chip' }, 'no deploys');
  return h('span', { class: `chip ${s.failing ? 'bad' : /live|succeeded/.test(s.lastDeploy.status) ? 'ok' : 'warn'}` }, s.lastDeploy.status);
};
async function renderApps() {
  setChrome('apps', { back: '#more' });
  show(h('div', { class: 'empty' }, 'Loading services…'));
  const d = await api('/api/apps');
  const failing = d.services.filter((s) => s.failing);
  const card = (s) => h('div', { class: 'card list-item tap', onclick: () => { location.hash = `#apps/${encodeURIComponent(s.id)}`; } },
    h('div', { class: 'main' }, h('div', { class: 'row' }, h('strong', {}, s.name), deployChip(s)),
      s.url ? h('div', { class: 'muted' }, s.url) : null,
      s.lastDeploy ? h('div', { class: 'muted' }, `${s.lastDeploy.commit || ''} ${s.lastDeploy.finishedAt ? '· ' + fmtTime(s.lastDeploy.finishedAt) : ''}`) : null),
    h('span', { class: 'muted' }, '›'));
  show(h('div', { class: 'tiles' }, h('div', { class: 'tile' }, h('div', { class: 'num' }, num(d.count)), h('div', { class: 'lbl' }, 'Apps')),
    h('div', { class: `tile${d.failing ? ' alert' : ''}` }, h('div', { class: 'num' }, num(d.failing)), h('div', { class: 'lbl' }, 'Failing'))),
  h('button', { class: 'btn small', onclick: async () => { await api('/api/apps?refresh=1'); renderApps(); } }, 'Refresh'),
  failing.length ? [h('div', { class: 'section-title' }, 'Failing'), failing.map(card)] : null,
  h('div', { class: 'section-title' }, 'All services'), d.services.map(card));
}
async function renderAppDetail(id) {
  setChrome('apps', { back: '#apps' });
  show(h('div', { class: 'empty' }, 'Loading…'));
  const [dep, logs] = await Promise.allSettled([api(`/api/apps/${encodeURIComponent(id)}/deploys`), api(`/api/apps/${encodeURIComponent(id)}/logs`)]);
  show(h('button', { class: 'btn small', onclick: () => { location.hash = '#apps'; } }, '‹ Back to apps'),
    h('div', { class: 'section-title' }, 'Recent deploys'),
    dep.status === 'fulfilled' ? (dep.value.deploys.length ? dep.value.deploys.map((x) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: `chip ${/failed|canceled/.test(x.status) ? 'bad' : /live/.test(x.status) ? 'ok' : 'warn'}` }, x.status), h('span', { class: 'muted' }, fmtTime(x.createdAt))),
      x.commit ? h('div', {}, x.commit) : null)) : h('div', { class: 'empty' }, 'No deploys.')) : h('div', { class: 'card error' }, dep.reason.message),
    h('div', { class: 'section-title' }, 'Recent logs'),
    logs.status === 'fulfilled' ? h('div', { class: 'card' }, logs.value.logs.length ? h('pre', { class: 'log' }, logs.value.logs.map((l) => `${l.time || ''}  ${l.message}`).join('\n')) : 'No log lines.')
      : h('div', { class: 'card error' }, logs.reason.message));
}

// ---------- Admin ----------
async function renderAdmin(rest) {
  const [section, id] = rest;
  if (section === 'user') return renderAdminUser(id);
  if (section === 'usage') return renderAdminUsage(id);
  if (section === 'audit') return renderAdminAudit(id);
  if (section === 'datasets') return renderDatasets();
  setChrome('admin', { back: '#more' });
  const [{ users }, usage] = await Promise.all([api('/api/admin/users'), api('/api/admin/usage')]);
  const byId = Object.fromEntries(usage.users.map((u) => [u.id, u]));

  const err = h('p', { class: 'error' });
  const create = h('form', { class: 'card', hidden: true },
    h('h2', {}, 'Add a person'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', name: 'name' })),
    h('label', { class: 'field' }, h('span', {}, 'Email'), h('input', { type: 'email', name: 'email', required: true })),
    h('label', { class: 'field' }, h('span', {}, 'Temporary password (they change it at first sign-in)'), h('input', { type: 'text', name: 'password', required: true, autocomplete: 'off' })),
    isOwner() ? h('label', { class: 'field' }, h('span', {}, 'Role'), h('select', { name: 'role' }, h('option', { value: 'user' }, 'User'), h('option', { value: 'admin' }, 'Admin'))) : null,
    h('label', { class: 'field' }, h('span', {}, 'Access level'), h('select', { name: 'accessLevel' }, ['store', 'district', 'executive'].map((a) => h('option', { value: a }, a)))),
    h('div', { class: 'row' }, h('input', { type: 'text', name: 'district', placeholder: 'District label', class: 'grow' }), h('input', { type: 'text', name: 'store', placeholder: 'Store label', class: 'grow' })),
    err, h('div', { class: 'row mt8' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create'), h('button', { class: 'btn', type: 'button', onclick: () => { create.hidden = true; } }, 'Close')));
  create.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const d = await api('/api/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(create)) }); location.hash = `#admin/user/${d.user.id}`; } catch (ex) { err.textContent = ex.message; }
  });

  const daMsg = h('p', { class: 'muted' }, 'Yours: connects the assistant to the data behind all your Domo apps. Team: a separate copy for all Domo users that only includes data protected by PDP, so each person sees their own stores. Run again whenever apps or PDP change.');
  const daList = h('div', {});
  const daBtn = h('button', { class: 'btn primary', type: 'button' }, 'Update my Domo Assistant');
  const daTeam = h('button', { class: 'btn', type: 'button' }, 'Update team version (PDP data only)');
  const runPublish = async (audience) => {
    daBtn.disabled = true; daTeam.disabled = true; daMsg.className = 'muted'; daMsg.textContent = 'Working in Domo… this can take a minute or two. Keep this screen open.'; clear(daList);
    try {
      const r = await api('/api/admin/domo-assistant/publish', { method: 'POST', body: { audience } });
      daMsg.textContent = `Done. ${r.steps.join(' ')}`;
      const cards = (list) => list.map((d) => h('div', { class: 'card' }, h('strong', {}, d.name), h('div', { class: 'muted' }, d.description)));
      daList.append(h('div', { class: 'row mt8' }, h('a', { class: 'btn linkbtn', href: r.designUrl, target: '_blank', rel: 'noopener' }, 'Open this app in Domo')),
        h('div', { class: 'section-title' }, `Connected data (${r.datasets.length})`), ...cards(r.datasets));
      if (r.leftOut.length) daList.append(h('div', { class: 'section-title' }, `Left out — no PDP, everyone would see all rows (${r.leftOut.length})`), ...cards(r.leftOut));
    } catch (ex) { daMsg.textContent = ex.message; daMsg.className = 'error'; }
    daBtn.disabled = false; daTeam.disabled = false;
  };
  daBtn.addEventListener('click', () => runPublish('owner'));
  daTeam.addEventListener('click', () => runPublish('team'));
  const daCard = isOwner() ? h('div', { class: 'card' }, h('h2', {}, 'Domo Assistant'), daMsg, h('div', { class: 'row' }, daBtn, daTeam), daList) : null;
  show(h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { create.hidden = false; } }, '+ Add person'),
    h('a', { class: 'btn linkbtn', href: '#admin/datasets' }, 'Dataset catalog')),
  create, daCard,
  h('div', { class: 'section-title' }, `People (${users.length})`),
  users.map((u) => h('div', { class: 'card list-item tap', onclick: () => { location.hash = `#admin/user/${u.id}`; } },
    h('div', { class: 'main' },
      h('div', { class: 'row' }, h('strong', {}, u.name || u.email), h('span', { class: 'chip' }, u.role), u.disabled ? h('span', { class: 'chip bad' }, 'disabled') : null),
      h('div', { class: 'muted' }, u.email),
      h('div', { class: 'muted' }, [u.accessLevel, u.district && `district ${u.district}`, u.store && `store ${u.store}`].filter(Boolean).join(' · ')),
      h('div', { class: 'muted' }, u.role === 'owner' ? 'AI: house key' : u.aiKey.set ? `AI key ends ${u.aiKey.last4}` : u.houseKeyAllowed ? 'AI: house key allowed' : 'No AI key')),
    h('span', { class: 'muted' }, '›'))),
  h('div', { class: 'section-title' }, 'Usage, last 30 days (tap for daily detail)'),
  h('div', { class: 'tiles' }, users.map((u) => {
    const s = byId[u.id] || {};
    return h('button', { class: 'tile', onclick: () => { location.hash = `#admin/usage/${u.id}`; } },
      h('div', { class: 'num' }, num(s.requests)), h('div', { class: 'lbl' }, `${u.name || u.email}: requests`),
      h('div', { class: 'lbl' }, `${num((s.input_tokens || 0) + (s.output_tokens || 0))} tokens`));
  })));
}

async function renderAdminUser(id) {
  setChrome('admin', { back: '#admin' });
  const { users } = await api('/api/admin/users');
  const u = users.find((x) => String(x.id) === String(id));
  if (!u) return show(h('div', { class: 'card error' }, 'User not found.'));
  const save = async (body, msg = 'Saved.') => { try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); toast(msg); renderAdminUser(id); } catch (ex) { toast(ex.message); } };
  const isTargetOwner = u.role === 'owner';

  const details = h('form', { class: 'card' }, h('h2', {}, u.name || u.email), h('div', { class: 'muted' }, `${u.email} · ${u.role}`),
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', name: 'name', value: u.name })),
    isOwner() && !isTargetOwner ? h('label', { class: 'field' }, h('span', {}, 'Role'),
      h('select', { name: 'role' }, ['user', 'admin'].map((r) => h('option', { value: r, selected: u.role === r }, r)))) : null,
    h('label', { class: 'field' }, h('span', {}, 'Access level (context for the assistant, not a security boundary)'),
      h('select', { name: 'accessLevel' }, ['store', 'district', 'executive'].map((a) => h('option', { value: a, selected: u.accessLevel === a }, a)))),
    h('div', { class: 'row' },
      h('label', { class: 'field grow' }, h('span', {}, 'District'), h('input', { type: 'text', name: 'district', value: u.district })),
      h('label', { class: 'field grow' }, h('span', {}, 'Store'), h('input', { type: 'text', name: 'store', value: u.store }))),
    h('button', { class: 'btn primary', type: 'submit' }, 'Save details'));
  details.addEventListener('submit', (e) => { e.preventDefault(); save(Object.fromEntries(new FormData(details))); });

  const secretCard = (title, path, info, help) => {
    const input = h('input', { type: 'password', placeholder: `Paste ${title}`, autocomplete: 'off' });
    return h('div', { class: 'card' }, h('h3', {}, title),
      h('p', {}, info.set ? `Set (ends ${info.last4}).` : 'Not set.'), help ? h('p', { class: 'muted' }, help) : null, input,
      h('div', { class: 'row mt8' },
        h('button', { class: 'btn primary', onclick: async () => { try { await api(`/api/admin/users/${u.id}/${path}`, { method: 'PUT', body: { value: input.value } }); toast('Saved.'); renderAdminUser(id); } catch (ex) { toast(ex.message); } } }, 'Save'),
        info.set ? h('button', { class: 'btn danger', onclick: async () => { await api(`/api/admin/users/${u.id}/${path}`, { method: 'DELETE' }); renderAdminUser(id); } }, 'Clear') : null));
  };

  const ai = isTargetOwner ? h('div', { class: 'card' }, h('h3', {}, 'AI key'), h('p', {}, 'The owner uses the house key (ANTHROPIC_API_KEY).'))
    : h('div', {}, secretCard('Anthropic API key', 'ai-key', u.aiKey, 'This person\'s chats are billed to this key. Without it they get "No AI key assigned".'),
      isOwner() ? h('div', { class: 'card' }, h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: u.houseKeyAllowed, onchange: (e) => save({ houseKeyAllowed: e.target.checked }) }),
        'May use the house key (your ANTHROPIC_API_KEY) when they have no key of their own')) : null);

  const domo = secretCard('Domo access token', 'domo-token', u.domoToken, 'Generate it in Domo for THIS person\'s Domo account, so Domo applies their PDP.');

  // Repository grants: multi-select picker.
  const repoCard = h('div', { class: 'card' }, h('h3', {}, 'Repository access (read-only)'));
  if (isTargetOwner) repoCard.append(h('p', {}, 'The owner can read every repository the GitHub token can see.'));
  else {
    const chosen = new Set(u.repos);
    const pick = h('div', { class: 'repo-pick' }, h('div', { class: 'muted' }, 'Loading repositories…'));
    const manual = h('input', { type: 'text', placeholder: 'owner/name (add manually)' });
    const drawPick = (list) => {
      clear(pick);
      const all = [...new Set([...list, ...chosen])].sort();
      if (!all.length) pick.append(h('div', { class: 'muted' }, 'No repositories yet.'));
      for (const r of all) {
        pick.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: chosen.has(r), onchange: (e) => { if (e.target.checked) chosen.add(r); else chosen.delete(r); } }), r));
      }
    };
    let available = [];
    api('/api/admin/repos-available').then((d) => { available = d.repos.map((r) => r.repo); drawPick(available); })
      .catch((ex) => { drawPick([]); pick.prepend(h('div', { class: 'muted' }, ex.message)); });
    repoCard.append(pick,
      h('div', { class: 'row mt8' }, h('div', { class: 'grow' }, manual),
        h('button', { class: 'btn small', onclick: () => { const v = manual.value.trim().toLowerCase(); if (v) { chosen.add(v); manual.value = ''; drawPick(available); } } }, 'Add')),
      h('div', { class: 'row mt8' },
        h('button', { class: 'btn primary', onclick: async () => { try { await api(`/api/admin/users/${u.id}/repos`, { method: 'PUT', body: { repos: [...chosen] } }); toast('Repository access saved.'); } catch (ex) { toast(ex.message); } } }, 'Save repository access')));
  }

  const tempPw = h('input', { type: 'text', placeholder: 'New temporary password', autocomplete: 'off' });
  const account = isTargetOwner ? null : h('div', { class: 'card' }, h('h3', {}, 'Account'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, tempPw),
      h('button', { class: 'btn small', onclick: async () => { try { await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: { password: tempPw.value } }); toast('Temporary password set.'); tempPw.value = ''; } catch (ex) { toast(ex.message); } } }, 'Reset password')),
    String(u.id) !== String(state.me.id) ? h('div', { class: 'row mt8' },
      h('button', { class: `btn ${u.disabled ? '' : 'danger'}`, onclick: () => save({ disabled: !u.disabled }, u.disabled ? 'Enabled.' : 'Disabled.') }, u.disabled ? 'Enable account' : 'Disable account')) : null);

  show(details, ai, domo, repoCard, account,
    h('div', { class: 'row' },
      h('a', { class: 'btn linkbtn', href: `#admin/usage/${u.id}` }, 'Usage'),
      h('a', { class: 'btn linkbtn', href: `#admin/audit/${u.id}` }, 'Activity')));
}

async function renderAdminUsage(id) {
  setChrome('admin', { back: '#admin' });
  const d = await api(`/api/admin/usage/${encodeURIComponent(id)}`);
  const grid = h('div', { class: 'grid g4' },
    h('div', { class: 'h t' }, 'Day'), h('div', { class: 'h n' }, 'Requests'), h('div', { class: 'h n' }, 'Input'), h('div', { class: 'h n' }, 'Output'),
    d.daily.map((r) => [h('div', { class: 't' }, r.day), h('div', { class: 'n' }, num(r.requests)), h('div', { class: 'n' }, num(r.input_tokens)), h('div', { class: 'n' }, num(r.output_tokens))]));
  show(h('button', { class: 'btn small', onclick: () => { location.hash = '#admin'; } }, '‹ Back'),
    h('div', { class: 'card' }, h('h2', {}, `Usage: ${d.user.name || d.user.email}`), h('div', { class: 'muted' }, 'Tokens per day, last 90 days'),
      d.daily.length ? grid : h('div', { class: 'empty' }, 'No usage yet.')));
}

async function renderAdminAudit(id) {
  setChrome('admin', { back: `#admin/user/${id}` });
  const d = await api(`/api/admin/audit/${encodeURIComponent(id)}`);
  show(h('button', { class: 'btn small', onclick: () => { location.hash = `#admin/user/${id}`; } }, '‹ Back'),
    h('h2', {}, `Activity: ${d.user.name || d.user.email}`), activityList(d.activity));
}

async function renderDatasets(editing = null) {
  setChrome('admin', { back: '#admin' });
  const { datasets } = await api('/api/admin/datasets');
  const err = h('p', { class: 'error' });
  const e = editing || {};
  const form = h('form', { class: 'card' }, h('h2', {}, editing ? 'Edit dataset' : 'Add dataset'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', name: 'name', value: e.name || '', required: true })),
    h('label', { class: 'field' }, h('span', {}, 'Domo dataset ID'), h('input', { type: 'text', name: 'datasetId', value: e.dataset_id || '', required: true })),
    h('label', { class: 'field' }, h('span', {}, 'What it holds / which questions it answers'), h('textarea', { name: 'description', rows: 3 }, e.description || '')),
    h('label', { class: 'field' }, h('span', {}, 'Column notes (optional)'), h('textarea', { name: 'columnNotes', rows: 3 }, e.column_notes || '')),
    err, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Save' : 'Add'),
      editing ? h('button', { class: 'btn', type: 'button', onclick: () => renderDatasets() }, 'Cancel edit') : null));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api(editing ? `/api/admin/datasets/${editing.id}` : '/api/admin/datasets', { method: editing ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(form)) });
      renderDatasets();
    } catch (ex) { err.textContent = ex.message; }
  });
  const importMsg = h('p', { class: 'muted' }, 'Pulls in every dataset your own Domo login can see. Entries already here are kept.');
  const importBtn = h('button', { class: 'btn primary', type: 'button' }, 'Import all from Domo');
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true; importMsg.textContent = 'Importing from Domo…';
    try {
      const r = await api('/api/admin/datasets/import', { method: 'POST', body: {} });
      toast(`Found ${r.found} datasets, added ${r.added}.`);
      renderDatasets();
    } catch (ex) { importMsg.textContent = ex.message; importMsg.className = 'error'; importBtn.disabled = false; }
  });
  const matchBtn = h('button', { class: 'btn', type: 'button' }, 'Keep only dashboard & app data');
  matchBtn.addEventListener('click', async () => {
    matchBtn.disabled = true; importMsg.className = 'muted'; importMsg.textContent = 'Checking which datasets feed your dashboards and apps… this can take a minute.';
    try {
      const r = await api('/api/admin/datasets/match-cards', { method: 'POST', body: {} });
      toast(`Checked ${r.checked}: ${r.inUse} feed dashboards or apps, ${r.hidden} hidden from the assistant${r.failed ? `, ${r.failed} could not be checked` : ''}.`, 9000);
      renderDatasets();
    } catch (ex) { importMsg.textContent = ex.message; importMsg.className = 'error'; matchBtn.disabled = false; }
  });
  const importCard = h('div', { class: 'card' }, h('h2', {}, 'Import from Domo'), importMsg, h('div', { class: 'row' }, importBtn, matchBtn));
  show(h('button', { class: 'btn small', onclick: () => { location.hash = '#admin'; } }, '‹ Back'), editing ? null : importCard, form,
    h('div', { class: 'section-title' }, `Catalog (${datasets.filter((d) => d.active).length} in use by the assistant, ${datasets.filter((d) => !d.active).length} hidden)`),
    datasets.length ? datasets.map((d) => h('div', { class: 'card' }, h('h3', {}, d.name), h('div', { class: 'muted' }, d.active ? d.dataset_id : `Hidden from the assistant · ${d.dataset_id}`),
      d.description ? h('div', {}, d.description) : null, d.used_by ? h('div', { class: 'muted' }, `Feeds: ${d.used_by}`) : null, d.column_notes ? h('div', { class: 'muted' }, d.column_notes) : null,
      h('div', { class: 'row mt8' }, h('button', { class: 'btn small', onclick: () => renderDatasets(d) }, 'Edit'),
        h('button', { class: 'btn small', onclick: async () => { await api(`/api/admin/datasets/${d.id}/active`, { method: 'PATCH', body: { active: !d.active } }); renderDatasets(); } }, d.active ? 'Hide' : 'Show'),
        h('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Remove ${d.name} from the catalog?`)) { await api(`/api/admin/datasets/${d.id}`, { method: 'DELETE' }); renderDatasets(); } } }, 'Remove'))))
      : h('div', { class: 'empty' }, 'No datasets yet. Add the ones the assistant should know about.'));
}

// ---------- Boot ----------
renderSpeaker();
setupMic();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();

// ---------- Auto-update ----------
// When a new version has been deployed, reload so new screens and buttons appear without the user
// having to close the app. Checked when the app comes back to the foreground and on screen changes.
let loadedBuild = null; let lastBuildCheck = 0;
async function checkBuild() {
  if (Date.now() - lastBuildCheck < 30000) return;
  lastBuildCheck = Date.now();
  try {
    const r = await fetch('/version', { cache: 'no-store' });
    if (!r.ok) return;
    const { build } = await r.json();
    if (!loadedBuild) { loadedBuild = build; return; }
    if (build && build !== loadedBuild) location.reload();
  } catch { /* offline - ignore */ }
}
checkBuild();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkBuild(); });
window.addEventListener('hashchange', checkBuild);
