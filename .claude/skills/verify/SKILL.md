---
name: verify
description: How to runtime-verify a change to the waip-web ioBroker adapter (main.js) end-to-end, without a real js-controller or a real WAIP-Web server.
---

# Verifying ioBroker.waip-web at runtime

This adapter has no CLI/GUI/HTTP surface of its own. It's a background
service (`main.js`, `class WaipWeb extends utils.Adapter`) that connects
**out** as a `socket.io-client` to a WAIP-Web dispatch server's `/waip`
namespace, receives events (`io.new_waip`, `io.new_rmld`, `io.routes`,
`io.playtts`, `io.standby`), and writes ioBroker states in response. The
real surface to drive is **that socket connection**.

Don't `import` functions from `main.js` and call them directly - that
skips the actual startup path (`onReady()` builds `this.stichwortMapping`,
`this.rdLabels`, etc. from config) and the actual event-dispatch chain
(`socket.on('io.new_waip', wrapHandlerWithMonitorCheck(handleAlarm))`).
Both of those are exactly where past bugs lived.

## Recipe: real adapter class + real socket, mocked ioBroker core

No real `js-controller` needed (that path exists via `@iobroker/testing`'s
`tests.integration`/`TestHarness`, but requires a real js-controller
npm install into a temp dir and takes minutes - only worth it for a
change to `io-package.json`'s object structure itself). Instead:

1. **Mock only the ioBroker core**, not the adapter class or the network:
   `@iobroker/testing`'s `mockAdapterCore()` + `MockDatabase` give an
   in-memory objects/states store and a constructor-compatible `Adapter`
   base class (`class WaipWeb extends utils.Adapter` works unmodified
   against it - confirmed in `mockAdapterCore.js`: "This needs to be a
   class with the correct `this` context").
2. Monkeypatch `require.cache[require.resolve('@iobroker/adapter-core')]`
   to point at the mock **before** `require('./main.js')` (delete any
   stale cache entry for `main.js` first). `main.js` exports
   `options => new WaipWeb(options)` when required as a module.
3. Start a **real local `socket.io` server** (the server package, not
   `socket.io-client` which is the adapter's own dependency - install it
   temporarily: `npm install socket.io --no-save`, and
   `npm uninstall socket.io --no-save` again afterwards; confirm
   `git status` is clean before and after). Namespace `/waip`, path
   `/socket.io`. Point the adapter's `config.url` at
   `http://127.0.0.1:<port>`.
4. Registration: the adapter emits `'WAIP', monitorId` on connect but
   **does not wait for a server ack** to start processing events -
   `wrapHandlerWithMonitorCheck` only rejects a payload that *explicitly*
   names a different monitor ID (see `payloadMonitorMatch()` in
   `main.js`). A minimal mock server that just emits `io.new_waip` after
   accepting the connection is enough.
5. `refreshSessionCookie()` and `refreshMonitorName()` (both called from
   `onReady()`) fail silently (`try/catch`, `.catch(() => {})`) if the
   mock server 404s their HTTP endpoints - **no need to implement
   `/session/keepalive`** or the `/waip/` overview page.
6. **Gotcha**: `createAdapterMock` does not implement `this.setTimeout` /
   `clearTimeout` / `setInterval` / `clearInterval` (the real
   `@iobroker/adapter-core` provides lifecycle-bound wrappers around the
   native timer functions) - `onReady()` calls `startSessionKeepalive()`
   which needs these. Patch them onto the instance right after
   construction:
   ```js
   adapterInstance.setTimeout = (fn, ms, ...a) => setTimeout(fn, ms, ...a);
   adapterInstance.clearTimeout = t => clearTimeout(t);
   adapterInstance.setInterval = (fn, ms, ...a) => setInterval(fn, ms, ...a);
   adapterInstance.clearInterval = t => clearInterval(t);
   ```
7. Call `await adapterInstance.readyHandler()` (the mock stores
   `this.on('ready', fn)` as `.readyHandler`, doesn't auto-fire it) - this
   runs the REAL `onReady()`, including `cleanupObsoleteObjects()` /
   `migrateObjectTypes()` / `initObjects()` / `resetAllStates()` (all
   harmless against the empty mock DB) and finally `this.connect()`,
   which opens the real socket.io-client connection to the mock server.
8. Emit `io.new_waip` payloads from the mock server
   (`namespace.on('connection', socket => socket.emit('io.new_waip', {...}))`).
   A minimal payload (`{ stichwort, uuid }`) is enough to reach
   `lookupStichwortBeschreibung()`; `handleAlarm()` tolerates missing
   fields via `normalizeData(incoming || {})`.
9. **Ordering multiple alarms**: don't poll `einsatz.beschreibung` for a
   value *change* to detect that alarm N landed - consecutive alarms can
   legitimately resolve to the identical description text. Instead poll
   `waip-web.0.debug.rawPayloadShort` (written unconditionally as the
   very first line of `handleAlarm()`) for the alarm's `uuid`, then read
   `waip-web.0.einsatz.beschreibung` right after.
10. **Run location matters**: the driver script must live *inside* the
    repo (or be run with the repo as the resolution root) so
    `require('socket.io')` / `require('@iobroker/testing')` resolve via
    the repo's `node_modules`. A script in an external tmp dir fails
    with `MODULE_NOT_FOUND` even with `cwd` set there - Node resolves
    `require()` relative to the requiring *file's* location, not `cwd`.
    Copy the script into the repo root temporarily, run it, delete it
    (`git status` should show nothing extra before committing).

## States worth checking

- `waip-web.0.einsatz.beschreibung` - the result of
  `lookupStichwortBeschreibung()` / `decodeRettungsdienstStichwort()`.
- `waip-web.0.debug.rawPayloadShort` - raw incoming payload preview, use
  it to correlate which alarm produced which result (see point 9).

## Confirmed working (2026-08-24)

Verified the 0.7.22-0.7.27 keyword-table/decoder changes this way:
`H:VU-mit-P` and `h:vu-MIT-p` both resolved to the `H:VU mit P` row's
description (hyphen/case normalization), `R1N1 p` resolved via the
R-scheme decoder (space-separated modifier, the 0.7.23 regex fix), and
`H:VU ohne P` correctly resolved to its own distinct row (no false
collision with `H:VU mit P`) - all through a real socket.io network
connection into a real running adapter instance.
