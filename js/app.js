import * as V from './vault.js';
import * as GH from './github.js';
import { emptyState, normalizeState, mergeStates, newId, visibleDocs } from './store.js';

const LS_VAULT = 'panda-docs:vault';
const LS_REPO = 'panda-docs:repo';
const LS_LAST_DOC = 'panda-docs:last-doc';
const AUTO_LOCK_MS = 30 * 60 * 1000;
const MIN_PASSWORD = 8;

const $ = sel => document.querySelector(sel);

// Laufzeitzustand – existiert nur im Speicher, solange der Tresor entsperrt ist.
let keyInfo = null;
let state = null;
let currentId = null;
let remoteSha = null;
let candidates = [];     // gefundene verschlüsselte Tresore (lokal / Repo / Datei)
let saveTimer = null;
let syncTimer = null;
let syncRunning = false;
let syncAgain = false;
let dirtySinceSync = false;
let lockTimer = null;

// ---------- Repository-Konfiguration (nicht geheim, liegt im Klartext lokal) ----------

function defaultRepo() {
  const cfg = { owner: 'PandaHero1234', repo: 'panda', branch: 'main', path: 'data/vault.json' };
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    cfg.owner = host.split('.')[0];
    const first = location.pathname.split('/').filter(Boolean)[0];
    cfg.repo = first && !first.includes('.') ? first : host;
  }
  return cfg;
}

function loadRepo() {
  try {
    return { ...defaultRepo(), ...JSON.parse(localStorage.getItem(LS_REPO) || '{}') };
  } catch {
    return defaultRepo();
  }
}

let repo = loadRepo();
const ghCfg = () => ({ ...repo, token: state?.settings.token || '' });

// ---------- Hilfen ----------

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- HTML-Bereinigung (für Einfügen aus der Zwischenablage & geladene Inhalte) ----------

const ALLOWED_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'SUB', 'SUP',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE', 'UL', 'OL', 'LI', 'A', 'SPAN', 'DIV',
  'FONT', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'IMG', 'MARK']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TITLE',
  'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'HEAD']);
const ALLOWED_STYLES = ['color', 'background-color', 'text-align', 'font-weight', 'font-style',
  'text-decoration', 'text-decoration-line', 'font-size', 'font-family', 'margin-left', 'padding-left'];

function safeUrl(url, allowDataImage) {
  const u = (url || '').trim();
  if (/^(https?:|mailto:|#)/i.test(u)) return u;
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(u)) return u;
  return null;
}

function cleanNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
    const tag = child.tagName.toUpperCase();
    if (DROP_TAGS.has(tag)) { child.remove(); continue; }
    cleanNode(child);
    if (!ALLOWED_TAGS.has(tag)) { child.replaceWith(...child.childNodes); continue; }

    const keep = {};
    if (tag === 'A') {
      const href = safeUrl(child.getAttribute('href'), false);
      if (href) keep.href = href;
    }
    if (tag === 'IMG') {
      const src = safeUrl(child.getAttribute('src'), true);
      if (!src) { child.remove(); continue; }
      keep.src = src;
      if (child.getAttribute('alt')) keep.alt = child.getAttribute('alt');
    }
    if (tag === 'FONT') {
      for (const a of ['color', 'face', 'size']) if (child.hasAttribute(a)) keep[a] = child.getAttribute(a);
    }
    if (tag === 'TD' || tag === 'TH') {
      for (const a of ['colspan', 'rowspan']) if (/^\d+$/.test(child.getAttribute(a) || '')) keep[a] = child.getAttribute(a);
    }
    const style = ALLOWED_STYLES
      .map(p => [p, child.style.getPropertyValue(p)])
      .filter(([, v]) => v && !/url\s*\(|expression/i.test(v))
      .map(([p, v]) => `${p}: ${v}`).join('; ');
    if (style) keep.style = style;

    for (const a of [...child.attributes]) child.removeAttribute(a.name);
    for (const [k, v] of Object.entries(keep)) child.setAttribute(k, v);
    if (tag === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
  }
}

function sanitize(html) {
  const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
  cleanNode(doc.body);
  return doc.body.innerHTML;
}

// ---------- Tresor laden ----------

function readLocalVault() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_VAULT) || 'null');
    return V.isVault(v) ? v : null;
  } catch {
    return null;
  }
}

