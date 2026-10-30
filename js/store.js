// Datenmodell des Tresors und das Zusammenführen zweier Stände
// (z. B. lokaler Browser-Stand und Stand im Repository).

export function emptyState() {
  return { docs: [], settings: { token: '', autosync: true } };
}

export function normalizeState(raw) {
  const state = emptyState();
  if (raw && Array.isArray(raw.docs)) {
    state.docs = raw.docs.filter(d => d && typeof d.id === 'string').map(d => ({
      id: d.id,
      title: typeof d.title === 'string' ? d.title : '',
      html: typeof d.html === 'string' ? d.html : '',
      created: Number(d.created) || 0,
      updated: Number(d.updated) || 0,
      ...(d.deleted ? { deleted: true } : {})
    }));
  }
  if (raw && raw.settings) {
    state.settings.token = typeof raw.settings.token === 'string' ? raw.settings.token : '';
    state.settings.autosync = raw.settings.autosync !== false;
  }
  return state;
}

// Pro Dokument gewinnt die neuere Änderung. Gelöschte Dokumente bleiben als
// Grabstein erhalten, damit sie beim Zusammenführen nicht wieder auftauchen.
// `primary` ist der neuere Gesamtstand; seine Einstellungen werden übernommen.
export function mergeStates(primary, secondary) {
  const byId = new Map();
  for (const d of secondary.docs) byId.set(d.id, d);
  for (const d of primary.docs) {
    const other = byId.get(d.id);
    if (!other || d.updated >= other.updated) byId.set(d.id, d);
  }
  return {
    docs: [...byId.values()],
    settings: { ...secondary.settings, ...primary.settings }
  };
}

export function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function visibleDocs(state) {
  return state.docs.filter(d => !d.deleted).sort((a, b) => b.updated - a.updated);
}
