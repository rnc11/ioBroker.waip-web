# Older changes

### 0.7.31 (2026-08-24)

- Fixed two `einsatz.kartenbildPfad` timing/staleness issues:
  - Alarm processing now **waits** for the
    [incident map image](https://github.com/rnc11/ioBroker.waip-web#incident-map-image) to finish before
    continuing, instead of generating it in the background - so
    `einsatz.kartenbildPfad` and `einsatz.alarmAktiv` become available
    together. The wait is capped by a new configurable **OSM timeout**
    (1-60s, default 10s): if the image isn't ready in time, a warning
    is logged and `kartenbildPfad` stays empty for that incident
    instead of blocking alarm processing indefinitely.
  - `einsatz.kartenbildPfad` is now reset immediately when a new
    incident starts, instead of possibly still showing a previous
    incident's stale image path (e.g. when the new incident has no
    coordinates, or the map image feature just got disabled).

### 0.7.30 (2026-08-24)

- [Incident map image](https://github.com/rnc11/ioBroker.waip-web#incident-map-image): new **Show incident-area
  polygon** checkbox (on by default) - uncheck it to always show the
  centered marker dot instead, even when the server sends a polygon.
  The margin kept around the polygon when auto-zooming to fit it was
  also reduced by 30%, so the area fills more of the image. Default
  zoom level raised from 16 to 19, default outline thickness from 3 to
  4 px.
- `einsatz.kartenbildPfad` is now cleared on `io.standby` like the
  other `einsatz.*` fields (previously kept, matching
  `einsatz.tts.last`'s pattern) - the image file itself is unaffected,
  only the 10-image retention limit ever deletes files.
- Documented that this adapter's own data directory (generated map
  images) is only removed on instance/adapter deletion if "Also
  delete instance data" is checked in Admin's deletion dialog - a
  native js-controller/Admin feature (unchecked by default), not
  something this adapter's code controls.
- Removed "Unofficial"/"Inoffiziell" from both READMEs' wording; the
  disclaimer about having no connection to the WAIP-Web project/
  Robert-112 itself is unchanged, just reworded without that word.
- This Changelog section now shows only the 5 most recent versions -
  older entries move to [CHANGELOG_OLD.md](CHANGELOG_OLD.md) on every
  release.

### 0.7.29 (2026-08-24)

- [Incident map image](https://github.com/rnc11/ioBroker.waip-web#incident-map-image): draws the actual incident
  area WAIP-Web sends in the event's `geometry` field (usually a
  circle-shaped polygon around the location) as an outline, instead of
  just a marker dot at its centroid. Falls back to the dot marker if no
  polygon is available (e.g. only a point). The area always stays
  fully visible: the adapter automatically zooms out (never in) past
  the configured zoom level if needed, instead of clipping the area at
  the image edge. Outline color and thickness (1-12 px) are now
  configurable too (also used for the fallback marker dot's core).
- **Rescue-service decoding** (on the [Rescue service](https://github.com/rnc11/ioBroker.waip-web#rescue-service)
  tab) now defaults to **on** for new installations, matching **Process
  rescue-service incidents** (already on by default) - previously it
  defaulted to off. Already-configured instances keep their stored
  value, this only affects fresh installs.
- Trimmed the self-justifying "kept the previous behavior" sentence
  from both checkboxes' admin descriptions and reworded the decoding
  checkbox's description ("has no effect if your dispatch center
  doesn't use one of these patterns" instead of "only enable if...").

### 0.7.28 (2026-08-24)

- New: **Process rescue-service incidents** checkbox on the
  [Rescue service](https://github.com/rnc11/ioBroker.waip-web#rescue-service) tab (on by default) - when
  unchecked, incidents identified as rescue-service calls via
  `einsatzart` are ignored completely (no states, no history, no TTS).
  The tab itself was renamed from "Rescue-service keywords" to "Rescue
  service", with the new checkbox placed first.
- New: [Incident map image](https://github.com/rnc11/ioBroker.waip-web#incident-map-image) tab - optionally
  generates a PNG map (OpenStreetMap tiles, marked with a dot) centered
  on each incident's coordinates, exposed via the new
  `einsatz.kartenbildPfad` state. Configurable image size and zoom
  level; only the 10 most recent images are kept.

### 0.7.27 (2026-08-23)

- [Keyword table](https://github.com/rnc11/ioBroker.waip-web#keyword-descriptions) matching now treats spaces
  and hyphens as equivalent (any run of either collapses to one
  before comparing) - e.g. `H:VU mit P` and `H:VU-mit-P` now match
  the same row, so dispatch-center spelling variants no longer need a
  separate row each. Removed the now-redundant `B:Gebäude-Groß`/
  `B:Gebäude-Klein` rows added in 0.7.24 (the existing `B:Gebäude
  groß`/`B:Gebäude klein` rows already cover them). Comparison was
  already case-insensitive before this change. Admin UI help text
  updated accordingly.

### 0.7.26 (2026-08-23)

- [Keyword descriptions](https://github.com/rnc11/ioBroker.waip-web#keyword-descriptions) tab: `Description` and
  `Match` columns are now sortable too (previously only `Keyword /
  pattern`), and the table's help text was moved above the table
  instead of below - with many rows it used to sit far out of view.

### 0.7.25 (2026-08-23)

- Updated the admin UI text for the [rescue-service decoder](https://github.com/rnc11/ioBroker.waip-web#rescue-service)
  to reflect the two supported keyword spellings added in 0.7.23
  (Leitstelle Lausitz `R1N1p`/`R1N0-NT` and IRLS Brandenburg `R1N1 p`/
  `R1N0 nt`) - the checkbox label/help and the NT suffix label/help
  previously only mentioned the hyphenated no-space form.

### 0.7.24 (2026-08-23)

- Extended the default [keyword table](https://github.com/rnc11/ioBroker.waip-web#keyword-descriptions) with two
  more Brandenburg spelling variants: `B:Gebäude-Groß` and
  `B:Gebäude-Klein` (hyphen instead of space, as used by some dispatch
  centers) - same descriptions as the existing `B:Gebäude groß`/`B:Gebäude
  klein` entries. Only affects the shipped example table for new
  installs - existing configured tables are untouched.

### 0.7.23 (2026-08-23)

- Extended the default [keyword table](https://github.com/rnc11/ioBroker.waip-web#keyword-descriptions) with the
  29 `K`/`V`/`M`/`S` keywords (Krankentransport, Verlegung, MANV,
  Sonderstichwörter) from the IRLS Brandenburg rescue-service catalog
  (v2.7) - previously only the `R<ambulance>N<physician-vehicle>`
  scheme and the Brand/THL (`B:`/`H:`) table were covered, so
  `einsatz.beschreibung` stayed `null` for these.
- Fixed the [rescue-service keyword](https://github.com/rnc11/ioBroker.waip-web#rescue-service) decoder
  (`decodeRettungsdienstStichwort`): it only accepted the Leitstelle
  Lausitz spelling without a space (`R1N1p`, `R1N0-NT`) and silently
  returned `null` for the IRLS Brandenburg spelling with a space
  (`R1N1 p`, `R1N0 nt`) - both are now recognized.
- Only affects the shipped example table and the decoder logic for
  new installs/upgrades - existing configured tables are untouched.

### 0.7.22 (2026-08-23)

- Extended the default [keyword table](https://github.com/rnc11/ioBroker.waip-web#keyword-descriptions) with
  `H:Person-TMR` (technical human rescue) and corrected three entries
  whose pattern didn't match the actual dispatch keyword:
  `H:Flugunfall` → `H:Flugzeugunfall` (`klein`/`groß`), `H:Öl Wasser`
  → `H:Öl auf Wasser`, `H:Rettung aus Höhen/Tiefen` → `H:Rettung aus
  Höhen und Tiefen` (source: Regionalleitstellen Brandenburg keyword
  list, v7.1). Only affects the shipped example table for new
  installs - existing configured tables are untouched.

### 0.7.21 (2026-08-23)

- Removed the keyword table's CSV export/import: a bug in ioBroker
  Admin's own `table` component corrupted German umlauts on CSV
  import (e.g. `Ã¤`/`Ã` instead of `ä`/`ß`) - confirmed to be entirely
  inside the Admin UI, not this adapter's code. Use ioBroker's
  standard instance configuration export/import (JSON) instead - see
  [Keyword descriptions](https://github.com/rnc11/ioBroker.waip-web#keyword-descriptions) for the reload caveat
  after using it.
- Split the admin configuration UI into 3 tabs -
  [Connection](https://github.com/rnc11/ioBroker.waip-web#connection), [Rescue-service
  keywords](https://github.com/rnc11/ioBroker.waip-web#rescue-service),
  [Keyword descriptions](https://github.com/rnc11/ioBroker.waip-web#keyword-descriptions) - each with a
  matching icon, replacing the single combined settings page.
- Documentation: restructured the configuration section of the
  README to mirror the 3 admin tabs, fixed a stale reference to the
  removed CSV feature, and added a couple of small clarifications
  (mentioned `einsatz.beschreibung` in the practical-use-cases
  section, mentioned the 3-tab structure up front). All code comments
  in `main.js` are now bilingual (German + English).

### 0.7.20 (2026-08-22)

- Added `einsatz.beschreibung`: a plain-language description for
  `einsatz.stichwort`, resolved entirely locally (also included in
  `einsatz.json.current`/`.history10`). Two sources, in order:
  - An optional decoder for the `R<RTW>N<NEF>[p][f][-NT]` rescue-service
    keyword scheme used by several dispatch centers - the label for
    each part is fully configurable via 5 new text fields.
  - A user-maintained keyword table (admin table, CSV export/import,
    pre-filled with an example fire/rescue keyword list) where the
    most specific (longest) matching pattern wins automatically,
    regardless of row order - the table can be freely sorted by
    keyword.
  - `null` if nothing matches. See
    [Alarm keyword descriptions](https://github.com/rnc11/ioBroker.waip-web#alarm-keyword-descriptions).

### 0.7.19 (2026-08-22)

- Fixed a bug where incoming feedback (`io.new_rmld`) was silently
  dropped as "wrong monitor" whenever the responding station's number
  (`wache_nr`) differed from the registered monitor ID:
  `payloadMonitorMatch()` incorrectly treated `wache_nr`/`wache_id`/
  `wacheId` as monitor-identifying fields, but confirmed against the
  WAIP-Web server source, `wache_nr` on a feedback event is the station
  number of the crew that submitted it, unrelated to the monitor/
  dispatch-center ID. Removed these three from the match candidates -
  alarms and routes were never affected (they don't carry these
  fields).

### 0.7.18 (2026-08-22)

- Fixed `debug.lastEvent`/`debug.normalizedPosition` to hold a
  single-element JSON array instead of a bare object (matching
  `einsatz.json.current`), for direct VIS table-widget compatibility,
  and to correctly initialize to `[]` instead of `null` on a fresh
  install/restart.
- Removed `einsatz.einsatznummer`/`.objekt`/`.objektteil`/
  `.besonderheiten`/`.strasse`/`.hausnummer`/`.einsatzdetails`/
  `.permissions` (and the corresponding fields in
  `einsatz.json.current`/`.history10`): confirmed via the WAIP-Web
  server source (`server/waip.js`,
  `db_user_check_permission_for_waip()`) that these fields are only
  ever populated for logged-in clients - since this adapter connects
  anonymously by design, they were always empty/`false`. Removed
  instead of permanently carrying dead states - see the note in the
  [`einsatz`](https://github.com/rnc11/ioBroker.waip-web#einsatz) section.

### 0.7.17 (2026-08-22)

- Fixed `cleanupObsoleteObjects()` incorrectly deleting and recreating
  the `einsatz.json` channel on every restart (it wasn't checking
  `obj.type`, so the current channel object was mistaken for a leftover
  state from before the 0.7.15 migration).
- Fixed a spurious `status.registrationPending` "no existing object"
  warning that could occur if the adapter was stopped before object
  initialization had finished.
- Reduced WAIP registration from three emits to a single emit - Socket.IO
  already delivers reliably once connected, and the existing registration
  timeout remains as the safety net for the rare case it doesn't confirm.
- `permissions` inside `einsatz.json.current`/`.history10` is now always
  stringified consistently with the standalone `einsatz.permissions`
  state, and `einsatz.json.current` is wrapped in a single-element array
  (VIS table widgets require an array at the root, not a bare object).
- Fixed `einsatz.json.history10`/`debug.monitorAudit` staying `null`
  instead of `[]` on a fresh install (they're excluded from the
  per-restart reset to preserve history, which previously also meant
  they were never initialized at all on first install).
- Added `registeredMonitor`/`registeredMonitorName` fields to
  `einsatz.json.current`/`.history10`.
- Reworked logging: translated all remaining German log text to
  English; implemented the official first-occurrence-`warn`/
  repeat-`debug`/recovery-`info` pattern for recurring failures (session
  cookie, registration, connection); capped noisy Socket.IO ping/pong
  debug logging; a sustained flood of wrong-monitor events now escalates
  to `warn` instead of staying at `info` indefinitely. See
  [LOGGING.md](https://github.com/rnc11/ioBroker.waip-web/blob/main/LOGGING.md) for the full reference.
- Documentation: added a table of contents, a practical-use-cases
  section, a known-limitation note (only the single most recently active
  incident is shown - see [`einsatz`](https://github.com/rnc11/ioBroker.waip-web#einsatz)), and enforced the
  changelog's own 5-entry limit.

### 0.7.16 (2026-08-22)

- Fixed two stale-data gaps around incident transitions:
  - When a new incident starts before its own routes/feedback events
    arrive, `einsatz.json.routen`/`.rueckmeldungen` and the feedback
    counters are now cleared immediately instead of waiting for those
    events.
  - Added a watchdog that automatically finalizes an incident
    (archives it, clears live fields) if its `ablaufzeit` is exceeded
    by more than 60s without a matching `io.standby` ever arriving -
    previously a missed `io.standby` (e.g. due to a disconnect at the
    wrong moment) could leave stale "active" data indefinitely.

### 0.7.15 (2026-08-22)

- Restructured `einsatz.json` into a channel with flat,
  table-widget-friendly sub-states (`current`/`history10`/`routen`/
  `rueckmeldungen`/`emAlarmiert`/`emWeitere`) - nested JSON wasn't
  rendering in VIS table widgets.
- Moved `tts.*` under `einsatz.tts.*` (removed the meaningless
  `tts.history10`); `tts.last` now resolves to a full absolute mp3 URL
  instead of the server's often-relative path.
- Moved `status.alarmAktiv`/`status.restzeit` to
  `einsatz.alarmAktiv`/`einsatz.restzeit`.
- Flattened `debug.normalizedPosition` and corrected
  `debug.lastError`'s role from `json` to `text`.
- All states are now actively reset to their empty value on every
  adapter start, except `einsatz.json.history10` and
  `debug.monitorAudit`, which persist across restarts.

### 0.7.14 (2026-08-22)

- Fixed **[E1032]**/**[E2004]**: trimmed `common.news` to the 7
  entries allowed by the repository builder and removed the orphaned
  `0.7.10` entry (never published to npm).
- Fixed **[W0066]**: pinned `@types/node` to `^22.0.0` (was `>=22`,
  resolving to a mismatched `26.x`).
- Fixed **[W4040]**/**[W4042]**: corrected the `.vscode/settings.json`
  JSON schema URLs for `io-package.json`/`jsonConfig` to the ones
  ioBroker actually expects.
- Fixed **[S8914]**: replaced the custom Dependabot auto-merge
  workflow with the canonical
  `iobroker-bot-orga/action-automerge-dependabot@v1` action and added
  the matching `.github/auto-merge.yml` (production: patch always,
  minor only for security fixes; development: minor allowed too).
- No runtime changes.

### 0.7.13 (2026-08-22)

- Addressed all remaining `ioBroker.repositories` checker suggestions:
  - **[S0065]**/**[S0085]**/**[S0087]**: added devDependencies
    `@types/node` and `@tsconfig/node22`, plus a `tsconfig.json` for
    editor tooling (no `checkJs`, so this doesn't introduce any new
    type-check warnings).
  - **[S4036]**: added `.vscode/settings.json` with JSON schemas for
    `io-package.json`/`admin/jsonConfig.json`.
  - **[S5026]**: added the `release-script-plugin-manual-review`
    plugin (adds a confirm-before-commit step to interactive
    `npm run release` runs only).
  - **[S8913]**: added a Dependabot auto-merge workflow for
    patch/minor updates; major version bumps still require manual
    review.
  - No runtime changes.

### 0.7.12 (2026-08-21)

- Fixed **[E3005]**: `einsatz.permissions` is declared as
  `common.type: "string"`, but `setField()` passed raw
  booleans/numbers through unchanged (the WAIP server sends this
  field as a raw boolean flag), so the stored `val` didn't match the
  declared type. `setField()` now looks up the declared type and
  always stringifies values for string-typed states, regardless of
  the incoming JS type - found by the `ioBroker.repositories` object
  structure check.

### 0.7.11 (2026-08-21)

- Fixed **[E3009]** (57 findings): added the missing channel/folder
  objects (`status`, `einsatz`, `einsatz.rueckmeldungAnzahl`, `debug`,
  `tts`) that ioBroker requires for every state path segment - found
  by the `ioBroker.repositories` object structure check.
- Fixed **[E3005]**/**[E1009]**: replaced the unsupported
  `common.type: "mixed"` on `einsatz.permissions` (now `string`) and
  `status.registrationAccepted` (now split into two booleans:
  `registrationAccepted` and the new `registrationPending`).

### 0.7.10 (2026-08-21)

- Fixed **[S9508]**: excluded `CHANGELOG_OLD.md` from the npm package
  (removed from `package.json`'s `files` allowlist) - ioBroker shows
  the README via a GitHub link, not from the installed npm package, so
  the file remains fully readable on GitHub without needing to ship
  inside the tarball.

### 0.7.9 (2026-08-21)

- Fixed **[E5025]**/**[E5036]**: installed the missing
  `@alcalzone/release-script-plugin-license` dev dependency required
  for the `"license"` plugin referenced in `.releaseconfig.json`.

### 0.7.8 (2026-08-21)

- Fixed **[E5018]**: added the missing `.releaseconfig.json` (`plugins:
  iobroker, license`) required now that `@alcalzone/release-script` is
  a dev dependency - caught by the `ioBroker.repositories` "ADD TO
  LATEST" submission check.

### 0.7.7 (2026-08-21)

- Fixed **[E254]**: removed the orphaned `0.7.5` entry from
  `common.news` - like `0.7.0` and `0.7.3` before it, that version was
  never actually tagged/published to npm (`0.7.4` was followed directly
  by `0.7.6`, which is now confirmed live under `latest`).

### 0.7.6 (2026-08-21)

- Fixed **[W6019]** and **[W0062]**: added `@alcalzone/release-script`
  and `@alcalzone/release-script-plugin-iobroker` as dev dependencies
  (with an `npm run release` script), and split this changelog - the 5
  most recent entries stay here, everything older moved to
  [CHANGELOG_OLD.md](CHANGELOG_OLD.md). Our existing manual
  version-bump/tag workflow (see below) is unchanged; the tool is
  available but not actively used for releasing yet.

### 0.7.5 (2026-08-21)

*(Also never tagged/published to npm - superseded directly by 0.7.6.)*

- Fixed **[E2004]**: removed the orphaned `0.7.3` entry from
  `common.news` in `io-package.json` - that version (see below) was
  never actually tagged/published to npm, `0.7.2` was followed directly
  by `0.7.4`. Confirmed via a bot recheck that every other finding from
  the last two rounds is now fixed.

### 0.7.4 (2026-08-21)

- Bumped the `ioBroker/testing-action-check` GitHub Action used by the
  `check-and-lint` CI job from `@v1` to `@v2` (via a
  [Dependabot](https://github.com/rnc11/ioBroker.waip-web/pull/10) PR -
  the first one filed by the `.github/dependabot.yml` added in 0.7.3).
  Purely additive on the action's side (adds an optional `test-command:
  'false'` flag), no behavior change for us.

### 0.7.3 (2026-08-21)

*(Never tagged/published to npm - superseded directly by 0.7.4; kept
here for a complete history of what was worked on.)*

- Addressed further findings from the official ioBroker Check and
  Service Bot (which re-scans the repository after every push):
  - Removed the deprecated `common.materialize` field from
    `io-package.json` (superseded by `common.adminUI.config`)
  - Raised `engines.node` to `>=22` and dropped Node.js 20 (reached
    End of Life on 2026-04-30) from the CI test matrix
  - Raised the `admin` dependency to `>=7.8.23`
  - Moved the `check-and-lint` CI job to Node 24.x
  - Added `.github/dependabot.yml` for automated dependency updates
    (weekly `npm`/`github-actions` checks)

### 0.7.2 (2026-08-21)

- README is now English-only (per the official ioBroker adapter checker,
  which flags mixed-language READMEs); the German version moved to a
  separate [README.de.md](README.de.md), linked near the top.
- Moved the License section to the very end of the file (was before the
  Changelog) - the checker requires License to be the last section.
- `package.json`: raised `engines.node` to `>=20` and `@iobroker/adapter-core`
  to `^3.4.1`.
- `io-package.json`: raised the `js-controller` dependency to `>=6.0.11`
  and the `admin` dependency to `>=7.6.17`; removed the `0.7.0` news
  entry (never published to npm, only `0.7.1` and later actually are).
- `admin/jsonConfig.json`: added the root `"i18n": true` attribute (now
  required since the fields resolve translations from `admin/i18n/*.json`)
  and explicit `xs`/`xl` grid sizes on all fields.
- `main.js`: `require('http')`/`require('https')`/`require('url')` now
  use the `node:` prefix for Node's built-in modules.
- `.gitignore`: added `.commitinfo`.
- Removed `.npmignore` - redundant with the `files` allowlist already
  used in `package.json`.
- CI: `adapter-tests` now explicitly declares `needs: check-and-lint`;
  raised the Node.js version used by the `check-and-lint` and `deploy`
  jobs.

### 0.7.1 (2026-08-21)

- Added a License badge to the README.

### 0.7.0 (2026-08-21)

- Prepared the admin UI for community translation via
  [ioBroker's Weblate](https://weblate.iobroker.net/engage/adapters/):
  added `@iobroker/adapter-dev` as a dev dependency (`npm run
  translate`), converted `admin/jsonConfig.json`'s `label`/`help` fields
  from inline `en`/`de` objects to plain English keys, and added
  `admin/i18n/{en,de,ru,pt,nl,fr,it,es,pl,uk,zh-cn}.json` (German
  curated manually, the rest auto-translated via the official
  `translate-adapter` tool — the same tool that already maintains the
  `io-package.json` translations). Added a "Translation status" badge to
  the README; like the "installed"/"stable" badges, it only shows real
  data once the adapter is actually registered as a component on
  weblate.iobroker.net (not done yet).

### 0.6.11 (2026-08-21)

- README: logo now shown enlarged (115×115) via a new
  `admin/waip-web-logo.png`, nearest-neighbor-scaled from the 32×32
  source icon for a crisp (if visibly pixelated) result instead of a
  blurry interpolated one — no higher-resolution source exists anywhere
  in the WAIP-Web ecosystem (checked the Lausitz instance and the
  upstream project, both use the same 32×32 favicon). The actual
  ioBroker adapter icon (`admin/waip-web.png`, referenced from
  `io-package.json`) is unchanged.
- Simplified the README title back to "ioBroker.waip-web".

### 0.6.10 (2026-08-21)

- Added the adapter logo and npm/installation badges (NPM version,
  downloads, installed, stable) to the README, matching standard
  ioBroker adapter conventions. The "installed"/"stable" badges won't
  show meaningful data until the adapter is listed in the official
  [ioBroker.repositories](https://github.com/ioBroker/ioBroker.repositories)
  ("latest" repository PR pending), but will populate automatically once
  it is.

### 0.6.9 (2026-08-21)

- Fixed adapter-checker finding **[E254]**: removed `common.news` entries
  for versions that were never actually published to npm (`0.6.1`–`0.6.5`,
  `0.6.7` were only version bumps in git/GitHub, without a matching
  tagged npm release). `common.news` now only lists versions that really
  exist on the npm registry (`0.6.6`, `0.6.8`); the full history remains
  in this changelog regardless of what was actually published.

### 0.6.8 (2026-08-21)

- Renamed the README title to "ioBroker-Adapter (ioBroker.waip-web)".
- This release doubles as the first end-to-end test of the automatic
  npm publish via Trusted Publishing introduced in 0.6.7.

### 0.6.7 (2026-08-21)

- Enabled automatic npm publishing: the `deploy` job in
  `.github/workflows/test-and-release.yml` is no longer commented out
  and now runs on every version tag (`vX.Y.Z`), publishing to npm via
  [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC,
  no `NPM_TOKEN` secret needed).

### 0.6.6 (2026-08-21)

- Added `.gitattributes` `eol=lf` so all contributors get consistent LF
  line endings regardless of their local git `autocrlf` setting
  (previously caused hundreds of spurious local lint errors on Windows
  without affecting CI, since CI checkouts weren't affected).
- Added `package-lock.json` and switched CI to the default `npm ci` with
  caching instead of `npm install` without caching, now that a lockfile
  exists.

### 0.6.5 (2026-08-21)

- Fixed all issues reported by the official [ioBroker adapter checker](https://adapter-check.iobroker.in/):
  - Bumped the required `js-controller` dependency to `>=5.0.19` and `@iobroker/adapter-core` to `^3.2.2`
  - Replaced the deprecated `common.license`/`common.title`/`common.main` fields with `common.licenseInformation`/`common.titleLang`; `common.main` is redundant with `package.json`'s `main` field
  - Added the required `common.tier` (`2` - external/cloud data source)
  - Added translations of `titleLang`, `desc` and the kept `common.news` entries into all 10 additional ioBroker admin languages (ru, pt, nl, fr, it, es, pl, uk, zh-cn)
  - Trimmed `common.news` to the 7 most recent entries, as recommended (the repository builder truncates there anyway); the full history stays in this changelog

### 0.6.4 (2026-08-21)

- New state `status.registeredMonitorName` shows the registered monitor
  as text without the ID (e.g. "Leitstelle: Lausitz"), resolved once at
  startup from the same `/waip/` overview page as the admin dropdown.
  `status.registeredMonitor` is unchanged and keeps showing the ID.

### 0.6.3 (2026-08-21)

- Admin UI: the Monitor ID field is now always full-width, placed on its
  own row below the WAIP server URL, so the (sometimes long) dropdown
  entries have enough room to display without being cramped.

### 0.6.2 (2026-08-21)

- Monitor dropdown entries are now sorted by numeric monitor ID instead
  of following the source page's (per-category) order.

### 0.6.1 (2026-08-21)

- Monitor dropdown entries now start with the actual monitor ID, e.g.
  "4 - Leitstelle: Lausitz", so the numeric ID stays visible even after
  a monitor has been selected.

### 0.6.0 (2026-08-21)

- **Admin UI:** Monitor ID is now a live dropdown (`selectSendTo`) instead
  of a plain text field. The adapter fetches the configured server's
  public `/waip/` overview page on demand and offers every monitor it
  finds there, grouped by Leitstelle/Kreis/Träger/Wache, with "Alle
  Wachalarme" (ID `0`) as an explicit first option. Manual entry remains
  available if the server can't be reached or uses a different page
  layout, so existing configurations keep working unchanged.
- Removed the static "session keepalive interval" info text from the
  admin UI (the behavior itself is unchanged).
- Added help text to the "Registration timeout" and "Reconnect delay"
  fields.

### 0.5.1 (2026-08-21)

- **Logging:** Reclassified log levels so `warn` becomes a reliable signal
  again. Session-cookie rotation, the known "Fehler beim Erneuern der
  Session" server message, and detected server restarts are now logged
  as `info` instead of `warn`, since they're part of this instance's
  normal, self-healing ~10-minute session cycle. Events discarded for a
  different monitor ID are now `info` (frequency remains tracked via
  `debug.ignoredCount`). Failures that only affect internal housekeeping
  (`debug.monitorAudit`, socket cleanup) are now `debug`. A duplicate
  `connect_error` log line (logged once at `warn`, once at `info`) was
  removed. Introduced `error` level for cases where an incident,
  feedback, route or TTS event genuinely failed to be processed (actual
  data loss), so these now stand out instead of being buried among
  routine `warn` noise.

### 0.5.0 (2026-08-20)

- **Behavior change:** On `io.standby`, all `einsatz.*` states (including
  `einsatz.json` and all counters) are now cleared instead of leaving the
  finished incident's data in place – matching the official frontend,
  which also clears keyword, location data etc. on standby.
  `status.alarmAktiv` is therefore now a reliable switch for whether
  `einsatz.*` currently holds real live data. The finished incident
  remains fully available via `einsatz.history10` (archived there first).

### 0.4.9 (2026-08-20)

- **CI fix:** Reverted a self-introduced, unnecessary line wrap in
  `connect()` (engine-packet preview) – `prettier/prettier` flagged it as
  superfluous; the line actually fits on one line within the configured
  print width.

### 0.4.8 (2026-08-20)

- **CI fix:** Fixed the final 16 lint errors – this time the complete,
  non-truncated error list including the exact desired replacement text
  was available, so every location could be corrected precisely 1:1
  (line wraps for overly long calls/objects, one `prefer-template`
  case). Lint should now be fully green.

### 0.4.7 (2026-08-20)

- **CI fix:** Fixed the remaining lint errors in `main.js` – consistently
  applied `curly` (braces even for single-line `if`/`for`),
  `no-unused-vars` for empty `catch` blocks (`catch (e) {}` → `catch {}`
  where `e` isn't used), and `arrowParens: avoid` (removed parentheses
  around single-parameter arrow functions). Purely mechanical code-style
  fixes, no behavior change.

### 0.4.6 (2026-08-20)

- **CI fix:** The `lint` step failed with hundreds of formatting errors
  (e.g. "Replace 'x' with "x""). Cause: `@iobroker/eslint-config`
  requires its own `prettier.config.mjs` in addition to
  `eslint.config.mjs`, re-exporting the ioBroker formatting style
  (single quotes, 4-space indentation, `trailingComma: 'all'`) – without
  it, Prettier fell back to its own defaults (double quotes). File added.

### 0.4.5 (2026-08-20)

- **CI fix:** The first pipeline run failed with "Dependencies lock file
  is not found". Cause: `actions/setup-node`'s built-in npm caching
  needs a `package-lock.json` for its cache key, independent of the
  install command used. Since none is committed to the repo yet,
  `package-cache: 'false'` is now set on both jobs.

### 0.4.4 (2026-08-20)

- Set up the CI pipeline (`.github/workflows/test-and-release.yml`),
  following the standard pattern of the official
  `@iobroker/create-adapter` template: a `check-and-lint` job (ESLint
  via `@iobroker/eslint-config`) and an `adapter-tests` matrix (Node
  20/22/24 × Ubuntu/Windows/macOS) via the central
  `testing-action-check`/`testing-action-adapter` actions. Added
  `test/package.js` and `test/integration.js` (`@iobroker/testing`)
  plus `eslint.config.mjs` for this; bumped `@iobroker/testing` to
  `^5.2.2`. Since no `package-lock.json` is committed yet, the pipeline
  uses `npm install` instead of `npm ci`.
- Raised `engines.node` in `package.json` to `>=18` (matching the tested
  Node versions and `@iobroker/testing` 5.x's requirements)
- A `deploy` job (automatic npm publishing) is prepared but commented
  out until npm Trusted Publishing is set up

### 0.4.3 (2026-08-20)

- **Bugfix:** `einsatz.id` and `einsatz.sondersignal` were declared as
  `string`, but the server actually sends them as numbers
  (`sondersignal`, per `client_waip.js`: `switch (data.sondersignal) {
  case 1: ... }`) – ioBroker therefore logged a type warning on every
  incident. Both states are now declared as `number`. Existing objects
  with the old (wrong) type are automatically recreated on the next
  adapter start (`migrateObjectTypes()`, generic for future type
  corrections).

### 0.4.2 (2026-08-20)

- Removed the "Session keepalive interval – upper bound" config field
  again: the official `/js/session_keepalive.js` on the site hard-codes
  this upper bound at 5 minutes and doesn't make it configurable. Having
  an admin field for it wrongly suggested a fixed interval, even though
  the actual renewal has long been fully automatic (see 0.4.1). The
  upper bound is now likewise fixed at 5 minutes.

### 0.4.1 (2026-08-20)

- **Robustness:** The session keepalive interval is now adaptive instead
  of a fixed assumption. WAIP-Web's source code (`server/app_cfg.js`)
  shows that the session cookie's lifetime is configurable per instance
  via an environment variable (server default: 60s instead of the
  previously assumed 10 minutes) – the adapter now derives the renewal
  interval from the expiry time actually reported by the server
  (matching `/js/session_keepalive.js` on the site: 80% of the observed
  lifetime, min. 55s, at most the configured upper bound). The "Session
  keepalive interval" config option is accordingly now an upper bound
  rather than a fixed interval.
- Corrected a comment about `io.version`/server restarts: per
  `server/auth.js`, WAIP-Web stores sessions persistently (SQLite), not
  in-memory – a restart therefore normally doesn't clear them. The
  proactive session refresh + reconnect on server restart remains as a
  general safeguard, only the previous justification was inaccurate.

### 0.4.0 (2026-08-20)

- **Restructured the object tree:** Feedback and routes are 1:n lists
  per incident and now live as nested JSON arrays inside one overall
  object `einsatz.json` (including `emAlarmiert[]`, `emWeitere[]`,
  `routen[]`, `rueckmeldungen[]`) instead of several loose states.
- `einsatz.history10` replaces `history.last10` – now with the **full**
  nested incident object per entry instead of just 6 reduced fields.
- New counters directly under `einsatz.*`: `routenGesamt`,
  `rueckmeldungGesamt`, `rueckmeldungAnzahl.{ek,gf,zf,vf,agt,fzf,ma,med}`
  (replaces `rueckmeldung.counts.*`).
- `einsatz.latitude`/`einsatz.longitude` replace
  `geo.latitude`/`geo.longitude` (position is additionally available in
  `einsatz.json.position`).
- New state `tts.history10` (last 10 TTS announcements).
- **Removed:** the entire `vis.*` channel, `json.raw`, `json.einsatz`,
  `geo.position`, `rueckmeldung.last.json`, `routen.json`,
  `routen.count`, `einsatz.emWeitere` (now part of `einsatz.json`).
- The adapter automatically removes all obsolete objects from the
  previous structure on its first start after the update
  (`cleanupObsoleteObjects()`).

### 0.3.4 (2026-08-20)

- All state names (`common.name`) consistently switched to German
  (previously a mix of English and German) – the adapter only makes
  sense for German-speaking users anyway

### 0.3.3 (2026-08-20)

- **Bugfix (potential data loss):** For a specific monitor ID (≠ `0`),
  events were silently discarded ("unknownMonitor") after the
  registration timeout elapsed, because real WAIP payloads, per
  `client_waip.js`, **never** contain a monitor-identifying field – that
  assignment happens entirely server-side via Socket.IO rooms. As a
  result, alarm delivery could stop completely after 10s even though
  the connection was technically up. `status.registrationAccepted`
  stayed permanently `false` for the same reason, even for the global
  monitor (`0`). Now any received event confirms the registration;
  events are only discarded if a payload explicitly names a different
  monitor ID.

### 0.3.2 (2026-08-20)

- Also switched the "Registration timeout" and "Reconnect delay" config
  fields from milliseconds to seconds (`registrationTimeout` →
  `registrationTimeoutSec`, default `10`; `reconnectDelay` →
  `reconnectDelaySec`, default `5`). Existing instances without a newly
  set value automatically use the defaults.

### 0.3.1 (2026-08-20)

- Switched the "Session keepalive interval" config field from
  milliseconds to seconds (`sessionKeepaliveInterval` →
  `sessionKeepaliveIntervalSec`, still defaulting to 5 min = `300`).
  Existing instances without a newly set value automatically use the
  default.

### 0.3.0 (2026-08-20)

- **Bugfix:** `wgs84_x`/`wgs84_y` were swapped (latitude/longitude). Per
  the official web frontend (`client_waip.js`), `wgs84_x = latitude,
  wgs84_y = longitude` – contrary to the usual GIS convention.
  `geo.latitude`/`geo.longitude` were therefore swapped for directly
  transmitted coordinates (not the GeoJSON fallback path).
- Added the missing `io.standby` handler: `status.alarmAktiv` was
  previously never reset when an incident ended
- Captured new incident fields (previously only contained in the raw
  `json.raw`/`json.einsatz`, now as their own states): `zeitstempel`,
  `einsatznummer`, `objekt`, `objektteil`, `strasse`, `hausnummer`,
  `einsatzdetails`, `besonderheiten`, `permissions`
- `em_alarmiert` (alerted resources) is now stored in
  `vis.fahrzeugTabelle`, `em_weitere` in `einsatz.emWeitere`
- Feedback is now collected per incident (`vis.rueckmeldungenTabelle`)
  and aggregated into counters per role/capability
  (`rueckmeldung.counts.*`), mirroring the live badges
  (EK/GF/ZF/VF/AGT/FZF/MA/MED) on the web UI
- New handlers for `io.error` (→ `debug.lastError`) and `io.version`
  (server-restart detection → session-cookie refresh + forced reconnect)
- Generalized `reconnectForRotatedSession()` into the more generic
  `forceReconnect(reason)` (now also used on a server version change)

### 0.2.1 (2026-08-20)

- Detected session-cookie rotation: if `/session/keepalive` returns a
  different cookie value than before (e.g. because the old session was
  already invalid server-side – a missed keepalive, a server restart
  with an in-memory session store), an existing Socket.IO connection is
  now actively rebuilt with the new session instead of waiting for a
  silent failure

### 0.2.0 (2026-08-20)

- Introduced session-cookie management: the adapter fetches and renews
  the WAIP server's `connect.sid` session cookie itself (`GET
  /session/keepalive`, matching `/js/session_keepalive.js` on the site)
  and attaches it to the Socket.IO connection. Fixes alarm delivery
  stopping after about 10 minutes without an active browser session.
- New state `debug.sessionExpires` and a new config option "Session
  keepalive interval (ms)" (default `300000`)

### 0.1.1 (2026-08-20)

- Adopted the favicon from `wachalarm.leitstelle-lausitz.de` as the
  adapter icon (`admin/waip-web.png`), replacing the previous
  placeholder
- Renamed the GitHub repository from `ioBroker.WAIP-Web` to
  `ioBroker.waip-web` (uppercase letters in the repo name prevented
  installation via `iobroker url` with `Process exited with code 25`);
  updated all URLs in `package.json`/`io-package.json` accordingly

### 0.1.0 (2026-08-20)

- Initial version: ported the original "WAIP Instrumented v3.9" ioBroker
  JavaScript-adapter script into a standalone adapter. The URL/monitor
  ID now come from the admin configuration instead of a runtime state.