async function readRemoteVault() {
  // 1. GitHub-API (immer aktuell, liefert die SHA für späteres Speichern)
  try {
    const res = await GH.fetchVault(repo);
    if (res && V.isVault(res.vault)) {
      remoteSha = res.sha;
      return res.vault;
    }
  } catch (e) {
    console.warn('GitHub-API nicht erreichbar:', e.message);
  }
  // 2. Fallback: Datei relativ zur Seite (z. B. GitHub Pages oder lokaler Server)
  try {
    const res = await fetch(repo.path, { cache: 'no-store' });
    if (res.ok) {
      const v = await res.json();
      if (V.isVault(v)) return v;
    }
  } catch { /* keine Datei vorhanden */ }
  return null;
}

async function boot() {
  const local = readLocalVault();
  const remote = await readRemoteVault();
  candidates = [local && { vault: local, source: 'Browser' }, remote && { vault: remote, source: 'Repository' }]
    .filter(Boolean)
    .sort((a, b) => b.vault.updated - a.vault.updated);
  showLock();
}

function showLock(error = '') {
  const hasVault = candidates.length > 0;
  $('#lock-title').textContent = hasVault ? 'Dokumente entsperren' : 'Neuen Tresor anlegen';
  $('#lock-text').textContent = hasVault
    ? `Verschlüsselter Tresor gefunden (${candidates.map(c => c.source).join(' + ')}, Stand ${new Date(candidates[0].vault.updated).toLocaleString('de-DE')}).`
    : `Lege ein Passwort fest (mind. ${MIN_PASSWORD} Zeichen). Ohne dieses Passwort kann niemand – auch du nicht – die Dokumente lesen. Es gibt keine Wiederherstellung!`;
  $('#pw-field').hidden = false;
  $('#pw2-field').hidden = hasVault;
  $('#pw2').required = !hasVault;
  $('#pw').autocomplete = hasVault ? 'current-password' : 'new-password';
  $('#lock-btn').hidden = false;
  $('#lock-btn').disabled = false;
  $('#lock-btn').textContent = hasVault ? 'Entsperren' : 'Tresor erstellen';
  $('#lock-new').hidden = !hasVault;
  $('#lock-error').textContent = error;
  $('#lock').hidden = false;
  $('#app').hidden = true;
  $('#pw').focus();
}

