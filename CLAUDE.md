# Hinweise für Claude/Agenten in diesem Repo

**Projekt:** ioBroker.waip-web – ioBroker-Adapter für Feuerwehr-/Rettungsdienst-Alarmierung
**GitHub:** rnc11/ioBroker.waip-web

## Konventionen
- Chat mit dem Nutzer auf Deutsch
- Code, Kommentare und Commit-Messages bleiben unverändert (main.js ist bilingual DE:/EN:)
- Vor jedem Release fragen: npm `next` (Beta/Prerelease) oder `latest` (stabil) — nie automatisch `latest` annehmen

## Fix-Zyklus
1. implement
2. `npm run check` (= eslint + test:package + i18n-Prüfung)
3. README(.de).md aktualisieren
4. Änderung unter `### **WORK IN PROGRESS**` im README-Changelog eintragen
5. **Pflicht vor Commit:** `npm run check:repo` bis "No findings beyond the known exceptions"

`npm run preflight` führt Schritt 2 und 5 zusammen aus.

### Was die Scripts abnehmen
- `scripts/repocheck.js` — setzt `OWN_GITHUB_TOKEN` automatisch (sonst GitHub-Rate-Limit) und filtert die vier bekannten Ausnahmen (W4001, W3050/52, E2004/E3032/W2002, W9008-False-Positive). W9008 wird pro Pfad mit `git ls-files` gegengeprüft statt pauschal ignoriert. Exit 1 bei jedem übrigen Fund. `--remote` prüft den gepushten Zustand, `--all` zeigt die Rohausgabe.
- `scripts/check-i18n.js` — prüft alle 11 Sprachen in io-package.json + admin/i18n, den 7-Einträge-News-Cap und den Versionsabgleich package.json/io-package.json. Nötig, weil `translate-adapter` auch bei Rate-Limit mit Exit 0 und "Successfully updated" endet, ohne etwas geschrieben zu haben.

## Release
```bash
npm run release          # interaktiv: fragt den Bump-Typ ab
npm run release -- patch # oder direkt
```
`@alcalzone/release-script` übernimmt in einem Zug: Version in package.json + io-package.json bumpen, `### **WORK IN PROGRESS**` durch die Versionsüberschrift ersetzen, News-Eintrag erzeugen, auf 7 News-/5 Changelog-Einträge kürzen (Rest nach CHANGELOG_OLD.md), committen, taggen und pushen. CI published dann via npm Trusted Publishing.

- Prerelease (`next`) = Bump-Typ `prerelease`/`prepatch` → Version bekommt einen Bindestrich; `ioBroker/testing-action-deploy` erkennt das und published mit `--tag next` statt `--tag latest`
- `npm run release -- --dry` für einen Probelauf ohne Änderungen
- **Nicht mehr manuell bumpen/taggen.** Genau die Trennung von Bump und Tag hat 3× (0.7.3, 0.7.5, 0.7.10) verwaiste news-Einträge erzeugt, die Cleanup-Releases nötig machten.

## Publishing / Tooling
- gh CLI lokal auth als rnc11
- PR ioBroker/ioBroker.repositories#6487 („Add waip-web to latest") wartet auf Review von mcm1957

## Arbeitsweise mit dem Nutzer
- Bei Freigabe eines mehrstufigen Workflows (z. B. kompletter Release-Zyklus) erwartet er die vollständige autonome Durchführung bis zum Ende in einem Zug
- Rückfragen nur an echten Entscheidungspunkten (z. B. npm `next` vs. `latest`), nicht bei jedem Zwischenschritt

## Sicherheit
Keine Zugangsdaten (Instanz-URLs, Logins, Tokens) ins Repo — auch nicht in diese Datei oder `.claude/skills/**`, die öffentlich auf GitHub landen.
