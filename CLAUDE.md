# Hinweise für Claude/Agenten in diesem Repo

**Projekt:** ioBroker.waip-web – ioBroker-Adapter für Feuerwehr-/Rettungsdienst-Alarmierung
**GitHub:** rnc11/ioBroker.waip-web

## Konventionen
- Chat mit dem Nutzer auf Deutsch
- Code, Kommentare und Commit-Messages bleiben unverändert (main.js ist bilingual DE:/EN:)
- Jeder Versionsbump (package.json + io-package.json) MUSS sofort getaggt und gepusht werden
- Vor jedem Versionsbump fragen: npm `next` (Beta, X.Y.Z-beta.N) oder `latest` (X.Y.Z) — nie automatisch `latest` annehmen

## Fix-Zyklus
1. implement
2. `node -c main.js`
3. eslint
4. `npm run test:package`
5. README(.de).md aktualisieren
6. common.news aktualisieren (en + de)
7. `npx translate-adapter translate` (Ergebnis gegen en.json prüfen, kann still failen)
8. **Pflicht vor Commit:** `npx @iobroker/repochecker <url> --local` bis "FINAL status OK"
   - Ausnahmen: W4001, W3050/52, E2004/E3032/W2002 (vor Tag-Push)

### Regeln
- common.news: max. 7 Einträge (sonst E1032)
- README-Changelog: nur 5 neueste Einträge, Rest nach CHANGELOG_OLD.md
- Nie einen news-Eintrag für eine ungetaggte Version stehen lassen

## Publishing / Tooling
- gh CLI lokal auth als rnc11
- Vor repochecker: `export OWN_GITHUB_TOKEN=$(gh auth token)` (sonst Rate-Limit)

## Arbeitsweise mit dem Nutzer
- Bei Freigabe eines mehrstufigen Workflows (z. B. kompletter Release-Zyklus) erwartet er die vollständige autonome Durchführung bis zum Ende in einem Zug
- Rückfragen nur an echten Entscheidungspunkten (z. B. npm `next` vs. `latest`), nicht bei jedem Zwischenschritt