async function onLockSubmit(e) {
  e.preventDefault();
  const pw = $('#pw').value;
  const btn = $('#lock-btn');
  $('#lock-error').textContent = '';
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Bitte warten …';
  try {
    if (candidates.length) await unlock(pw);
    else await createVault(pw, $('#pw2').value);
    $('#pw').value = $('#pw2').value = '';
    enterApp();
  } catch (err) {
    $('#lock-error').textContent = err.message;
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function unlock(pw) {
  const [first, ...rest] = candidates;
  keyInfo = await V.keyForVault(pw, first.vault);
  state = normalizeState(await V.decryptVault(first.vault, keyInfo));
  // Weitere (ältere) Stände mit demselben Passwort zusammenführen.
  for (const c of rest) {
    try {
      const k = V.sameSalt(c.vault, keyInfo) ? keyInfo : await V.keyForVault(pw, c.vault);
      state = mergeStates(state, normalizeState(await V.decryptVault(c.vault, k)));
    } catch {
      toast(`Stand aus „${c.source}“ hat ein anderes Passwort und wurde ignoriert.`, 5000);
    }
  }
  // Mit Token: neuesten Stand direkt aus dem Repo holen (auch für private Repos).
  if (state.settings.token) {
    try {
      const res = await GH.fetchVault(ghCfg());
      if (res) {
        remoteSha = res.sha;
        if (!candidates.some(c => c.vault.data === res.vault.data)) {
          const k = V.sameSalt(res.vault, keyInfo) ? keyInfo : await V.keyForVault(pw, res.vault);
          const remoteState = normalizeState(await V.decryptVault(res.vault, k));
          state = res.vault.updated > first.vault.updated
            ? mergeStates(remoteState, state) : mergeStates(state, remoteState);
        }
      }
    } catch (err) {
      console.warn(err);
    }
  }
  const needsSync = candidates.length > 1 || first.source !== 'Repository';
  await persistLocal();
  if (needsSync) scheduleSync(500);
}

async function createVault(pw, pw2) {
  if (pw.length < MIN_PASSWORD) throw new Error(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
  if (pw !== pw2) throw new Error('Die Passwörter stimmen nicht überein.');
  keyInfo = await V.createKey(pw);
  state = emptyState();
  state.docs.push(welcomeDoc());
  await persistLocal();
}

function welcomeDoc() {
  const now = Date.now();
  return {
    id: newId(), title: 'Willkommen bei Panda Docs', created: now, updated: now,
    html: `<h1>Willkommen 🐼</h1>
<p>Dies ist dein verschlüsselter Dokumenten-Editor. Alles, was du hier schreibst, wird <b>in deinem Browser</b> mit deinem Passwort verschlüsselt (AES-256-GCM).</p>
<h2>Speichern im Repository</h2>
<ol><li>Öffne die <b>Einstellungen</b> (⚙ oben rechts).</li>
<li>Trage einen GitHub-Token mit Schreibrecht auf <i>Contents</i> für dieses Repository ein.</li>
<li>Ab dann wird automatisch eine verschlüsselte Datei <code>data/vault.json</code> ins Repo geschrieben.</li></ol>
<p>Auch wenn das Repository öffentlich ist, sieht dort jeder nur unlesbaren Datensalat.</p>
<blockquote>Wichtig: Wenn du das Passwort vergisst, sind die Dokumente unwiederbringlich verloren.</blockquote>`
  };
}

// ---------- Speichern ----------

async function persistLocal() {
  const vault = await V.encryptVault(state, keyInfo);
  localStorage.setItem(LS_VAULT, JSON.stringify(vault));
  dirtySinceSync = true;
  return vault;
}

function scheduleSave() {
  setStatus('Änderungen werden gespeichert …');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state) return;
  captureEditor();
  await persistLocal();
  renderList();
  if (state.settings.token && state.settings.autosync) {
    setStatus('Lokal gespeichert · Sync folgt …');
    scheduleSync(4000);
  } else {
    setStatus(state.settings.token ? 'Lokal gespeichert (Auto-Sync aus)' : 'Lokal im Browser gespeichert – für GitHub-Sync Token in ⚙ eintragen');
  }
}

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch(() => {}), delay);
}

async function sync({ manual = false } = {}) {
  clearTimeout(syncTimer);
  if (!state) return;
  if (!state.settings.token) {
    if (manual) { toast('Bitte zuerst in den Einstellungen einen GitHub-Token eintragen.'); openSettings(); }
    return;
  }
  if (syncRunning) { syncAgain = true; return; }
  syncRunning = true;
  setStatus('Synchronisiere mit GitHub …');
  try {
    if (saveTimer) await flushSave();
    const cfg = ghCfg();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (remoteSha === null || attempt > 0) {
        const res = await GH.fetchVault(cfg);
        remoteSha = res ? res.sha : undefined;
        if (res && attempt > 0) await mergeRemote(res.vault);
      }
      const vault = await persistLocal();
      try {
        remoteSha = await GH.saveVault(cfg, vault, remoteSha);
        dirtySinceSync = false;
        break;
      } catch (err) {
        // 409/422: Datei wurde zwischenzeitlich anders geändert → neu laden, zusammenführen, erneut versuchen.
        if ((err.status === 409 || err.status === 422) && attempt < 2) continue;
        throw err;
      }
    }
    setStatus('Verschlüsselt in GitHub gespeichert · ' + fmtDate(Date.now()));
    if (manual) toast('Verschlüsselt im Repository gespeichert ✔');
  } catch (err) {
    setStatus('Sync fehlgeschlagen: ' + err.message, true);
    if (manual) toast('Sync fehlgeschlagen: ' + err.message, 5000);
    throw err;
  } finally {
    syncRunning = false;
    if (syncAgain) { syncAgain = false; scheduleSync(1000); }
  }
}

