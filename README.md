# 🐼 Panda Docs

Ein kleiner Google-Docs-Klon, dessen Inhalt mit einem **Passwort verschlüsselt** ist.
Das Repository kann öffentlich sein: Im Repo liegt nur verschlüsselter Datensalat
(`data/vault.json`). Ohne Passwort kann niemand die Dokumente lesen.

## Funktionen

- Editor im Google-Docs-Stil: Überschriften, Schriftart/-größe, fett/kursiv/unterstrichen,
  Farben, Listen, Ausrichtung, Einzüge, Links, Bilder, Tabellen, Trennlinien, Drucken
- Mehrere Dokumente mit Seitenleiste und Volltextsuche
- Automatisches Speichern (verschlüsselt im Browser und verschlüsselt im GitHub-Repo)
- Synchronisation zwischen Geräten mit Zusammenführung pro Dokument
- Passwort ändern, Tresor exportieren/importieren, automatisches Sperren nach 30 Minuten

## So funktioniert der Schutz

```
Passwort ──PBKDF2-SHA256 (600 000 Runden, zufälliges Salt)──▶ 256-Bit-Schlüssel
Dokumente (JSON) ──AES-256-GCM (zufälliger IV pro Speichern)──▶ data/vault.json
```

- Ver- und Entschlüsselung passieren **ausschließlich im Browser** (WebCrypto-API).
  Das Passwort wird nirgends gespeichert oder übertragen.
- In `data/vault.json` stehen nur Salt, IV, der Zeitpunkt der letzten Änderung
  und der Geheimtext. Titel, Inhalte und Anzahl der Dokumente sind nicht lesbar.
- AES-GCM erkennt Manipulationen: Eine veränderte Datei lässt sich nicht entschlüsseln.

**Wichtig**

- Die Sicherheit hängt an der **Stärke deines Passworts**. Jeder kann die Datei aus dem
  öffentlichen Repo herunterladen und offline Passwörter durchprobieren. Nimm deshalb
  eine lange Passphrase (z. B. 4–5 zufällige Wörter).
- **Passwort vergessen = Daten weg.** Es gibt keine Hintertür.
- Git vergisst nichts: Alte Versionen der Datei bleiben in der Historie, verschlüsselt mit
  dem damals gültigen Passwort. Ein Passwortwechsel sperrt also niemanden aus, der das
  alte Passwort schon kannte.
- Der GitHub-Token wird mit im Tresor gespeichert (also ebenfalls verschlüsselt), damit
  du nach dem Entsperren auf jedem Gerät speichern kannst.

## Einrichtung

1. **GitHub Pages einschalten:** Repository → *Settings* → *Pages* → *Source: Deploy from a branch*,
   Branch `main`, Ordner `/ (root)`. Die App ist dann unter
   `https://pandahero1234.github.io/panda/` erreichbar.
2. Seite öffnen und ein **Passwort festlegen** → der Tresor wird angelegt.
3. **Token anlegen**, damit die App ins Repo schreiben darf:
   [Fine-grained Token erstellen](https://github.com/settings/personal-access-tokens/new) →
   *Only select repositories*: `panda` → *Repository permissions* → *Contents: Read and write*.
4. In der App auf ⚙ klicken, Token eintragen, *Übernehmen*. Ab jetzt wird jede Änderung
   automatisch als verschlüsselter Commit in `data/vault.json` gespeichert.

Ohne Token funktioniert die App auch – dann liegen die Dokumente nur (verschlüsselt) im
`localStorage` des Browsers. Über ⚙ → *Verschlüsselten Tresor herunterladen* kann man die
Datei auch von Hand ins Repo legen.

## Lokal starten

```bash
python3 -m http.server 8080
```

Dann `http://localhost:8080` öffnen.

## Tests

```bash
npm test
```

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html`, `css/style.css` | Oberfläche |
| `js/app.js` | Editor, Sperrbildschirm, Einstellungen, Speichern/Sync |
| `js/vault.js` | Verschlüsselung (PBKDF2 + AES-256-GCM) |
| `js/github.js` | Lesen/Schreiben der Tresor-Datei über die GitHub-API |
| `js/store.js` | Datenmodell und Zusammenführen von Ständen |
| `data/vault.json` | Der verschlüsselte Tresor (entsteht beim ersten Speichern) |
