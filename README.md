# 🐼 Panda Docs

Ein kleiner Google-Docs-Klon, dessen Inhalt mit einem **Passwort verschlüsselt** ist.

Code und Daten sind getrennt:

| Repository | Sichtbarkeit | Inhalt |
| --- | --- | --- |
| `panda` | öffentlich | nur der Code der App (läuft über GitHub Pages) |
| `panda-data` | **privat** | nur die verschlüsselte Datei `vault.json` |

Selbst wer Zugriff auf das private Repo bekäme, sähe nur unlesbaren Datensalat.
Ohne Passwort kann niemand die Dokumente lesen.

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
Dokumente (JSON) ──AES-256-GCM (zufälliger IV pro Speichern)──▶ panda-data/vault.json
```

- Ver- und Entschlüsselung passieren **ausschließlich im Browser** (WebCrypto-API).
  Das Passwort wird nirgends gespeichert oder übertragen.
- In `vault.json` stehen nur Salt, IV, der Zeitpunkt der letzten Änderung
  und der Geheimtext. Titel, Inhalte und Anzahl der Dokumente sind nicht lesbar.
- AES-GCM erkennt Manipulationen: Eine veränderte Datei lässt sich nicht entschlüsseln.

**Zwei Schutzschichten**

1. **Privates Repository:** Fremde kommen gar nicht erst an die verschlüsselte Datei,
   können also auch keine Passwörter offline durchprobieren. Alte Versionen und
   Metadaten (wann du schreibst) bleiben ebenfalls privat. Schalte für dein
   GitHub-Konto unbedingt die Zwei-Faktor-Anmeldung ein.
2. **Verschlüsselung:** Falls das private Repo doch einmal offenliegt (Konto gehackt,
   versehentlich öffentlich gemacht), schützt weiterhin das Passwort.

**Wichtig**

- Nimm trotzdem ein starkes Passwort (z. B. 4–5 zufällige Wörter) – es ist die
  letzte Verteidigungslinie.
- **Passwort vergessen = Daten weg.** Es gibt keine Hintertür.
- Git vergisst nichts: Alte Versionen der Datei bleiben in der Historie, verschlüsselt mit
  dem damals gültigen Passwort. Ein Passwortwechsel sperrt also niemanden aus, der das
  alte Passwort schon kannte.
- Der GitHub-Token wird mit im Tresor gespeichert (also ebenfalls verschlüsselt). Auf einem
  **neuen Gerät** gibst du ihn einmal zusammen mit dem Passwort auf dem Anmeldebildschirm
  ein; danach reicht das Passwort.

## Einrichtung

1. **Privates Daten-Repo anlegen:** `panda-data`, Sichtbarkeit *Private* (darf leer sein).
2. **GitHub Pages für `panda` einschalten:** Repository → *Settings* → *Pages* →
   *Source: Deploy from a branch*, Branch `main`, Ordner `/ (root)`. Die App ist dann unter
   `https://pandahero1234.github.io/panda/` erreichbar.
3. **Token anlegen**, damit die App die Daten lesen und schreiben darf:
   [Fine-grained Token erstellen](https://github.com/settings/personal-access-tokens/new) →
   *Repository access: Only select repositories* → **`panda-data`** →
   *Repository permissions* → *Contents: Read and write*. Ein Ablaufdatum ist sinnvoll;
   einen neuen Token trägst du später unter ⚙ ein.
4. App öffnen → *Neuen Tresor anlegen* → Passwort (2×) und Token eingeben. Ab jetzt wird jede
   Änderung automatisch als verschlüsselter Commit in `panda-data/vault.json` gespeichert.
5. Auf weiteren Geräten: App öffnen → Passwort + Token eingeben → *Tresor laden*.

Der Speicherort (Besitzer, Repository, Branch, Pfad) lässt sich auf dem Anmeldebildschirm
unter „Speicherort“ und in der App unter ⚙ ändern. Ohne Token funktioniert die App auch –
dann liegen die Dokumente nur (verschlüsselt) im `localStorage` des Browsers.

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
| `panda-data/vault.json` | Der verschlüsselte Tresor (im privaten Repo, entsteht beim ersten Speichern) |