async function mergeRemote(vault) {
  if (!V.sameSalt(vault, keyInfo)) {
    throw new Error('Der Stand im Repository nutzt ein anderes Passwort. Bitte Seite neu laden und mit dem neuen Passwort entsperren.');
  }
  const remoteState = normalizeState(await V.decryptVault(vault, keyInfo));
  captureEditor();
  state = mergeStates(state, remoteState);
  const doc = state.docs.find(d => d.id === currentId);
  if (!doc || doc.deleted) openDoc(visibleDocs(state)[0]?.id);
  else if ($('#page').innerHTML !== doc.html) loadEditor(doc);
  renderList();
}

// ---------- Editor ----------

function currentDoc() {
  return state.docs.find(d => d.id === currentId);
}

function captureEditor() {
  const doc = currentDoc();
  if (!doc) return;
  const html = $('#page').innerHTML;
  const title = $('#doc-title').value;
  if (doc.html !== html || doc.title !== title) {
    doc.html = html;
    doc.title = title;
    doc.updated = Date.now();
  }
}

function loadEditor(doc) {
  $('#page').innerHTML = sanitize(doc.html);
  $('#doc-title').value = doc.title;
  document.title = (doc.title || 'Unbenanntes Dokument') + ' – Panda Docs';
  updateWordCount();
}

function openDoc(id) {
  if (state.docs.length && currentId) captureEditor();
  let doc = state.docs.find(d => d.id === id && !d.deleted);
  if (!doc) doc = visibleDocs(state)[0];
  if (!doc) doc = createDoc(false);
  currentId = doc.id;
  localStorage.setItem(LS_LAST_DOC, doc.id);
  loadEditor(doc);
  renderList();
}

function createDoc(open = true) {
  const now = Date.now();
  const doc = { id: newId(), title: '', html: '<p><br></p>', created: now, updated: now };
  state.docs.push(doc);
  if (open) {
    openDoc(doc.id);
    $('#doc-title').focus();
    scheduleSave();
  }
  return doc;
}

function deleteDoc(id) {
  const doc = state.docs.find(d => d.id === id);
  if (!doc) return;
  if (!confirm(`„${doc.title || 'Unbenanntes Dokument'}“ wirklich löschen?`)) return;
  Object.assign(doc, { deleted: true, html: '', title: '', updated: Date.now() });
  if (id === currentId) {
    currentId = null;
    openDoc(visibleDocs(state)[0]?.id);
  }
  renderList();
  scheduleSave();
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#doc-list');
  list.innerHTML = '';
  const docs = visibleDocs(state).filter(d => {
    if (!q) return true;
    const text = d.id === currentId ? $('#page').textContent : new DOMParser().parseFromString(d.html, 'text/html').body.textContent;
    return (d.title + ' ' + text).toLowerCase().includes(q);
  });
  if (!docs.length) {
    list.innerHTML = `<li class="empty">${q ? 'Keine Treffer' : 'Keine Dokumente'}</li>`;
    return;
  }
  for (const d of docs) {
    const li = document.createElement('li');
    li.classList.toggle('active', d.id === currentId);
    li.innerHTML = `<span>📄</span><div class="meta"><div class="name">${escapeHtml(d.title || 'Unbenanntes Dokument')}</div>
      <div class="date">${fmtDate(d.updated)}</div></div><button class="del" title="Löschen" aria-label="Löschen">🗑</button>`;
    li.addEventListener('click', e => {
      if (e.target.closest('.del')) deleteDoc(d.id);
      else {
        openDoc(d.id);
        if (matchMedia('(max-width: 760px)').matches) $('#sidebar').classList.add('closed');
      }
    });
    list.append(li);
  }
}

function updateWordCount() {
  const words = $('#page').innerText.trim().split(/\s+/).filter(Boolean).length;
  $('#wordcount').textContent = `${words} ${words === 1 ? 'Wort' : 'Wörter'}`;
}

