// Minimaler Client für die GitHub-Contents-API, um die verschlüsselte
// Tresor-Datei ins Repository zu lesen und zu schreiben.

const API = 'https://api.github.com';

function headers(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

function contentsUrl(cfg) {
  const path = cfg.path.split('/').map(encodeURIComponent).join('/');
  return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function failure(res) {
  let msg = res.status + ' ' + res.statusText;
  try {
    const body = await res.json();
    if (body.message) msg += ': ' + body.message;
  } catch { /* ignorieren */ }
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

// Leerer Branch = Standard-Branch des Repositorys (funktioniert auch bei leeren Repos).
function refQuery(cfg) {
  return cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '';
}

// Liefert { vault, sha } oder null, wenn die Datei (oder das Repo) nicht gefunden wurde.
export async function fetchVault(cfg) {
  const res = await fetch(contentsUrl(cfg) + refQuery(cfg), {
    headers: headers(cfg.token),
    cache: 'no-store'
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const body = await res.json();
  let text;
  if (body.content) {
    text = base64ToUtf8(body.content);
  } else {
    // Dateien > 1 MB liefert die API ohne Inhalt – dann per raw-Medientyp nachladen.
    const raw = await fetch(contentsUrl(cfg) + refQuery(cfg), {
      headers: { ...headers(cfg.token), Accept: 'application/vnd.github.raw' },
      cache: 'no-store'
    });
    if (!raw.ok) throw await failure(raw);
    text = await raw.text();
  }
  return { vault: JSON.parse(text), sha: body.sha };
}

export async function saveVault(cfg, vault, sha) {
  const res = await fetch(contentsUrl(cfg), {
    method: 'PUT',
    headers: { ...headers(cfg.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Verschlüsselte Dokumente aktualisiert',
      content: utf8ToBase64(JSON.stringify(vault, null, 2) + '\n'),
      ...(cfg.branch ? { branch: cfg.branch } : {}),
      ...(sha ? { sha } : {})
    })
  });
  if (!res.ok) throw await failure(res);
  const body = await res.json();
  return body.content.sha;
}
