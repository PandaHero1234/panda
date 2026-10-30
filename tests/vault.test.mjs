import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../js/vault.js';
import { mergeStates, normalizeState } from '../js/store.js';

const FAST = 1000; // wenige Iterationen, damit die Tests schnell laufen

test('Ver- und Entschlüsselung ergibt den Originalinhalt', async () => {
  const data = { docs: [{ id: 'a', title: 'Geheim', html: '<p>Hallo Welt äöü 🐼</p>' }] };
  const keyInfo = await V.createKey('richtiges-passwort', FAST);
  const vault = await V.encryptVault(data, keyInfo);
  const key2 = await V.keyForVault('richtiges-passwort', vault);
  assert.deepEqual(await V.decryptVault(vault, key2), data);
});

test('Tresor enthält keinen Klartext', async () => {
  const keyInfo = await V.createKey('pw-12345678', FAST);
  const vault = await V.encryptVault({ docs: [{ title: 'Meine Geheimnotiz' }] }, keyInfo);
  const json = JSON.stringify(vault);
  assert.ok(!json.includes('Geheimnotiz'));
  assert.ok(!json.includes('pw-12345678'));
});

test('Falsches Passwort wird abgelehnt', async () => {
  const keyInfo = await V.createKey('richtig-123', FAST);
  const vault = await V.encryptVault({ x: 1 }, keyInfo);
  const wrong = await V.keyForVault('falsch-123', vault);
  await assert.rejects(V.decryptVault(vault, wrong), V.WrongPasswordError);
});

test('Manipulierter Zeitstempel oder Inhalt wird erkannt', async () => {
  const keyInfo = await V.createKey('richtig-123', FAST);
  const vault = await V.encryptVault({ x: 1 }, keyInfo);
  await assert.rejects(V.decryptVault({ ...vault, updated: vault.updated + 1 }, keyInfo), V.WrongPasswordError);
  const bytes = Buffer.from(vault.data, 'base64');
  bytes[0] ^= 1;
  await assert.rejects(V.decryptVault({ ...vault, data: bytes.toString('base64') }, keyInfo), V.WrongPasswordError);
});

test('Jede Speicherung nutzt einen neuen IV', async () => {
  const keyInfo = await V.createKey('pw-12345678', FAST);
  const a = await V.encryptVault({ x: 1 }, keyInfo, 1);
  const b = await V.encryptVault({ x: 1 }, keyInfo, 1);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.notEqual(a.data, b.data);
});

test('Zusammenführen: neueres Dokument gewinnt, Löschungen bleiben gelöscht', () => {
  const local = normalizeState({
    docs: [
      { id: '1', title: 'neu', html: '', updated: 20 },
      { id: '2', title: '', html: '', updated: 30, deleted: true }
    ],
    settings: { token: 't', autosync: true }
  });
  const remote = normalizeState({
    docs: [
      { id: '1', title: 'alt', html: '', updated: 10 },
      { id: '2', title: 'noch da', html: '', updated: 5 },
      { id: '3', title: 'nur remote', html: '', updated: 7 }
    ]
  });
  const merged = mergeStates(local, remote);
  const byId = Object.fromEntries(merged.docs.map(d => [d.id, d]));
  assert.equal(byId['1'].title, 'neu');
  assert.equal(byId['2'].deleted, true);
  assert.equal(byId['3'].title, 'nur remote');
  assert.equal(merged.settings.token, 't');
});