function exec(cmd, value = null) {
  $('#page').focus();
  document.execCommand(cmd, false, value);
  updateToolbar();
  onEdit();
}

function updateToolbar() {
  for (const btn of document.querySelectorAll('#toolbar button[data-cmd]')) {
    let on = false;
    try { on = document.queryCommandState(btn.dataset.cmd); } catch { /* nicht unterstützt */ }
    btn.classList.toggle('on', on);
  }
  try {
    const block = (document.queryCommandValue('formatBlock') || 'p').toUpperCase().replace(/[<>]/g, '');
    const sel = $('#sel-block');
    sel.value = [...sel.options].some(o => o.value === block) ? block : 'P';
    const size = document.queryCommandValue('fontSize');
    if (size) $('#sel-size').value = size;
  } catch { /* ignorieren */ }
}

function onEdit() {
  updateWordCount();
  scheduleSave();
  resetLockTimer();
}

function insertTable() {
  const spec = prompt('Tabellengröße (Spalten x Zeilen):', '3x3');
  if (!spec) return;
  const [cols, rows] = spec.toLowerCase().split('x').map(n => Math.min(20, Math.max(1, parseInt(n, 10) || 0)));
  if (!cols || !rows) return;
  const row = '<tr>' + '<td><br></td>'.repeat(cols) + '</tr>';
  exec('insertHTML', `<table><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`);
}

function enterApp() {
  $('#lock').hidden = true;
  $('#app').hidden = false;
  $('#repo-info').textContent = `🔒 Ende-zu-Ende verschlüsselt · ${repo.owner}/${repo.repo}/${repo.path}`;
  openDoc(localStorage.getItem(LS_LAST_DOC));
  if (matchMedia('(max-width: 760px)').matches) $('#sidebar').classList.add('closed');
  setStatus(state.settings.token ? 'Entsperrt' : 'Nur lokal gespeichert – GitHub-Token in ⚙ eintragen');
  resetLockTimer();
}

async function lock() {
  if (!state) return;
  try {
    if (saveTimer) await flushSave();
    if (dirtySinceSync && state.settings.token && state.settings.autosync) await sync();
  } catch {
    if (!confirm('Synchronisieren fehlgeschlagen. Die Änderungen sind lokal verschlüsselt gespeichert. Trotzdem sperren?')) return;
  }
  // Seite neu laden, damit Schlüssel und Klartext sicher aus dem Speicher verschwinden.
  keyInfo = state = null;
  $('#page').innerHTML = '';
  location.reload();
}

function resetLockTimer() {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => lock(), AUTO_LOCK_MS);
}

// ---------- Einstellungen ----------

function openSettings() {
  $('#cfg-owner').value = repo.owner;
  $('#cfg-repo').value = repo.repo;
  $('#cfg-branch').value = repo.branch;
  $('#cfg-path').value = repo.path;
  $('#cfg-token').value = state.settings.token;
  $('#cfg-autosync').checked = state.settings.autosync;
  $('#test-result').textContent = '';
  $('#pw-result').textContent = '';
  $('#new-pw').value = $('#new-pw2').value = '';
  $('#settings').showModal();
}

function readSettingsForm() {
  return {
    repo: {
      owner: $('#cfg-owner').value.trim(),
      repo: $('#cfg-repo').value.trim(),
      branch: $('#cfg-branch').value.trim() || 'main',
      path: $('#cfg-path').value.trim().replace(/^\/+/, '') || 'data/vault.json'
    },
    token: $('#cfg-token').value.trim(),
    autosync: $('#cfg-autosync').checked
  };
}

