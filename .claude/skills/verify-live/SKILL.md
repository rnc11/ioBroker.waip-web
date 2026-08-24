---
name: verify-live
description: How to runtime-verify waip-web end-to-end against a real, live ioBroker instance and a real WAIP-Web dispatch server (install, connect, real incidents, generated files) - complementary to the mocked `verify` skill.
---

# Verifying ioBroker.waip-web against a real, live instance

This complements the `verify` skill (mocked adapter core + real socket.io, no external
state, seconds to run). Use *this* one when the user explicitly grants access to a real
running ioBroker installation and a real WAIP-Web server it dispatches from - useful
before/after a release, especially for things mock coverage can't fully validate: a real
npm install/uninstall cycle, real tile downloads from `tile.openstreetmap.org`, real
server-sent incident geometry, timing of real dispatch events.

## Credentials - never hardcode

The instance URL, Admin login, and SSH login are secrets the user provides per-session.
**Never write them into this file, into main.js, into a commit, or into any tracked
file** - this skill file itself is published to a public GitHub repo. Ask the user for
current values each time this skill is used; treat them as sensitive (don't echo them
back in chat, don't write them into scratch files that might get attached or sent
anywhere).

## Two access surfaces

1. **Admin Web UI, via Playwright MCP tools** (`mcp__playwright__browser_*`) - for
   everything that lives in the objects/states DB: install/uninstall/reconfigure the
   adapter instance, watch `waip-web.0.*` states populate from real events, read the
   adapter's own log tab.
   - `browser_snapshot()` on this page is often too large (big object trees, big
     dropdowns) and gets token-limited or truncated to a saved file - prefer
     `browser_find({text: "..."})` for one known field at a time over a full snapshot.
   - `browser_find`/snapshot refs are ephemeral; a ref from an older snapshot can
     silently resolve to the wrong element after the DOM changes (e.g. a dialog
     closing) - always take a fresh snapshot/find right before a click that matters.
     An accidental "Schließen" instead of "Installieren", and a stray "Funktionen
     definieren" dialog opening from a misdirected click, both happened this way.
   - `browser_find` on a state row only returns the **truncated preview text** the
     object-tree row shows; for full values, click the row's pencil ("Objekt
     bearbeiten") icon and read the "Zustand" tab's "Wert:" line.
   - To reconfigure the instance: Instanzen tab -> instance's "Einstellungen" (gear)
     button -> click through the `jsonConfig` tabs by name -> flip the field -> "Save
     and close". This restarts the adapter instance.
   - **Reconnect side-effect worth knowing**: a WAIP-Web server can re-push the
     *currently active* incident to a monitor as soon as it (re)connects - so after a
     config-changing restart, an incident already active before the change can get
     reprocessed under the *new* config without waiting for a fresh dispatch. Don't
     mistake this for a new event; correlate via `debug.rawPayloadShort`'s `id`/`uuid`
     staying the same. It's also a convenient way to re-trigger processing of the one
     active incident under a new config, instead of waiting for the next real one.

2. **SSH to the host, for anything outside the objects DB** - files written via
   `getAbsoluteInstanceDataDir()` (e.g. `einsatz.kartenbildPfad`'s PNGs under
   `iobroker-data/waip-web.0/maps/`) live on the real filesystem, not in ioBroker's
   object/file storage, so the Admin "Dateien" tab can't see them.
   - On Windows, if `ssh`/`scp` password auth is needed and `sshpass` isn't installed,
     use PuTTY's `plink.exe`/`pscp.exe` (commonly already on PATH or under
     `C:\Program Files\PuTTY\`) - both take `-pw <password>`, and `-batch` on `pscp`
     avoids interactive prompts. `plink` still prompts once for host-key caching on
     first use; pipe `echo y |` into it to auto-accept.
   - Pull the exact absolute path from the state's full value (see above) - don't
     guess the filename pattern. `pscp` it straight to the local scratchpad directory,
     then use `Read` to view the PNG/image directly (Claude Code renders images from a
     local path) instead of trying to view it inside the SSH session.

## Confirmed working (2026-08-24)

Fresh-installed `waip-web` from npm (`iobroker.waip-web@latest`) onto a real ioBroker
instance via the Admin UI's "Von NPM" install dialog, configured Monitor-ID `0` ("Alle
Wachalarme"), and within ~5 minutes a real incident arrived from the real WAIP-Web
dispatch server. All `einsatz.*` states populated correctly (`stichwort`, `beschreibung`
resolved via the keyword table, `einsatzart`, `ort`/`ortsteil`, `latitude`/`longitude`,
`zeitstempel`/`ablaufzeit`/`restzeit`, `sondersignal`, `uuid`/`id`). Then enabled
`mapImageEnabled` via Admin, which (per the reconnect side-effect above) reprocessed the
same active incident and populated `einsatz.kartenbildPfad`; pulling the PNG via
`pscp`/`plink` and viewing it confirmed a correctly stitched OSM tile map with the real
server-sent incident-area polygon (an "Einsatzumkreis" circle) drawn as an outline,
auto-zoomed to fit, with attribution text present - validating `fitZoomToPolygon()`,
`extractPolygonRings()`/`drawPolyline()`, and the tile-fetch/compose pipeline against
real `tile.openstreetmap.org` tiles and real server geometry, not just synthetic test
data.