async function applySettings() {
  const f = readSettingsForm();
  const repoChanged = JSON.stringify(f.repo) !== JSON.stringify({ owner: repo.owner, repo: repo.repo, branch: repo.branch, path: repo.path });
  const tokenChanged = f.token !== state.settings.token;
  repo = f.repo;
  localStorage.setItem(LS_REPO, JSON.stringify(repo));
  state.settings.token = f.token;
  state.settings.autosync = f.autosync;
  if (repoChanged || tokenChanged) remoteSha = null;
  $('#repo-info').textContent = `🔒 Ende-zu-Ende verschlüsselt · ${repo.owner}/${repo.repo}/${repo.path}`;
  await persistLocal();
  if (f.token) {
    try {
      const res = await GH.fetchVault(ghCfg());
      remoteSha = res ? res.sha : undefined;
      if (res) await mergeRemote(res.vault);
      await sync({ manual: true });
    } catch (err) {
      toast('GitHub: ' + err.message, 5000);
    }
  } else {
    setStatus('Nur lokal gespeichert – GitHub-Token in ⚙ eintragen');
  }
}

async function testConnection() {
  const out = $('#test-result');
  const f = readSettingsForm();
  out.className = 'small';
  out.textContent = 'Teste …';
  try {
    if (!f.token) throw new Error('Kein Token eingetragen');
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(f.repo.owner)}/${encodeURIComponent(f.repo.repo)}`, {
      headers: { Authorization: 'Bearer ' + f.token, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error(res.status === 404 ? 'Repository nicht gefunden oder kein Zugriff' : `${res.status} ${res.statusText}`);
    const info = await res.json();
    if (info.permissions && !info.permissions.push) throw new Error('Token hat kein Schreibrecht');
    out.className = 'small ok';
    out.textContent = `✔ Verbunden (${info.private ? 'privates' : 'öffentliches'} Repo)`;
  } catch (err) {
    out.className = 'small error';
    out.textContent = '✖ ' + err.message;
  }
}

async function changePassword() {
  const pw = $('#new-pw').value;
  const out = $('#pw-result');
  out.className = 'small error';
  if (pw.length < MIN_PASSWORD) { out.textContent = `Mindestens ${MIN_PASSWORD} Zeichen.`; return; }
  if (pw !== $('#new-pw2').value) { out.textContent = 'Passwörter stimmen nicht überein.'; return; }
  out.className = 'small';
  out.textContent = 'Verschlüssele neu …';
  captureEditor();
  keyInfo = await V.createKey(pw);
  await persistLocal();
  $('#new-pw').value = $('#new-pw2').value = '';
  out.className = 'small ok';
  out.textContent = '✔ Passwort geändert';
  if (state.settings.token) sync({ manual: true }).catch(() => {});
}

async function importVaultFile(file, beforeUnlock) {
  let vault;
  try {
    vault = JSON.parse(await file.text());
    if (!V.isVault(vault)) throw new Error();
  } catch {
    toast('Das ist keine gültige Panda-Docs-Tresor-Datei.', 4000);
    return;
  }
  if (beforeUnlock) {
    candidates = [{ vault, source: 'Datei ' + file.name }, ...candidates]
      .sort((a, b) => b.vault.updated - a.vault.updated);
    showLock();
    return;
  }
  try {
    let k = keyInfo;
    if (!V.sameSalt(vault, keyInfo)) {
      const pw = prompt('Passwort der importierten Datei:');
      if (pw === null) return;
      k = await V.keyForVault(pw, vault);
    }
    captureEditor();
    state = mergeStates(state, normalizeState(await V.decryptVault(vault, k)));
    openDoc(currentId);
    scheduleSave();
    toast('Tresor importiert und zusammengeführt ✔');
  } catch (err) {
    toast(err.message, 4000);
  }
}

// ---------- Ereignisse ----------

function bind() {
  $('#lock-form').addEventListener('submit', onLockSubmit);
  $('#lock-import').addEventListener('change', e => {
    if (e.target.files[0]) importVaultFile(e.target.files[0], true);
    e.target.value = '';
  });
  $('#lock-new').addEventListener('click', () => {
    if (!confirm('Einen neuen, leeren Tresor anlegen? Beim ersten Speichern wird der bisherige verschlüsselte Stand im Repository ersetzt (er bleibt in der Git-Historie).')) return;
    candidates = [];
    localStorage.removeItem(LS_VAULT);
    showLock();
  });

  const page = $('#page');
  page.addEventListener('input', onEdit);
  page.addEventListener('keyup', updateToolbar);
  page.addEventListener('mouseup', updateToolbar);
  page.addEventListener('paste', e => {
    const html = e.clipboardData.getData('text/html');
    if (!html) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, sanitize(html));
  });
  page.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, '_blank', 'noopener');
  });

  $('#doc-title').addEventListener('input', () => {
    document.title = ($('#doc-title').value || 'Unbenanntes Dokument') + ' – Panda Docs';
    onEdit();
  });
  $('#doc-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); page.focus(); }
  });

  for (const btn of document.querySelectorAll('#toolbar button[data-cmd]')) {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => exec(btn.dataset.cmd));
  }
  $('#sel-block').addEventListener('change', e => exec('formatBlock', e.target.value));
  $('#sel-font').addEventListener('change', e => exec('fontName', e.target.value));
  $('#sel-size').addEventListener('change', e => exec('fontSize', e.target.value));
  $('#col-fore').addEventListener('input', e => exec('foreColor', e.target.value));
  $('#col-back').addEventListener('input', e => exec('hiliteColor', e.target.value));

  // Auswahl merken, damit prompt() sie nicht verliert.
  const withSelection = fn => () => {
    const sel = getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    fn(() => {
      page.focus();
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
    });
  };
  const addLink = withSelection(restore => {
    const url = safeUrl(prompt('Link-Adresse:', 'https://') || '', false);
    if (!url || url === 'https://') return;
    restore();
    if (getSelection().isCollapsed) exec('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    else exec('createLink', url);
  });
  $('#btn-link').addEventListener('click', addLink);
  $('#btn-image').addEventListener('click', withSelection(restore => {
    const url = safeUrl(prompt('Bild-URL:', 'https://') || '', true);
    if (!url || url === 'https://') return;
    restore();
    exec('insertImage', url);
  }));
  $('#btn-table').addEventListener('click', withSelection(restore => { restore(); insertTable(); }));
  $('#btn-print').addEventListener('click', () => print());

  $('#btn-new').addEventListener('click', () => createDoc());
  $('#search').addEventListener('input', renderList);
  $('#toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('closed'));
  $('#btn-sync').addEventListener('click', () => sync({ manual: true }).catch(() => {}));
  $('#btn-lock').addEventListener('click', lock);
  $('#btn-settings').addEventListener('click', openSettings);

  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue === 'ok') applySettings();
  });
  $('#btn-test').addEventListener('click', testConnection);
  $('#btn-change-pw').addEventListener('click', changePassword);
  $('#btn-export-vault').addEventListener('click', async () => {
    captureEditor();
    const vault = await persistLocal();
    download('panda-docs-vault.json', JSON.stringify(vault, null, 2), 'application/json');
  });
  $('#import-vault').addEventListener('change', e => {
    if (e.target.files[0]) importVaultFile(e.target.files[0], false);
    e.target.value = '';
  });
  $('#btn-export-html').addEventListener('click', () => {
    if (!confirm('Achtung: Die exportierte Datei ist NICHT verschlüsselt. Fortfahren?')) return;
    captureEditor();
    const doc = currentDoc();
    const title = escapeHtml(doc.title || 'Dokument');
    download((doc.title || 'dokument').replace(/[^\w\-äöüÄÖÜß ]+/g, '_') + '.html',
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${sanitize(doc.html)}</body></html>`,
      'text/html');
  });

  document.addEventListener('keydown', e => {
    if (!state) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); sync({ manual: true }).catch(() => {}); }
    if (mod && e.key.toLowerCase() === 'k' && document.activeElement === page) { e.preventDefault(); addLink(); }
    resetLockTimer();
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === page) updateToolbar();
  });
  window.addEventListener('beforeunload', e => {
    if (!state) return;
    if (saveTimer) {
      captureEditor();
      // Letzte Änderung synchron sichern ist mit WebCrypto nicht möglich → Nutzer warnen.
      e.preventDefault();
      e.returnValue = '';
    } else if (dirtySinceSync && state.settings.token && state.settings.autosync) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

bind();
boot().catch(err => {
  console.error(err);
  candidates = [];
  showLock('Fehler beim Laden: ' + err.message);
});
