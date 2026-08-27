'use strict';

/*
 * DE: ioBroker.WAIP-Web
 *
 * Verbindet sich mit einem WAIP-Wachalarm-Monitor (Socket.IO) und bildet
 * Einsätze, Rückmeldungen, Routen und TTS-Ansagen als ioBroker-States ab.
 *
 * Portiert aus dem ursprünglichen "WAIP Instrumented" ioBroker-JavaScript-
 * Adapter-Script in einen eigenständigen Adapter: URL/Monitor-ID kommen
 * jetzt aus der Admin-Konfiguration statt aus einem Laufzeit-State.
 *
 * Objektstruktur (Stand 0.7.15): einsatz.json ist ein eigener Channel mit
 * ausschließlich flachen JSON-States, da VIS-Tabellen-Widgets keine
 * verschachtelten Strukturen darstellen können. einsatz.json.current /
 * .history10 enthalten nur den flachen Einsatzstamm (dieselben Felder wie
 * die einzelnen einsatz.*-States, nur als ein JSON-Objekt bzw. -Array
 * gebündelt); Routen/Rückmeldungen/Alarmierungen liegen als eigene, ebenfalls
 * flache Arrays in einsatz.json.routen/.rueckmeldungen/.emAlarmiert/
 * .emWeitere - nur für den jeweils aktuellen Einsatz, nicht historisiert.
 * Ergänzt um schnell bindbare Zähler (einsatz.routenGesamt,
 * einsatz.rueckmeldungenGesamt, einsatz.rueckmeldungen.*). Der frühere
 * vis.*-Kanal entfällt komplett.
 *
 * EN: ioBroker.WAIP-Web
 *
 * Connects to a WAIP dispatch monitor (Socket.IO) and mirrors incidents,
 * responder feedback, routes and TTS announcements into ioBroker states.
 *
 * Ported from the original "WAIP Instrumented" ioBroker-JavaScript-Adapter
 * script into a standalone adapter: URL/monitor ID now come from the admin
 * configuration instead of a runtime state.
 *
 * Object structure (as of 0.7.15): einsatz.json is its own channel with
 * exclusively flat JSON states, since VIS table widgets can't render
 * nested structures. einsatz.json.current/.history10 hold only the flat
 * incident core (the same fields as the individual einsatz.* states,
 * just bundled as one JSON object/array); routes/feedback/alerted
 * resources live as their own, likewise flat arrays in
 * einsatz.json.routen/.rueckmeldungen/.emAlarmiert/.emWeitere - only for
 * the currently running incident, not historized. Complemented by
 * quick-to-bind counters (einsatz.routenGesamt, einsatz.rueckmeldungenGesamt,
 * einsatz.rueckmeldungen.*). The former vis.* channel is gone entirely.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');
const path = require('node:path');
const fsPromises = require('node:fs/promises');
const utils = require('@iobroker/adapter-core');
const { io } = require('socket.io-client');
const { Jimp, loadFont } = require('jimp');
const jimpFonts = require('jimp/fonts');

const DEFAULT_URL = 'https://wachalarm.leitstelle-lausitz.de';
// DE: Obergrenze, wie /js/session_keepalive.js der Seite selbst
// EN: Upper bound, matching /js/session_keepalive.js of the site itself
const DEFAULT_SESSION_KEEPALIVE_SEC = 300;
// DE: Untergrenze fürs Keepalive-Intervall, analog zur Klammerung in /js/session_keepalive.js
// (min(max(maxAge*0.8, 55s), Obergrenze)). Die tatsächliche Cookie-Laufzeit ist je
// WAIP-Web-Instanz per ENV konfigurierbar (Server-Default lt. server/app_cfg.js: 60s!) -
// deshalb wird das Intervall unten adaptiv aus der vom Server gemeldeten Ablaufzeit
// berechnet, statt einen festen Wert anzunehmen.
// EN: Lower bound for the keepalive interval, matching the clamping in
// /js/session_keepalive.js (min(max(maxAge*0.8, 55s), upper bound)). The actual cookie
// lifetime is configurable per WAIP-Web instance via an env var (server default per
// server/app_cfg.js: 60s!) - so the interval below is derived adaptively from the
// expiry time the server reports, instead of assuming a fixed value.
const SESSION_KEEPALIVE_MIN_MS = 55 * 1000;
const HISTORY_SIZE = 10;
// DE: Obergrenze für debug.monitorAudit (siehe appendMonitorAudit()). Der State überlebt
// Neustarts (RESET_EXCLUDED_STATE_IDS), muss also selbst begrenzt werden.
// EN: Upper bound for debug.monitorAudit (see appendMonitorAudit()). The state survives
// restarts (RESET_EXCLUDED_STATE_IDS), so it has to cap itself.
const MONITOR_AUDIT_SIZE = 200;
// DE: Default-Beschriftungen für decodeRettungsdienstStichwort() - in der Admin-UI unter dem
// "Automatically decode rescue-service keywords"-Häkchen als Textfelder überschreibbar, da der
// Adapter mehrsprachig ist und die Bezeichnungen daher nicht fest im Code stehen dürfen.
// EN: Default labels for decodeRettungsdienstStichwort() - overridable as text fields in
// the admin UI under the "Automatically decode rescue-service keywords" checkbox, since
// the adapter is multi-language and these labels must therefore not be hardcoded.
const DEFAULT_RD_LABEL_R = 'Rettungswagen';
const DEFAULT_RD_LABEL_N = 'Notfalleinsatzfahrzeug';
const DEFAULT_RD_LABEL_P = 'Polytrauma';
const DEFAULT_RD_LABEL_F = 'First Responder';
const DEFAULT_RD_LABEL_NT = 'Notfalltransport mit Notfallkrankenwagen';
// DE: einsatznummer/objekt/objektteil/besonderheiten/strasse/hausnummer/einsatzdetails/
// permissions wurden mit 0.7.18 entfernt: server/waip.js von WAIP-Web befüllt diese Felder
// serverseitig nur für eingeloggte Clients (db_user_check_permission_for_waip) - da dieser
// Adapter sich bewusst ohne Login verbindet (siehe "Über diesen Adapter"), waren sie immer
// leer bzw. permissions immer false. Siehe OBSOLETE_OBJECT_IDS für die zugehörige Migration.
// EN: einsatznummer/objekt/objektteil/besonderheiten/strasse/hausnummer/einsatzdetails/
// permissions were removed in 0.7.18: WAIP-Web's server/waip.js only populates these
// fields server-side for logged-in clients (db_user_check_permission_for_waip) - since
// this adapter connects without a login by design (see "About this adapter"), they were
// always empty/permissions always false. See OBSOLETE_OBJECT_IDS for the migration.
const ALLOWED_EINSATZ_FIELDS = [
    'id',
    'uuid',
    'einsatzart',
    'stichwort',
    'ort',
    'ortsteil',
    'ablaufzeit',
    'sondersignal',
    // DE: Das vom Server als "zeitstempel" gesendete Feld (laut client_waip.js, dem
    // offiziellen Frontend, zusätzlich vorhanden) landet als einsatz.alarmierungszeit -
    // bewusst NICHT hier, sondern wie beschreibung als Sonderfall in handleAlarm()
    // behandelt, da der State-Name vom Server-Feldnamen abweicht.
    // EN: The field the server sends as "zeitstempel" (per client_waip.js, the official
    // frontend, an additional field) ends up as einsatz.alarmierungszeit - deliberately
    // NOT listed here, but handled as a special case in handleAlarm() like beschreibung,
    // since the state name differs from the server's field name.
];
// DE: Rückmeldungs-Zähler sind seit 0.7.35 in zwei Unter-Kanäle unter einsatz.rueckmeldungen
// gruppiert - "rollen" (aus rmld_role abgeleitet) und "funktionen" (aus den
// rmld_capability_*-Flags abgeleitet), siehe updateRueckmeldungCounts(). Vorher lagen alle
// acht Zähler flach direkt unter einsatz.rueckmeldungAnzahl (0.7.35: einsatz.rueckmeldungAnzahl.
// rollen/.funktionen; der Kanal selbst hieß erst ab 0.7.36 einsatz.rueckmeldungen).
// EN: Feedback counters have been grouped into two sub-channels under einsatz.rueckmeldungen
// since 0.7.35 - "rollen" (derived from rmld_role) and "funktionen" (derived from the
// rmld_capability_* flags), see updateRueckmeldungCounts(). Previously all eight counters
// lived flat directly under einsatz.rueckmeldungAnzahl (0.7.35: einsatz.rueckmeldungAnzahl.
// rollen/.funktionen; the channel itself was only renamed to einsatz.rueckmeldungen in 0.7.36).
const RUECKMELDUNG_ROLLEN_KEYS = ['ek', 'gf', 'zf', 'vf'];
const RUECKMELDUNG_FUNKTIONEN_KEYS = ['agt', 'fzf', 'ma', 'med'];
// DE: identische Disconnect-Logs 60s lang unterdrücken
// EN: suppress identical disconnect logs for 60s
const DISCONNECT_DEDUPE_MS = 60000;
const WARN_DEDUPE_MS = 5000;
// DE: Obergrenze für die Anzahl unterschiedlicher Nachrichten, die safeLog() gleichzeitig für
// die Dedupe vorhält - verhindert unbegrenztes Wachstum über eine lange Laufzeit, falls
// viele verschiedene (z.B. dynamische) Fehlermeldungen auftreten. Wird der Cache voll,
// wird er komplett geleert (führt höchstens zu vereinzelt nicht deduplizierten Meldungen,
// unkritisch - die Dedupe ist eine Rausch-Reduzierung, keine Korrektheitsanforderung).
// EN: Upper bound for the number of distinct messages safeLog() keeps for deduplication
// at once - prevents unbounded growth over a long runtime if many different (e.g.
// dynamic) error messages occur. Once the cache is full it's cleared entirely (at worst
// causes a few not-deduplicated messages, uncritical - deduplication is noise reduction,
// not a correctness requirement).
const WARN_DEDUPE_CACHE_MAX = 200;
// DE: Für die Eskalation wiederholter "Event für anderen Monitor"-Meldungen (siehe
// wrapHandlerWithMonitorCheck/checkWrongMonitorRate) - Hinweis auf eine falsch
// konfigurierte Monitor-ID, statt dauerhaft nur auf info zu bleiben.
// EN: For escalating repeated "event for a different monitor" messages (see
// wrapHandlerWithMonitorCheck/checkWrongMonitorRate) - a hint at a misconfigured
// monitor ID, instead of staying at info level indefinitely.
const WRONG_MONITOR_WARN_THRESHOLD = 20;
const WRONG_MONITOR_WARN_WINDOW_MS = 5 * 60 * 1000;
// DE: Toleranz nach Ablauf von einsatz.ablaufzeit, bevor der Watchdog in restzeitInterval ein
// verpasstes io.standby annimmt und den Einsatz automatisch abschließt (siehe dort).
// EN: Grace period after einsatz.ablaufzeit has passed, before the watchdog in
// restzeitInterval assumes a missed io.standby and finalizes the incident (see there).
const MISSED_STANDBY_GRACE_MS = 60000;

// DE: Konstanten für das Einsatzkarten-Feature (siehe buildEinsatzMapImage()/
// generateEinsatzMapImage()) - Kachelgröße/max. Zoom liegen am offiziellen OSM-Tile-Server
// (tile.openstreetmap.org) fest, sind also keine Konfigurationswerte. Der User-Agent
// identifiziert den Adapter gegenüber dem Server (siehe OSM Tile Usage Policy: Anfragen
// ohne aussagekräftigen User-Agent können ohne Vorwarnung geblockt werden).
// EN: Constants for the incident-map feature (see buildEinsatzMapImage()/
// generateEinsatzMapImage()) - tile size/max zoom are fixed by the official OSM tile
// server (tile.openstreetmap.org), so they aren't configuration values. The user agent
// identifies the adapter to the server (see the OSM Tile Usage Policy: requests without
// a meaningful user agent can be blocked without warning).
const OSM_TILE_SIZE = 256;
const OSM_MAX_ZOOM = 19;
// DE: Untergrenze für das automatische Herauszoomen in fitZoomToPolygon() - ein großzügiger
// Boden (statt 0), der ein pathologisch riesiges Einsatzgebiet-Polygon davon abhält, das
// Kartenbild auf einen fast bedeutungslosen Weltmaßstab herauszuzoomen.
// EN: Lower bound for the automatic zoom-out in fitZoomToPolygon() - a generous floor
// (instead of 0) that keeps a pathologically huge incident-area polygon from zooming the
// map image out to an almost meaningless world-scale view.
const OSM_MIN_AUTO_ZOOM = 3;
const OSM_TILE_USER_AGENT = 'ioBroker.waip-web (+https://github.com/rnc11/ioBroker.waip-web)';
const DEFAULT_MAP_IMAGE_WIDTH = 600;
const DEFAULT_MAP_IMAGE_HEIGHT = 400;
const DEFAULT_MAP_IMAGE_ZOOM = 19;
const DEFAULT_MAP_IMAGE_OUTLINE_COLOR = '#dd2020';
const DEFAULT_MAP_IMAGE_OUTLINE_THICKNESS = 4;
const MAP_IMAGE_OUTLINE_THICKNESS_MIN = 1;
const MAP_IMAGE_OUTLINE_THICKNESS_MAX = 12;
// DE: Wie viele erzeugte Kartenbilder maximal aufgehoben werden - ältere werden nach jeder
// neuen Erzeugung gelöscht, siehe pruneMapImages().
// EN: How many generated map images are kept at most - older ones are deleted after every
// new one is created, see pruneMapImages().
const MAP_IMAGE_RETENTION_COUNT = 10;
// DE: Wie lange handleAlarm() höchstens auf die Fertigstellung des Kartenbilds wartet, bevor
// er mit leerem einsatz.kartenbildPfad weitermacht - siehe generateEinsatzMapImage().
// EN: How long handleAlarm() waits at most for the map image to finish before continuing
// with an empty einsatz.kartenbildPfad - see generateEinsatzMapImage().
const DEFAULT_MAP_IMAGE_TIMEOUT_SECONDS = 10;
const MAP_IMAGE_TIMEOUT_SECONDS_MIN = 1;
const MAP_IMAGE_TIMEOUT_SECONDS_MAX = 60;

/* DE: Für die dynamische Monitor-Auswahl im Admin (siehe fetchMonitorList/onMessage):
   Die /waip/-Übersichtsseite einer WAIP-Web-Instanz gliedert die verfügbaren
   Monitore typischerweise in diese vier Überschriften. Nicht jede Instanz nutzt
   zwingend exakt diese Gliederung - findet fetchMonitorList() keine davon, wird
   die komplette Seite als eine einzige, unkategorisierte Liste geparst.
   EN: For the dynamic monitor selection in the admin UI (see fetchMonitorList/
   onMessage): a WAIP-Web instance's /waip/ overview page typically groups the
   available monitors under these four headings. Not every instance necessarily
   uses exactly this grouping - if fetchMonitorList() finds none of them, the
   whole page is parsed as a single, uncategorized list. */
const MONITOR_CATEGORY_HEADINGS = [
    { key: 'leitstelle', re: /Alarmmonitor\s+Leitstelle/i },
    { key: 'kreis', re: /Alarmmonitor\s+Kreis/i },
    { key: 'traeger', re: /Alarmmonitor\s+Tr(?:&auml;|ä)ger/i },
    { key: 'wache', re: /Alarmmonitor\s+Wache/i },
];
const MONITOR_CATEGORY_LABELS = { leitstelle: 'Leitstelle', kreis: 'Kreis', traeger: 'Träger', wache: 'Wache' };

// DE: State-Objekte, die beim Start aus früheren Versionen entfernt werden (Struktur-Migration).
// EN: State objects removed at startup that are left over from earlier versions (structural migration).
const OBSOLETE_OBJECT_IDS = [
    'json.raw',
    'json.einsatz',
    'vis.fahrzeugTabelle',
    'vis.einsatzTabelle',
    'vis.rueckmeldungenTabelle',
    'geo.latitude',
    'geo.longitude',
    'geo.position',
    'history.last10',
    'einsatz.emWeitere',
    // DE: Umstrukturierung in 0.7.15: einsatz.json/einsatz.history10 wechseln von State zu
    // Channel (einsatz.json.current/.history10/.routen/.rueckmeldungen/.emAlarmiert/
    // .emWeitere) - ein Objekt kann nicht gleichzeitig State und Channel sein, die alten
    // States müssen daher vor initObjects() entfernt werden.
    // EN: Restructuring in 0.7.15: einsatz.json/einsatz.history10 change from state to
    // channel (einsatz.json.current/.history10/.routen/.rueckmeldungen/.emAlarmiert/
    // .emWeitere) - an object can't be both a state and a channel at once, so the old
    // states must be removed before initObjects() runs.
    'einsatz.json',
    'einsatz.history10',
    // DE: Umstrukturierung in 0.7.15: Kanal tts zieht komplett unter einsatz um
    // (einsatz.tts.last/.lastTimestamp), da er sich auf den aktuellen Einsatz bezieht.
    // tts.history10 entfällt ersatzlos (keine sinnvolle Historie ohne Einsatzbezug).
    // EN: Restructuring in 0.7.15: the tts channel moves entirely under einsatz
    // (einsatz.tts.last/.lastTimestamp), since it relates to the current incident.
    // tts.history10 is dropped without replacement (no meaningful history without an incident).
    'tts.last',
    'tts.lastTimestamp',
    'tts.history10',
    'tts',
    // DE: Umstrukturierung in 0.7.15: status.alarmAktiv/status.restzeit ziehen unter einsatz
    // um (einsatz.alarmAktiv/.restzeit), da sie sich auf den aktuellen Einsatz beziehen.
    // EN: Restructuring in 0.7.15: status.alarmAktiv/status.restzeit move under einsatz
    // (einsatz.alarmAktiv/.restzeit), since they relate to the current incident.
    'status.alarmAktiv',
    'status.restzeit',
    'rueckmeldung.last.json',
    'rueckmeldung.counts.ek',
    'rueckmeldung.counts.gf',
    'rueckmeldung.counts.zf',
    'rueckmeldung.counts.vf',
    'rueckmeldung.counts.agt',
    'rueckmeldung.counts.fzf',
    'rueckmeldung.counts.ma',
    'rueckmeldung.counts.med',
    'rueckmeldung.counts.gesamt',
    'routen.json',
    'routen.count',
    // DE: Umstrukturierung in 0.7.18: diese Felder werden von WAIP-Web serverseitig ohnehin nur
    // befüllt, wenn der verbindende Client eingeloggt ist (siehe db_user_check_permission_for_waip
    // in server/waip.js) - da dieser Adapter sich bewusst ohne Login verbindet, waren sie immer
    // leer bzw. permissions immer false. Ersatzlos entfernt statt dauerhaft leere States zu führen.
    // EN: Restructuring in 0.7.18: WAIP-Web's server only ever populates these fields
    // server-side when the connecting client is logged in (see
    // db_user_check_permission_for_waip in server/waip.js) - since this adapter connects
    // without a login by design, they were always empty/permissions always false. Removed
    // without replacement instead of permanently carrying empty states.
    'einsatz.einsatznummer',
    'einsatz.objekt',
    'einsatz.objektteil',
    'einsatz.besonderheiten',
    'einsatz.strasse',
    'einsatz.hausnummer',
    'einsatz.einsatzdetails',
    'einsatz.permissions',
    // DE: Umstrukturierung in 0.7.35: die acht Rückmeldungs-Zähler ziehen von direkt unter
    // einsatz.rueckmeldungAnzahl in die neuen Unter-Kanäle .rollen/.funktionen um (siehe
    // CHANNEL_DEFS/STATE_DEFS) - die alten flachen State-Blätter müssen daher vor
    // initObjects() entfernt werden, sonst blieben sie als verwaiste States neben den neuen
    // verschachtelten Pfaden bestehen.
    // EN: Restructuring in 0.7.35: the eight feedback counters move from directly under
    // einsatz.rueckmeldungAnzahl into the new .rollen/.funktionen sub-channels (see
    // CHANNEL_DEFS/STATE_DEFS) - the old flat state leaves must therefore be removed before
    // initObjects() runs, otherwise they'd linger as orphaned states alongside the new
    // nested paths.
    'einsatz.rueckmeldungAnzahl.ek',
    'einsatz.rueckmeldungAnzahl.gf',
    'einsatz.rueckmeldungAnzahl.zf',
    'einsatz.rueckmeldungAnzahl.vf',
    'einsatz.rueckmeldungAnzahl.agt',
    'einsatz.rueckmeldungAnzahl.fzf',
    'einsatz.rueckmeldungAnzahl.ma',
    'einsatz.rueckmeldungAnzahl.med',
    // DE: Umstrukturierung in 0.7.36: der Kanal einsatz.rueckmeldungAnzahl (inkl. seiner in
    // 0.7.35 eingeführten Unter-Kanäle .rollen/.funktionen) heißt jetzt einsatz.rueckmeldungen,
    // einsatz.rueckmeldungGesamt heißt jetzt einsatz.rueckmeldungenGesamt und einsatz.zeitstempel
    // heißt jetzt einsatz.alarmierungszeit. Die acht State-Blätter aus 0.7.35
    // (einsatz.rueckmeldungAnzahl.rollen.*/.funktionen.*) sind hier gelistet, damit sie beim
    // Update von 0.7.35 entfernt werden; die dann leeren alten Ordner selbst werden von
    // OBSOLETE_FOLDER_IDS unten erfasst (cleanupObsoleteObjects() löscht hier oben bewusst nur
    // States, nie Channel/Folder, siehe dort).
    // EN: Restructuring in 0.7.36: the einsatz.rueckmeldungAnzahl channel (including its
    // .rollen/.funktionen sub-channels introduced in 0.7.35) is now einsatz.rueckmeldungen,
    // einsatz.rueckmeldungGesamt is now einsatz.rueckmeldungenGesamt, and einsatz.zeitstempel is
    // now einsatz.alarmierungszeit. The eight 0.7.35 state leaves
    // (einsatz.rueckmeldungAnzahl.rollen.*/.funktionen.*) are listed here so they get removed
    // when upgrading from 0.7.35; the then-empty old folders themselves are covered by
    // OBSOLETE_FOLDER_IDS below (cleanupObsoleteObjects() deliberately only ever deletes states
    // here, never channels/folders, see there).
    'einsatz.rueckmeldungAnzahl.rollen.ek',
    'einsatz.rueckmeldungAnzahl.rollen.gf',
    'einsatz.rueckmeldungAnzahl.rollen.zf',
    'einsatz.rueckmeldungAnzahl.rollen.vf',
    'einsatz.rueckmeldungAnzahl.funktionen.agt',
    'einsatz.rueckmeldungAnzahl.funktionen.fzf',
    'einsatz.rueckmeldungAnzahl.funktionen.ma',
    'einsatz.rueckmeldungAnzahl.funktionen.med',
    'einsatz.rueckmeldungGesamt',
    'einsatz.zeitstempel',
];

// DE: Wie OBSOLETE_OBJECT_IDS, aber für Channel-/Folder-Objekte, die bei einer Umbenennung
// übrig bleiben würden: cleanupObsoleteObjects() löscht dort bewusst nur obj.type === 'state',
// nie Channel/Folder, um ein absichtlich zum Channel gewordenes State-Blatt nicht versehentlich
// zu löschen (siehe einsatz.json in 0.7.15). Diese Sorge gilt für die hier gelisteten IDs nicht,
// da der jeweilige Pfad komplett aufgegeben wurde - STATE_DEFS/CHANNEL_DEFS definieren dort
// nichts mehr, es kann also nie wieder legitim ein Objekt an dieser ID entstehen. Werden daher
// unabhängig vom aktuellen obj.type gelöscht. Reihenfolge: Kind-Ordner vor Eltern-Ordner.
// EN: Like OBSOLETE_OBJECT_IDS, but for channel/folder objects that would otherwise linger
// after a rename: cleanupObsoleteObjects() deliberately only ever deletes obj.type === 'state'
// there, never channels/folders, to avoid accidentally deleting a leaf that deliberately became
// a channel (see einsatz.json in 0.7.15). That concern doesn't apply to the IDs listed here,
// since the path itself has been abandoned entirely - STATE_DEFS/CHANNEL_DEFS no longer define
// anything there, so a legitimate object can never reappear at this ID again. Deleted regardless
// of their current obj.type. Order: child folders before the parent folder.
const OBSOLETE_FOLDER_IDS = [
    'einsatz.rueckmeldungAnzahl.rollen',
    'einsatz.rueckmeldungAnzahl.funktionen',
    'einsatz.rueckmeldungAnzahl',
];

// DE: Übergeordnete Channel/Folder-Objekte, die für jeden State-Zweig existieren müssen.
// ioBroker verlangt ein eigenes Objekt für jedes Segment eines State-Pfads - reine
// State-Blätter (siehe STATE_DEFS) reichen dafür nicht aus.
// EN: Parent channel/folder objects that must exist for every state branch. ioBroker
// requires its own object for every segment of a state path - plain state leaves
// (see STATE_DEFS) alone aren't enough.
const CHANNEL_DEFS = [
    { id: 'status', type: 'channel', name: 'Verbindungs- und Registrierungsstatus' },
    { id: 'einsatz', type: 'channel', name: 'Aktueller Einsatz' },
    { id: 'einsatz.rueckmeldungen', type: 'folder', name: 'Rückmeldungen nach Rolle/Funktion' },
    { id: 'einsatz.rueckmeldungen.rollen', type: 'folder', name: 'Rückmeldungen nach Rolle' },
    { id: 'einsatz.rueckmeldungen.funktionen', type: 'folder', name: 'Rückmeldungen nach Funktion' },
    { id: 'einsatz.json', type: 'folder', name: 'Einsatzdaten als flache JSON-Objekte/Arrays für Tabellen-Widgets' },
    { id: 'einsatz.tts', type: 'folder', name: 'TTS-Ansage des aktuellen Einsatzes' },
    { id: 'debug', type: 'channel', name: 'Diagnose- und Debug-Informationen' },
];

// DE: Definition aller States, die beim Start sichergestellt werden.
// EN: Definition of all states ensured to exist at startup.
const STATE_DEFS = [
    {
        id: 'status.connected',
        type: 'boolean',
        role: 'indicator.reachable',
        name: 'Verbunden mit WAIP-Server',
        def: false,
    },
    { id: 'status.registeredMonitor', type: 'string', role: 'text', name: 'Aktuell registrierte Monitor-ID' },
    {
        id: 'status.registeredMonitorName',
        type: 'string',
        role: 'text',
        name: 'Aktuell registrierter Monitor (Text, ohne ID)',
    },
    {
        id: 'status.registrationAccepted',
        type: 'boolean',
        role: 'indicator',
        name: 'Registrierung bestätigt',
        def: false,
    },
    {
        id: 'status.registrationPending',
        type: 'boolean',
        role: 'indicator',
        name: 'Registrierung angefragt, Antwort vom Server steht noch aus',
        def: false,
    },
    { id: 'debug.lastEvent', type: 'string', role: 'json', name: 'Letztes empfangenes Socket-Event' },
    { id: 'debug.normalizedPosition', type: 'string', role: 'json', name: 'Letzte normalisierte Position' },
    { id: 'debug.rawPayloadShort', type: 'string', role: 'text', name: 'Rohdaten-Vorschau (500 Zeichen)' },
    {
        id: 'debug.ignoredCount',
        type: 'number',
        role: 'value',
        name: 'Anzahl ignorierter Events (explizit falsches Monitor-Feld im Payload)',
        def: 0,
    },
    { id: 'debug.monitorAudit', type: 'string', role: 'json', name: 'Monitor-Audit-Log (letzte 200 Einträge)' },
    { id: 'debug.sessionExpires', type: 'string', role: 'date', name: 'Session-Cookie gültig bis (letzte Erneuerung)' },
    { id: 'debug.lastError', type: 'string', role: 'text', name: 'Letzte Server-Fehlermeldung (io.error)' },
    {
        id: 'debug.serverVersion',
        type: 'string',
        role: 'text',
        name: 'Zuletzt gemeldete Server-Version/Instanz-ID (io.version)',
    },
    // DE: flache Felder des aktuellen Einsatzes
    // EN: flat fields of the current incident
    { id: 'einsatz.alarmAktiv', type: 'boolean', role: 'indicator.alarm', name: 'Alarm aktiv', def: false },
    {
        id: 'einsatz.restzeit',
        type: 'number',
        role: 'value.interval',
        name: 'Restzeit bis Einsatzende',
        unit: 's',
        def: 0,
    },
    { id: 'einsatz.id', type: 'number', role: 'value', name: 'Einsatz ID' },
    { id: 'einsatz.uuid', type: 'string', role: 'text', name: 'Einsatz UUID' },
    { id: 'einsatz.einsatzart', type: 'string', role: 'text', name: 'Einsatzart' },
    { id: 'einsatz.stichwort', type: 'string', role: 'text', name: 'Alarmstichwort' },
    {
        id: 'einsatz.beschreibung',
        type: 'string',
        role: 'text',
        name: 'Beschreibung zum Stichwort (Stammdaten-Zuordnung/automatische Dekodierung, null falls kein Treffer)',
    },
    { id: 'einsatz.ort', type: 'string', role: 'text', name: 'Ort' },
    { id: 'einsatz.ortsteil', type: 'string', role: 'text', name: 'Ortsteil' },
    { id: 'einsatz.alarmierungszeit', type: 'string', role: 'date', name: 'Alarmierungszeit' },
    { id: 'einsatz.ablaufzeit', type: 'string', role: 'date', name: 'Ablaufzeit' },
    { id: 'einsatz.sondersignal', type: 'number', role: 'value', name: 'Sondersignal', def: 0 },
    { id: 'einsatz.latitude', type: 'number', role: 'value.gps.latitude', name: 'Breitengrad' },
    { id: 'einsatz.longitude', type: 'number', role: 'value.gps.longitude', name: 'Längengrad' },
    {
        id: 'einsatz.kartenbildPfad',
        type: 'string',
        role: 'text',
        name: 'Pfad zur zuletzt erzeugten Einsatzkarte (PNG) - leer, falls das Kartenbild-Feature deaktiviert ist, keine Koordinaten vorliegen oder die Erzeugung fehlschlug',
    },
    // DE: Flache JSON-Objekte/Arrays für Tabellen-Widgets (siehe einsatz.json.*-Channel).
    // Jedes dieser States ist entweder ein flaches Objekt oder ein Array flacher Objekte -
    // bewusst ohne weitere Verschachtelung, da VIS-Tabellen-Widgets nur eine Ebene abflachen
    // können (siehe Diskussion zu den ursprünglich verschachtelten einsatz.json/history10).
    // EN: Flat JSON objects/arrays for table widgets (see the einsatz.json.* channel).
    // Each of these states is either a flat object or an array of flat objects -
    // deliberately without further nesting, since VIS table widgets can only flatten one
    // level (see the discussion of the originally nested einsatz.json/history10).
    {
        id: 'einsatz.json.current',
        type: 'string',
        role: 'json',
        name: 'Einsatzstamm des aktuellen Einsatzes (JSON-Array mit einem Element, leer falls kein Einsatz aktiv)',
    },
    {
        id: 'einsatz.json.history10',
        type: 'string',
        role: 'json',
        name: `Einsatzstamm der letzten ${HISTORY_SIZE} abgeschlossenen Einsätze, gleiches Schema wie einsatz.json.current (JSON-Array)`,
    },
    {
        id: 'einsatz.json.routen',
        type: 'string',
        role: 'json',
        name: 'Routen des aktuellen Einsatzes, flaches Array (JSON)',
    },
    {
        id: 'einsatz.json.rueckmeldungen',
        type: 'string',
        role: 'json',
        name: 'Rückmeldungen des aktuellen Einsatzes, flaches Array (JSON)',
    },
    {
        id: 'einsatz.json.emAlarmiert',
        type: 'string',
        role: 'json',
        name: 'Alarmierte Einsatzmittel des aktuellen Einsatzes, flaches Array (JSON)',
    },
    {
        id: 'einsatz.json.emWeitere',
        type: 'string',
        role: 'json',
        name: 'Weitere Einsatzmittel des aktuellen Einsatzes, flaches Array (JSON)',
    },
    // DE: abgeleitete Zähler
    // EN: derived counters
    { id: 'einsatz.routenGesamt', type: 'number', role: 'value', name: 'Anzahl Routen im aktuellen Einsatz', def: 0 },
    {
        id: 'einsatz.rueckmeldungenGesamt',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen gesamt im aktuellen Einsatz',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.rollen.ek',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Einsatzkräfte',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.rollen.gf',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Gruppenführer',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.rollen.zf',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Zugführer',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.rollen.vf',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Verbandsführer',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.funktionen.agt',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Atemschutzgeräteträger',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.funktionen.fzf',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Fahrzeugführer',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.funktionen.ma',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Maschinisten',
        def: 0,
    },
    {
        id: 'einsatz.rueckmeldungen.funktionen.med',
        type: 'number',
        role: 'value',
        name: 'Rückmeldungen: Medizinisch/Sanitäter',
        def: 0,
    },
    // DE: TTS des aktuellen Einsatzes (Kanal liegt unter einsatz, siehe CHANNEL_DEFS)
    // EN: TTS announcement of the current incident (channel lives under einsatz, see CHANNEL_DEFS)
    {
        id: 'einsatz.tts.last',
        type: 'string',
        role: 'text.url',
        name: 'Vollständige URL der letzten TTS-Ansage (mp3)',
    },
    { id: 'einsatz.tts.lastTimestamp', type: 'string', role: 'date', name: 'Zeitstempel letzte TTS-Ansage' },
];
// DE: Schneller Zugriff von setField() auf den deklarierten Typ eines States (siehe dort).
// EN: Fast lookup for setField() of a state's declared type (see there).
const STATE_DEF_BY_ID = new Map(STATE_DEFS.map(def => [def.id, def]));

// DE: IDs, deren "string"-Wert tatsächlich ein JSON-*Array* enthält - liefert den korrekten
// Leerwert "[]" für resetAllStates() (alle anderen "string"-States werden auf null
// gesetzt). einsatz.json.current, debug.lastEvent und debug.normalizedPosition sind
// trotz eines inhaltlich einzelnen Objekts ebenfalls Arrays (mit maximal einem Element)
// - VIS-Tabellen-Widgets erwarten am Root immer ein Array, siehe persistEinsatzSnapshot()
// bzw. die entsprechenden setState()-Aufrufe in handleAlarm()/connect(). einsatz.json.history10
// und debug.monitorAudit stehen ebenfalls hier, obwohl sie nicht bei jedem Neustart
// zurückgesetzt werden (siehe RESET_EXCLUDED_STATE_IDS) - resetAllStates() braucht den
// korrekten Leerwert trotzdem, um sie bei einer frischen Installation zu initialisieren.
// EN: IDs whose "string" value actually holds a JSON *array* - this yields the correct
// empty value "[]" for resetAllStates() (every other "string" state is reset to null).
// einsatz.json.current, debug.lastEvent and debug.normalizedPosition are arrays too
// (with at most one element) despite conceptually holding a single object - VIS table
// widgets always expect an array at the root, see persistEinsatzSnapshot() and the
// corresponding setState() calls in handleAlarm()/connect(). einsatz.json.history10 and
// debug.monitorAudit are listed here too even though they aren't reset on every restart
// (see RESET_EXCLUDED_STATE_IDS) - resetAllStates() still needs the correct empty value
// to initialize them on a fresh install.
const JSON_ARRAY_STATE_IDS = new Set([
    'einsatz.json.current',
    'einsatz.json.routen',
    'einsatz.json.rueckmeldungen',
    'einsatz.json.emAlarmiert',
    'einsatz.json.emWeitere',
    'einsatz.json.history10',
    'debug.monitorAudit',
    'debug.lastEvent',
    'debug.normalizedPosition',
]);

// DE: "number"-States, bei denen 0 ein irreführender "leerer" Wert wäre (Einsatz-ID,
// Koordinaten - 0/0 wäre eine reale, aber falsche Position) - resetAllStates() setzt
// diese auf null statt 0 zurück.
// EN: "number" states where 0 would be a misleading "empty" value (incident ID,
// coordinates - 0/0 would be a real but wrong position) - resetAllStates() resets
// these to null instead of 0.
const NULLABLE_NUMBER_STATE_IDS = new Set(['einsatz.id', 'einsatz.latitude', 'einsatz.longitude']);

// DE: States, die resetAllStates() bei einem *bestehenden* Wert bewusst NICHT bei jedem
// Adapter-Start überschreibt - die Historie der letzten Einsätze (einsatz.json.history10)
// und das Verbindungs-/Registrierungs-Audit-Log (debug.monitorAudit) sollen über
// Neustarts hinweg erhalten bleiben. Existiert noch KEIN Wert (frische Installation),
// werden sie trotzdem einmalig initialisiert - siehe initStateIfMissing().
// EN: States that resetAllStates() deliberately does NOT overwrite on every adapter
// start if a value already exists - the history of the last incidents
// (einsatz.json.history10) and the connection/registration audit log
// (debug.monitorAudit) are meant to survive restarts. If NO value exists yet (fresh
// install), they're still initialized once - see initStateIfMissing().
const RESET_EXCLUDED_STATE_IDS = new Set(['einsatz.json.history10', 'debug.monitorAudit']);

/* DE: Prüft ob eine monitorID gültig ist (nicht-leer).
   EN: Checks whether a monitorID is valid (non-empty). */
function isValidMonitor(mon) {
    if (mon === undefined || mon === null) {
        return false;
    }
    return String(mon).trim() !== '';
}

/*
 DE: Robust: akzeptiert Geometry-Objekt oder JSON-String, Feature oder Geometry,
 und handhabt Fälle, in denen geometry.geometry als String kodiert ist.
 Gibt null zurück, wenn keine valide Position gefunden oder 0/0 ermittelt wurde.

 EN: Robust: accepts a geometry object or JSON string, Feature or Geometry, and
 handles cases where geometry.geometry is encoded as a string.
 Returns null if no valid position was found or 0/0 was determined.
*/
/* DE: Entpackt ein Geometry-Feld in ein rohes {type, coordinates}-Objekt: akzeptiert ein
   Geometry-Objekt, einen JSON-String davon, ein GeoJSON-Feature (geometry-Property) oder
   eine verschachtelte Kodierung, bei der geometry.geometry selbst wieder als String vorliegt.
   Gemeinsam genutzt von getCenterFromGeometry() (Mittelpunkt fürs Positions-Feld) und
   extractPolygonRings() (Umriss fürs Kartenbild, siehe buildEinsatzMapImage()).
   EN: Unwraps a geometry field into a raw {type, coordinates} object: accepts a geometry
   object, a JSON string of one, a GeoJSON Feature (geometry property), or a nested
   encoding where geometry.geometry is itself a string. Shared by getCenterFromGeometry()
   (centroid for the position field) and extractPolygonRings() (outline for the map image,
   see buildEinsatzMapImage()). */
function unwrapGeometryObject(g) {
    if (!g) {
        return null;
    }
    let parsed = g;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            /* DE: als String belassen / EN: leave as string */
        }
    }
    const geomCandidate = parsed?.geometry ?? parsed;
    let geom = geomCandidate;
    if (!geom) {
        return null;
    }
    if (typeof geom === 'string') {
        try {
            geom = JSON.parse(geom);
        } catch {
            /* DE: nicht parsbar / EN: cannot parse */
        }
    }
    if (!geom || !geom.type || !geom.coordinates) {
        return null;
    }
    return geom;
}

/* DE: Extrahiert aus einem Geometry-Feld die Außenringe aller Polygone als Arrays von
   [lon, lat]-Punkten - für die Darstellung des vom WAIP-Server gesendeten Einsatzgebiets
   (i.d.R. ein kreisförmiges Polygon) im Kartenbild, statt nur eines Mittelpunkt-Markers
   (siehe buildEinsatzMapImage()). Löcher (innere Ringe) werden ignoriert, ebenso Punkt-/
   Linien-Geometrien (kein Polygon zum Zeichnen vorhanden) - der Aufrufer fällt in diesem
   Fall auf den Punkt-Marker zurück. Jeder Ring braucht mindestens 3 Punkte, um gezeichnet
   zu werden.
   EN: Extracts the outer rings of all polygons from a geometry field as arrays of
   [lon, lat] points - for drawing the incident area WAIP-Web sends (usually a
   circle-shaped polygon) onto the map image, instead of just a center-point marker (see
   buildEinsatzMapImage()). Holes (inner rings) are ignored, as are point/line geometries
   (no polygon to draw) - the caller falls back to the point marker in that case. Each ring
   needs at least 3 points to be drawn. */
function extractPolygonRings(g) {
    const geom = unwrapGeometryObject(g);
    if (!geom) {
        return [];
    }
    const toRing = ring => {
        if (!Array.isArray(ring)) {
            return null;
        }
        const pts = [];
        for (const p of ring) {
            if (!Array.isArray(p) || p.length < 2) {
                continue;
            }
            const lon = Number(p[0]);
            const lat = Number(p[1]);
            if (!isNaN(lon) && !isNaN(lat)) {
                pts.push([lon, lat]);
            }
        }
        return pts.length >= 3 ? pts : null;
    };

    const rings = [];
    if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates[0]) {
        const ring = toRing(geom.coordinates[0]);
        if (ring) {
            rings.push(ring);
        }
    } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
        for (const poly of geom.coordinates) {
            const ring = Array.isArray(poly) && poly[0] ? toRing(poly[0]) : null;
            if (ring) {
                rings.push(ring);
            }
        }
    }
    return rings;
}

function getCenterFromGeometry(g) {
    try {
        const geom = unwrapGeometryObject(g);
        if (!geom) {
            return null;
        }

        const coords = geom.coordinates;
        const collectPoints = (c, type) => {
            const pts = [];
            const pushIfPoint = p => {
                if (!Array.isArray(p) || p.length < 2) {
                    return;
                }
                const lon = Number(p[0]);
                const lat = Number(p[1]);
                if (!isNaN(lat) && !isNaN(lon)) {
                    pts.push([lon, lat]);
                }
            };

            if (type === 'Point') {
                pushIfPoint(c);
            } else if (type === 'LineString' || type === 'MultiPoint') {
                for (const p of c) {
                    pushIfPoint(p);
                }
            } else if (type === 'Polygon') {
                for (const ring of c) {
                    for (const p of ring) {
                        pushIfPoint(p);
                    }
                }
            } else if (type === 'MultiPolygon') {
                for (const poly of c) {
                    for (const ring of poly) {
                        for (const p of ring) {
                            pushIfPoint(p);
                        }
                    }
                }
            } else {
                const flat = Array.isArray(c) ? c.flat(Infinity) : [];
                for (let i = 0; i + 1 < flat.length; i += 2) {
                    const a = Number(flat[i]);
                    const b = Number(flat[i + 1]);
                    if (!isNaN(a) && !isNaN(b)) {
                        pts.push([a, b]);
                    }
                }
            }
            return pts;
        };

        const points = collectPoints(coords, geom.type);
        if (!points || !points.length) {
            return null;
        }

        let minLon = points[0][0];
        let maxLon = points[0][0];
        let minLat = points[0][1];
        let maxLat = points[0][1];
        for (const p of points) {
            if (!Array.isArray(p) || p.length < 2) {
                continue;
            }
            minLon = Math.min(minLon, p[0]);
            maxLon = Math.max(maxLon, p[0]);
            minLat = Math.min(minLat, p[1]);
            maxLat = Math.max(maxLat, p[1]);
        }
        const lat = Number(((minLat + maxLat) / 2).toFixed(6));
        const lon = Number(((minLon + maxLon) / 2).toFixed(6));
        if (lat === 0 && lon === 0) {
            return null;
        }
        return { lat, lon };
    } catch {
        return null;
    }
}

/*
 DE: Normalisiert Payload:
 - priorisiert wgs84_x/wgs84_y (wenn nicht 0/0),
 - akzeptiert data.position falls nicht 0/0,
 - fällt auf geometry (auch stringified) zurück.
 - entfernt roh-geo Felder und setzt position nur, wenn valide.

 EN: Normalizes the payload:
 - prioritizes wgs84_x/wgs84_y (if not 0/0),
 - accepts data.position if not 0/0,
 - falls back to geometry (also if stringified).
 - removes raw geo fields and only sets position if valid.
*/
function normalizeData(obj) {
    try {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }
        const data = JSON.parse(JSON.stringify(obj)); // DE: Deep Clone / EN: deep clone
        let center = null;

        if (data.wgs84_x !== undefined && data.wgs84_y !== undefined) {
            // DE: WAIP-Server-Konvention (bestätigt über client_waip.js des offiziellen
            // Frontends: "const lat = data.wgs84_x; const lng = data.wgs84_y;"):
            // wgs84_x = Breitengrad, wgs84_y = Längengrad - NICHT die übliche
            // GIS-Konvention (x=Länge/y=Breite). Absichtlich so übernommen.
            // EN: WAIP server convention (confirmed via client_waip.js of the official
            // frontend: "const lat = data.wgs84_x; const lng = data.wgs84_y;"):
            // wgs84_x = latitude, wgs84_y = longitude - NOT the usual GIS convention
            // (x=longitude/y=latitude). Deliberately adopted as-is.
            const lat = Number(data.wgs84_x);
            const lon = Number(data.wgs84_y);
            if (!isNaN(lat) && !isNaN(lon) && !(lat === 0 && lon === 0)) {
                center = { lat, lon };
            }
        }

        if (!center && data.position && data.position.lat !== undefined && data.position.lon !== undefined) {
            const latP = Number(data.position.lat);
            const lonP = Number(data.position.lon);
            if (!isNaN(latP) && !isNaN(lonP) && !(latP === 0 && lonP === 0)) {
                center = { lat: latP, lon: lonP };
            }
        }

        if (!center && data.geometry) {
            const c = getCenterFromGeometry(data.geometry);
            if (c) {
                center = c;
            }
        }

        delete data.geometry;
        delete data.wgs84_x;
        delete data.wgs84_y;
        delete data.geojson;
        delete data.geometry_type;

        if (center) {
            data.position = { lat: center.lat, lon: center.lon };
        } else {
            delete data.position;
        }

        return data;
    } catch {
        return obj;
    }
}

/* DE: Dekodiert die auf der /waip/-Übersichtsseite vorkommenden HTML-Entities (teils
   benannt wie &auml;, teils numerisch) und normalisiert Whitespace. Für die dynamische
   Monitor-Auswahl im Admin (siehe fetchMonitorList).
   EN: Decodes the HTML entities found on the /waip/ overview page (some named like
   &auml;, some numeric) and normalizes whitespace. For the dynamic monitor selection
   in the admin UI (see fetchMonitorList). */
function decodeHtmlEntities(str) {
    if (!str) {
        return str;
    }
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        auml: 'ä',
        ouml: 'ö',
        uuml: 'ü',
        Auml: 'Ä',
        Ouml: 'Ö',
        Uuml: 'Ü',
        szlig: 'ß',
    };
    return str
        .replace(/&(amp|lt|gt|quot|apos|nbsp|auml|ouml|uuml|Auml|Ouml|Uuml|szlig);/g, m => named[m.slice(1, -1)])
        .replace(/&#(\d+);/g, m => String.fromCodePoint(Number(m.slice(2, -1))))
        .replace(/&#x([0-9a-fA-F]+);/gi, m => String.fromCodePoint(parseInt(m.slice(3, -1), 16)))
        .replace(/\s+/g, ' ')
        .trim();
}

/* DE: Normalisiert ein Stichwort/Muster für den Abgleich in lookupStichwortBeschreibung():
   lowercase, getrimmt, und jede Folge aus Leerzeichen und/oder Bindestrichen wird zu genau
   einem Leerzeichen zusammengefasst. Dadurch werden Leitstellen-Schreibvarianten wie
   "H:VU mit P", "H:VU-mit-P" und "H:VU - mit - P" als identisch behandelt, ohne dass für
   jede Variante eine eigene Tabellenzeile gepflegt werden muss. Wird sowohl beim Aufbau von
   this.stichwortMapping (auf das Tabellen-Muster) als auch bei jedem Lookup (auf das
   eingehende Stichwort) angewendet, damit beide Seiten konsistent normalisiert sind.
   EN: Normalizes a keyword/pattern for the comparison in lookupStichwortBeschreibung():
   lowercase, trimmed, and any run of spaces and/or hyphens is collapsed to a single space.
   This makes dispatch-center spelling variants like "H:VU mit P", "H:VU-mit-P" and
   "H:VU - mit - P" compare as identical, without needing a separate table row per variant.
   Applied both when building this.stichwortMapping (to the table pattern) and on every
   lookup (to the incoming keyword), so both sides are normalized consistently. */
function normalizeStichwortForMatch(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, ' ')
        .trim();
}

// DE: Erkennt anhand von einsatz.einsatzart, ob ein Einsatz ein Rettungsdienst-Einsatz ist
// (Server sendet z.B. "Rettungseinsatz"/"Krankentransport" vs. "Brandeinsatz"/
// "Hilfeleistungseinsatz", siehe README). Substring-/Regex-Vergleich statt exakter Werteliste,
// da die genaue Formulierung je Leitstelle variieren kann (z.B. "Rettungsdiensteinsatz").
// Grundlage für die Checkbox "Rettungsdienst-Einsätze verarbeiten" (rdAlarmierungEnabled).
// EN: Detects from einsatz.einsatzart whether an incident is a rescue-service incident
// (server sends e.g. "Rettungseinsatz"/"Krankentransport" vs. "Brandeinsatz"/
// "Hilfeleistungseinsatz", see README). Substring/regex match instead of an exact value
// list, since the exact wording can vary by dispatch center (e.g. "Rettungsdiensteinsatz").
// Basis for the "Process rescue-service incidents" checkbox (rdAlarmierungEnabled).
const RD_EINSATZART_RE = /rettung|krankentransport/i;
function isRettungsdienstEinsatz(einsatzart) {
    return typeof einsatzart === 'string' && RD_EINSATZART_RE.test(einsatzart);
}

// DE: Klemmt einen Konfigurationswert auf [min, max] und fällt bei fehlendem/ungültigem Wert
// auf def zurück - für mapImageWidth/-Height/-Zoom (siehe onReady()).
// EN: Clamps a configuration value to [min, max], falling back to def for a missing/invalid
// value - for mapImageWidth/-Height/-Zoom (see onReady()).
function clampNumber(value, min, max, def) {
    // DE: Leere Werte VOR der Number()-Konvertierung abfangen: Number(null), Number('') und
    // Number('   ') ergeben jeweils 0, was Number.isFinite() passiert - der Wert würde dann
    // auf min geklemmt statt auf den Default zu fallen. Ein im Admin geleertes Feld ergäbe
    // so z.B. Zoom 1 (Weltkarte) statt des konfigurierten Defaults 19, oder 100px
    // Bildbreite statt 600px.
    // EN: Catch empty values BEFORE the Number() conversion: Number(null), Number('') and
    // Number('   ') each yield 0, which passes Number.isFinite() - the value would then be
    // clamped to min instead of falling back to the default. A field cleared in the admin
    // UI would thus give e.g. zoom 1 (whole world map) instead of the configured default
    // 19, or 100px image width instead of 600px.
    if (value === null || value === undefined || String(value).trim() === '') {
        return def;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return def;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

// DE: Wandelt eine "#RRGGBB"-Farbe (z.B. aus dem "color"-Feldtyp der Admin-UI,
// mapImageOutlineColor) in Jimps 0xRRGGBBAA-Integer-Format um (volldeckend, Alpha fest 0xff -
// siehe buildEinsatzMapImage()). Fällt bei fehlendem/ungültigem Wert (z.B. leerer String, "#"
// fehlt, falsche Länge) auf defaultHex zurück, statt einen kaputten Wert an Jimp
// durchzureichen.
// EN: Converts a "#RRGGBB" color (e.g. from the admin UI's "color" field type,
// mapImageOutlineColor) into Jimp's 0xRRGGBBAA integer format (fully opaque, alpha fixed at
// 0xff - see buildEinsatzMapImage()). Falls back to defaultHex on a missing/invalid value
// (e.g. empty string, missing "#", wrong length) instead of passing a broken value to Jimp.
function hexColorToJimpInt(hex, defaultHex) {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    const rgb = match ? match[1] : /^#?([0-9a-fA-F]{6})$/.exec(defaultHex)[1];
    // DE: Bewusst *256 + 0xff statt Bitshift (<<8 | 0xff) - Werte ab 0x80000000 (z.B. Weiß,
    // 0xffffff -> 0xffffff00) würden von JS' Bitoperatoren als 32-bit SIGNED Integer
    // interpretiert und dadurch negativ/falsch. Plain Arithmetik bleibt eine korrekte
    // (positive) Zahl, JS-Zahlen können Ganzzahlen bis 2^53 verlustfrei darstellen.
    // EN: Deliberately *256 + 0xff instead of a bit shift (<<8 | 0xff) - values from
    // 0x80000000 up (e.g. white, 0xffffff -> 0xffffff00) would be interpreted by JS's
    // bitwise operators as a 32-bit SIGNED integer and come out negative/wrong. Plain
    // arithmetic stays a correct (positive) number - JS numbers represent integers up to
    // 2^53 exactly.
    return parseInt(rgb, 16) * 256 + 0xff;
}

/* DE: Rechnet eine Position (WGS84 lon/lat) bei einem gegebenen Zoom-Level in eine
   Pixelkoordinate im globalen "Slippy Map"-Pixelraum um (Web-Mercator, Standardformel
   des OSM-Wikis "Slippy map tilenames" - jede Kachel ist OSM_TILE_SIZE px groß, bei Zoom z
   gibt es 2^z Kacheln pro Achse). Dient buildEinsatzMapImage() dazu, den exakten
   Bildausschnitt (nicht nur kachelgenau) um die Einsatz-Koordinaten zu bestimmen.
   EN: Converts a position (WGS84 lon/lat) at a given zoom level into a pixel coordinate
   in the global "slippy map" pixel space (Web Mercator, the standard formula from the OSM
   wiki's "Slippy map tilenames" - each tile is OSM_TILE_SIZE px, and at zoom z there are
   2^z tiles per axis). Used by buildEinsatzMapImage() to determine the exact image
   crop (not just tile-aligned) around the incident's coordinates. */
function lonLatToGlobalPixel(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * n * OSM_TILE_SIZE;
    const latRad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * OSM_TILE_SIZE;
    return { x, y };
}

/* DE: Lädt eine einzelne Kachel von tile.openstreetmap.org. tileX wird auf [0, 2^z) gewrappt
   (Längengrad-Wrap um die Datumsgrenze), tileY dagegen NICHT vom Aufrufer geprüft - siehe
   den y<0/y>=n-Check in buildEinsatzMapImage() (es gibt keine Kacheln für Breitengrade
   jenseits von ca. ±85° in der Web-Mercator-Projektion).
   EN: Downloads a single tile from tile.openstreetmap.org. tileX is wrapped into
   [0, 2^z) (longitude wraps around the date line); tileY is NOT checked by this
   function - see the y<0/y>=n check in buildEinsatzMapImage() (there are no tiles for
   latitudes beyond roughly ±85° in the Web Mercator projection). */
function fetchOsmTile(zoom, tileX, tileY) {
    const n = Math.pow(2, zoom);
    const wrappedX = ((tileX % n) + n) % n;
    const url = `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`;
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': OSM_TILE_USER_AGENT } }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`tile ${zoom}/${wrappedX}/${tileY} -> HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

/* DE: Ermittelt für ein Einsatzgebiet-Polygon (ein oder mehrere Ringe aus [lon, lat]-Punkten,
   siehe extractPolygonRings()) den größtmöglichen Zoom-Level, bei dem dessen komplette
   Bounding-Box noch (mit Rand) in ein width×height-Bild passt - höchstens maxZoom (der
   konfigurierte Zoom), es wird also NIE über die Konfiguration hinaus hineingezoomt, nur bei
   Bedarf herausgezoomt. So bleibt das Einsatzgebiet garantiert vollständig im Bildausschnitt
   sichtbar, statt am Rand abgeschnitten zu werden. Bricht bei OSM_MIN_AUTO_ZOOM ab, falls
   selbst dort nichts passt (z.B. ein unrealistisch riesiges Polygon) - der Aufrufer zeichnet
   den Umriss dann trotzdem, er kann in diesem Extremfall über den Bildrand hinausragen.
   EN: Determines, for an incident-area polygon (one or more rings of [lon, lat] points, see
   extractPolygonRings()), the largest possible zoom level at which its full bounding box
   still fits (with margin) into a width×height image - at most maxZoom (the configured
   zoom), so it NEVER zooms in past the configuration, only out if needed. This guarantees
   the incident area stays fully visible in the image instead of being clipped at the edge.
   Gives up at OSM_MIN_AUTO_ZOOM if nothing fits even there (e.g. an unrealistically huge
   polygon) - the caller still draws the outline in that extreme case, it may extend past
   the image edge. */
function fitZoomToPolygon(rings, maxZoom, width, height) {
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const ring of rings) {
        for (const [plon, plat] of ring) {
            if (plon < minLon) {
                minLon = plon;
            }
            if (plon > maxLon) {
                maxLon = plon;
            }
            if (plat < minLat) {
                minLat = plat;
            }
            if (plat > maxLat) {
                maxLat = plat;
            }
        }
    }
    if (!isFinite(minLon) || !isFinite(minLat)) {
        return maxZoom;
    }

    // DE: Rand, damit die (mit gewisser Strichstärke gezeichnete) Umrisslinie nicht exakt am
    // Bildrand klebt. 4,2 %/6px statt 6 %/8px (30 % kleinerer Rand) - das Einsatzgebiet-
    // Polygon soll den Bildausschnitt großzügiger ausfüllen.
    // EN: Margin so the (drawn with some line thickness) outline doesn't sit exactly at the
    // image edge. 4.2%/6px instead of 6%/8px (30% smaller margin) - the incident-area
    // polygon should fill more of the image area.
    const marginX = Math.max(6, Math.round(width * 0.042));
    const marginY = Math.max(6, Math.round(height * 0.042));
    const availableWidth = Math.max(1, width - 2 * marginX);
    const availableHeight = Math.max(1, height - 2 * marginY);

    for (let z = maxZoom; z >= OSM_MIN_AUTO_ZOOM; z--) {
        // DE: minLat/maxLat vertauscht ggü. minLon/maxLon: in Web-Mercator wächst die
        // Pixel-Y-Koordinate nach Süden, der höchste Breitengrad (Norden) liegt also oben
        // (kleineres y) - topLeft braucht daher maxLat, bottomRight minLat.
        // EN: minLat/maxLat swapped relative to minLon/maxLon: in Web Mercator the pixel Y
        // coordinate grows southward, so the highest latitude (north) is at the top
        // (smaller y) - topLeft therefore needs maxLat, bottomRight needs minLat.
        const topLeft = lonLatToGlobalPixel(minLon, maxLat, z);
        const bottomRight = lonLatToGlobalPixel(maxLon, minLat, z);
        const bboxWidth = bottomRight.x - topLeft.x;
        const bboxHeight = bottomRight.y - topLeft.y;
        if (bboxWidth <= availableWidth && bboxHeight <= availableHeight) {
            return z;
        }
    }
    return OSM_MIN_AUTO_ZOOM;
}

/* DE: Zeichnet eine (optional geschlossene) Polylinie aus Bildkoordinaten auf eine
   Jimp-Leinwand: interpoliert linear zwischen aufeinanderfolgenden Punkten und stempelt an
   jedem Zwischenschritt ein thickness×thickness-Quadrat der angegebenen Farbe. Für das
   Einsatzgebiet-Polygon in buildEinsatzMapImage() - reicht für ein sichtbares, ausreichend
   dickes Umriss-Polygon, ohne eine echte Bresenham-Implementierung zu brauchen. Punkte
   außerhalb der Leinwand werden stillschweigend übersprungen (kein Fehler) - relevant, weil
   ein Einsatzgebiet über den konfigurierten Bildausschnitt hinausragen kann.
   EN: Draws a (optionally closed) polyline of image coordinates onto a Jimp canvas:
   linearly interpolates between consecutive points and stamps a thickness×thickness square
   of the given color at each intermediate step. For the incident-area polygon in
   buildEinsatzMapImage() - sufficient for a visible, adequately thick outline without
   needing a real Bresenham implementation. Points outside the canvas are silently skipped
   (not an error) - relevant because an incident area can extend beyond the configured
   image area. */
function drawPolyline(image, points, colorHex, thickness, closed) {
    const w = image.bitmap.width;
    const h = image.bitmap.height;
    const half = Math.floor(thickness / 2);
    const stamp = (cx, cy) => {
        const cxr = Math.round(cx);
        const cyr = Math.round(cy);
        for (let dx = -half; dx < thickness - half; dx++) {
            for (let dy = -half; dy < thickness - half; dy++) {
                const x = cxr + dx;
                const y = cyr + dy;
                if (x >= 0 && x < w && y >= 0 && y < h) {
                    image.setPixelColor(colorHex, x, y);
                }
            }
        }
    };
    const segCount = points.length - (closed ? 0 : 1);
    for (let i = 0; i < segCount; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        const dist = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
        const steps = Math.ceil(dist);
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        }
    }
}

class WaipWeb extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'waip-web',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));

        this.socket = null;
        this.currentMonitor = '';
        this.monitorName = null; // DE: Anzeigename des konfigurierten Monitors, siehe refreshMonitorName() / EN: display name of the configured monitor, see refreshMonitorName()
        this.connecting = false;
        this.registrationPending = false;
        this.registrationTimer = null;
        this.reconnectTimer = null;
        this.restzeitInterval = null;
        this.sessionKeepaliveTimer = null;
        this.nextSessionKeepaliveDelayMs = null;
        this.sessionCookie = null;
        this.currentEinsatzUuid = null;
        this.currentEinsatzSnapshot = null; // -> einsatz.json.current/.routen/.rueckmeldungen/...
        this._restzeitZeroSince = null; // DE: -> Watchdog gegen verpasstes io.standby, siehe restzeitInterval / EN: -> watchdog for a missed io.standby, see restzeitInterval
        this._recurringFailureKeys = new Set(); // -> logRecurringFailure()/logRecovered()
        // DE: Serialisierungskette + Cache für appendMonitorAudit() - verhindert, dass zwei
        // millisekundennahe Aufrufe denselben Ausgangsstand lesen und der zweite Write den
        // Eintrag des ersten überschreibt (siehe dort). Cache startet null = noch nicht aus
        // der DB geladen.
        // EN: Serialization chain + cache for appendMonitorAudit() - prevents two calls
        // milliseconds apart from reading the same starting state, with the second write
        // overwriting the first one's entry (see there). Cache starts as null = not yet
        // loaded from the DB.
        this._monitorAuditQueue = Promise.resolve();
        this._monitorAuditCache = null;
        this._wrongMonitorWindowStart = 0; // -> checkWrongMonitorRate()
        this._wrongMonitorWindowCount = 0;
        this.lastServerVersion = null;

        this._lastDisconnectMsg = null;
        this._lastDisconnectTs = 0;
        this._warnCache = new Map(); // DE: Nachricht -> zuletzt geloggt (ms), siehe safeLog() / EN: message -> last logged (ms), see safeLog()
        this._lastRestzeit = null;
        this._lastDebugEvent = { event: null, ts: 0 };
        // DE: Wird in onUnload() gesetzt, damit initObjects() eine noch laufende
        // Objekt-Initialisierung abbricht, statt bei jeder verbleibenden Definition erneut
        // gegen die bereits geschlossene DB-Verbindung zu laufen - siehe initObjects().
        // EN: Set in onUnload() so initObjects() aborts a still-running object
        // initialization instead of hitting the already-closed DB connection again for
        // every remaining definition - see initObjects().
        this._stopping = false;

        this.HISTORY_SIZE = HISTORY_SIZE;
        this.ALLOWED_EINSATZ_FIELDS = ALLOWED_EINSATZ_FIELDS;
    }

    async onReady() {
        this.REGISTRATION_TIMEOUT_MS = (Number(this.config.registrationTimeoutSec) || 10) * 1000;
        this.RECONNECT_DELAY_MS = (Number(this.config.reconnectDelaySec) || 5) * 1000;
        // DE: Obergrenze für das Session-Keepalive-Intervall - bewusst nicht konfigurierbar,
        // analog zum fest einprogrammierten Wert in /js/session_keepalive.js der Website
        // selbst. Das tatsächliche Intervall wird adaptiv ermittelt (siehe refreshSessionCookie).
        // EN: Upper bound for the session keepalive interval - deliberately not
        // configurable, matching the hardcoded value in the site's own
        // /js/session_keepalive.js. The actual interval is determined adaptively
        // (see refreshSessionCookie).
        this.SESSION_KEEPALIVE_MS = DEFAULT_SESSION_KEEPALIVE_SEC * 1000;
        this.url = (this.config.url || DEFAULT_URL).trim();
        this.monitorID =
            this.config.monitorID !== undefined && this.config.monitorID !== null
                ? String(this.config.monitorID).trim()
                : '';
        // DE: Fällt auf true zurück, falls der Schlüssel im gespeicherten Config-Objekt ganz
        // fehlt (kein !!-Check) - relevant für Installationen von vor 0.7.28, deren
        // gespeicherte Config diesen (damals noch nicht existenten) Schlüssel gar nicht
        // enthält. io-package.json's native-Default ist ebenfalls true, das greift aber nur
        // bei einer frischen Installation, nicht rückwirkend für bereits konfigurierte
        // Instanzen.
        // EN: Falls back to true if the key is entirely missing from the stored config
        // object (not a !! check) - relevant for installations from before 0.7.28, whose
        // stored config doesn't contain this (not yet existing back then) key at all.
        // io-package.json's native default is also true, but that only applies to a fresh
        // installation, not retroactively to already-configured instances.
        this.rdAlarmierungEnabled = this.config.rdAlarmierungEnabled !== false;
        // DE: io-package.json's native-Default ist true (seit 0.7.29), gilt aber nur für
        // Neuinstallationen - bereits konfigurierte Instanzen behalten ihren gespeicherten
        // Wert (z.B. weiterhin false, falls vor 0.7.29 installiert und nie manuell aktiviert).
        // EN: io-package.json's native default is true (since 0.7.29), but only applies to
        // fresh installations - already-configured instances keep their stored value (e.g.
        // still false if installed before 0.7.29 and never manually enabled).
        this.rdKeywordDecodingEnabled = !!this.config.rdKeywordDecodingEnabled;
        // DE: Beschriftungen für decodeRettungsdienstStichwort() - konfigurierbar statt fest im
        // Code, damit sie sich in jede Sprache übersetzen/anpassen lassen. Leerer/fehlender
        // Konfigurationswert fällt auf die deutschen Defaults zurück (siehe io-package.json).
        // EN: Labels for decodeRettungsdienstStichwort() - configurable instead of hardcoded,
        // so they can be translated/adjusted for any language. An empty/missing config
        // value falls back to the German defaults (see io-package.json).
        this.rdLabels = {
            r: (this.config.rdLabelR || '').trim() || DEFAULT_RD_LABEL_R,
            n: (this.config.rdLabelN || '').trim() || DEFAULT_RD_LABEL_N,
            p: (this.config.rdLabelP || '').trim() || DEFAULT_RD_LABEL_P,
            f: (this.config.rdLabelF || '').trim() || DEFAULT_RD_LABEL_F,
            nt: (this.config.rdLabelNT || '').trim() || DEFAULT_RD_LABEL_NT,
        };
        // DE: Konfiguration für das Einsatzkarten-Feature (siehe generateEinsatzMapImage()) -
        // Breite/Höhe/Zoom werden defensiv geklemmt, falls die Admin-Konfiguration (z.B. per
        // externem JSON-Import) einen unsinnigen Wert enthält.
        // EN: Configuration for the incident-map feature (see generateEinsatzMapImage()) -
        // width/height/zoom are defensively clamped in case the admin configuration (e.g.
        // via an external JSON import) contains a nonsensical value.
        this.mapImageEnabled = !!this.config.mapImageEnabled;
        // DE: Default true - zeigt das vom Server gesendete Einsatzgebiet-Polygon, falls
        // vorhanden (siehe buildEinsatzMapImage()). false erzwingt immer den zentrierten
        // Punkt-Marker, auch wenn ein Polygon verfügbar wäre.
        // EN: Defaults to true - shows the incident-area polygon sent by the server, if
        // available (see buildEinsatzMapImage()). false always forces the centered marker
        // dot, even when a polygon would be available.
        this.mapImageShowPolygon = this.config.mapImageShowPolygon !== false;
        this.mapImageWidth = clampNumber(this.config.mapImageWidth, 100, 2000, DEFAULT_MAP_IMAGE_WIDTH);
        this.mapImageHeight = clampNumber(this.config.mapImageHeight, 100, 2000, DEFAULT_MAP_IMAGE_HEIGHT);
        this.mapImageZoom = clampNumber(this.config.mapImageZoom, 1, OSM_MAX_ZOOM, DEFAULT_MAP_IMAGE_ZOOM);
        // DE: Direkt beim Start in Jimps 0xRRGGBBAA-Format vorgerechnet (statt bei jeder
        // Bilderzeugung neu), analog zu den anderen mapImage*-Config-Werten.
        // EN: Precomputed into Jimp's 0xRRGGBBAA format once at startup (instead of on every
        // image generation), same as the other mapImage* config values.
        this.mapImageOutlineColorInt = hexColorToJimpInt(
            this.config.mapImageOutlineColor,
            DEFAULT_MAP_IMAGE_OUTLINE_COLOR,
        );
        this.mapImageOutlineThickness = clampNumber(
            this.config.mapImageOutlineThickness,
            MAP_IMAGE_OUTLINE_THICKNESS_MIN,
            MAP_IMAGE_OUTLINE_THICKNESS_MAX,
            DEFAULT_MAP_IMAGE_OUTLINE_THICKNESS,
        );
        this.mapImageTimeoutSeconds = clampNumber(
            this.config.mapImageTimeout,
            MAP_IMAGE_TIMEOUT_SECONDS_MIN,
            MAP_IMAGE_TIMEOUT_SECONDS_MAX,
            DEFAULT_MAP_IMAGE_TIMEOUT_SECONDS,
        );
        this.mapImageDir = path.join(utils.getAbsoluteInstanceDataDir(this), 'maps');
        // DE: Normalisiert einmalig beim Start (statt bei jedem Lookup): normalizeStichwortForMatch()
        // sorgt für case-insensitiven Vergleich UND behandelt Leerzeichen/Bindestriche als identisch
        // (siehe deren Kommentar), alphabetisch nach Muster sortiert. Die Reihenfolge hat für
        // lookupStichwortBeschreibung() selbst keine Bedeutung mehr (dort gewinnt das
        // längste/spezifischste passende Muster, nicht die Tabellenposition) - die Sortierung
        // dient nur der Übersichtlichkeit/Nachvollziehbarkeit.
        // EN: Normalized once at startup (instead of on every lookup): normalizeStichwortForMatch()
        // handles case-insensitive comparison AND treats spaces/hyphens as equivalent (see its
        // comment), sorted alphabetically by pattern. The order no longer matters to
        // lookupStichwortBeschreibung() itself (there, the longest/most specific matching pattern
        // wins, not the table position) - the sort is purely for readability/traceability.
        this.stichwortMapping = Array.isArray(this.config.stichwortMapping)
            ? this.config.stichwortMapping
                  .filter(e => e && typeof e.stichwort === 'string' && e.stichwort.trim() !== '')
                  .map(e => ({
                      pattern: normalizeStichwortForMatch(e.stichwort),
                      beschreibung: typeof e.beschreibung === 'string' ? e.beschreibung : '',
                      matchType: e.matchType === 'contains' ? 'contains' : 'startsWith',
                  }))
                  .sort((a, b) => a.pattern.localeCompare(b.pattern))
            : [];

        await this.cleanupObsoleteObjects();
        await this.migrateObjectTypes();
        await this.initObjects();
        await this.resetAllStates();
        // DE: Session-Cookie holen, bevor die erste Socket.IO-Verbindung aufgebaut wird
        // EN: Fetch the session cookie before the first Socket.IO connection is established
        await this.refreshSessionCookie();
        this.startSessionKeepalive();
        this.startRestzeitInterval();
        // DE: Nicht awaiten - der Alarm-Empfang soll nicht auf diesen (rein informativen)
        // Namens-Lookup warten müssen.
        // EN: Not awaited - alarm reception shouldn't have to wait for this (purely
        // informational) name lookup.
        this.refreshMonitorName().catch(() => {});
        this.connect();
    }

    onUnload(callback) {
        this._stopping = true;
        try {
            this.cleanupSocket();
            if (this.registrationTimer) {
                this.clearTimeout(this.registrationTimer);
                this.registrationTimer = null;
            }
            if (this.reconnectTimer) {
                this.clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            if (this.restzeitInterval) {
                this.clearInterval(this.restzeitInterval);
                this.restzeitInterval = null;
            }
            if (this.sessionKeepaliveTimer) {
                this.clearTimeout(this.sessionKeepaliveTimer);
                this.sessionKeepaliveTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    /* DE: Entfernt State-Objekte aus früheren Versionen (vis.*, json.*, geo.*, rueckmeldung.counts.*, ...),
       die durch die Umstrukturierung in 0.4.0 ersetzt wurden. setObjectNotExistsAsync legt neue
       Objekte an, löscht aber nie alte - das übernehmen wir hier einmalig beim Start.
       obj.type === 'state' (nicht obj.common.type, das ist der Werttyp) prüft dabei explizit,
       dass wirklich noch das alte State-Blatt vorliegt - relevant für IDs wie einsatz.json, die
       bei der Umstrukturierung in 0.7.15 von State zu Channel gewechselt sind, aber dieselbe ID
       behalten haben: ohne diese Prüfung würde hier sonst bei jedem Neustart der inzwischen
       längst korrekt angelegte Channel wieder gelöscht und von initObjects() neu erzeugt.

       EN: Removes state objects left over from earlier versions (vis.*, json.*, geo.*,
       rueckmeldung.counts.*, ...) that were superseded by the 0.4.0 restructuring.
       setObjectNotExistsAsync creates new objects but never deletes old ones - we handle
       that here once at startup. obj.type === 'state' (not obj.common.type, which is the
       value type) explicitly checks that this is really still the old state leaf - relevant
       for IDs like einsatz.json, which changed from state to channel in the 0.7.15
       restructuring but kept the same ID: without this check, the by-now correctly created
       channel would otherwise get deleted and recreated by initObjects() on every restart.
       Also removes OBSOLETE_FOLDER_IDS - channel/folder objects at paths abandoned entirely
       by a rename, where that same type-check doesn't apply (see its own comment). */
    async cleanupObsoleteObjects() {
        for (const id of OBSOLETE_OBJECT_IDS) {
            try {
                const obj = await this.getObjectAsync(id);
                if (obj && obj.type === 'state') {
                    await this.delObjectAsync(id);
                    this.log.info(`Removed obsolete state object from a previous version: ${id}`);
                }
            } catch {
                /* DE: ignorieren - Objekt existierte vermutlich nicht / EN: ignore - object probably didn't exist */
            }
        }
        for (const id of OBSOLETE_FOLDER_IDS) {
            try {
                const obj = await this.getObjectAsync(id);
                if (obj) {
                    await this.delObjectAsync(id);
                    this.log.info(`Removed obsolete folder object from a previous version: ${id}`);
                }
            } catch {
                /* DE: ignorieren - Objekt existierte vermutlich nicht / EN: ignore - object probably didn't exist */
            }
        }
    }

    /* DE: Löscht bestehende State-Objekte, deren common.type oder common.role nicht mehr zur
       aktuellen STATE_DEFS-Definition passt (z.B. weil sich herausstellt, dass der Server
       ein Feld als Zahl statt als String schickt - siehe einsatz.id/einsatz.sondersignal
       in 0.4.3 -, oder weil sich eine Rolle als falsch gewählt herausstellt - siehe
       debug.lastError in 0.7.15, das trotz role "json" meist nur einen reinen Fehlertext
       enthält). setObjectNotExistsAsync legt danach in initObjects() ein frisches Objekt
       mit der korrekten Definition an. Generisch für alle künftigen Typ-/Rollen-
       Korrekturen, nicht nur diese.

       EN: Deletes existing state objects whose common.type or common.role no longer
       matches the current STATE_DEFS definition (e.g. because it turns out the server
       sends a field as a number instead of a string - see einsatz.id/einsatz.sondersignal
       in 0.4.3 -, or because a role turns out to have been chosen wrong - see
       debug.lastError in 0.7.15, which despite role "json" usually only holds a plain
       error text). setObjectNotExistsAsync then creates a fresh object with the correct
       definition in initObjects(). Generic for all future type/role fixes, not just these. */
    async migrateObjectTypes() {
        for (const def of STATE_DEFS) {
            try {
                const obj = await this.getObjectAsync(def.id);
                if (!obj || !obj.common) {
                    continue;
                }
                const typeChanged = obj.common.type && obj.common.type !== def.type;
                const roleChanged = obj.common.role && obj.common.role !== def.role;
                if (typeChanged || roleChanged) {
                    await this.delObjectAsync(def.id);
                    this.log.info(
                        `Recreated state object with a changed definition: ${def.id} ` +
                            `(type ${obj.common.type} -> ${def.type}, role ${obj.common.role} -> ${def.role})`,
                    );
                }
            } catch {
                /* DE: ignorieren - Objekt existierte vermutlich noch nicht / EN: ignore - object probably didn't exist yet */
            }
        }
    }

    /* DE: Legt Channel-/State-Objekte an, die noch nicht existieren (setObjectNotExistsAsync
       lässt bereits vorhandene unangetastet). Bricht die Schleifen ab, sobald this._stopping
       gesetzt ist (siehe onUnload()) - wird der Adapter mitten in dieser Initialisierung
       beendet (z.B. schnelle Neustarts während/kurz nach einem Update), ist die
       DB-Verbindung ggf. schon geschlossen; ohne diesen Schutz und das try/catch würde
       jeder weitere setObjectNotExistsAsync-Aufruf einzeln fehlschlagen und - da onReady()
       selbst nicht gefangen wird - als unhandled promise rejection im Log auftauchen,
       statt einmalig als Warnung.
       EN: Creates channel/state objects that don't exist yet (setObjectNotExistsAsync
       leaves already-existing ones untouched). Aborts the loops once this._stopping is set
       (see onUnload()) - if the adapter is stopped in the middle of this initialization
       (e.g. rapid restarts during/right after an update), the DB connection may already be
       closed; without this guard and the try/catch, every further setObjectNotExistsAsync
       call would fail individually and - since onReady() itself isn't caught anywhere -
       surface as an unhandled promise rejection in the log instead of a single warning. */
    async initObjects() {
        for (const def of CHANNEL_DEFS) {
            if (this._stopping) {
                return;
            }
            try {
                await this.setObjectNotExistsAsync(def.id, {
                    type: def.type,
                    common: { name: def.name },
                    native: {},
                });
            } catch (e) {
                this.safeWarn(`initObjects channel ${def.id}`, e);
                if (this._stopping) {
                    return;
                }
            }
        }
        for (const def of STATE_DEFS) {
            if (this._stopping) {
                return;
            }
            try {
                await this.setObjectNotExistsAsync(def.id, {
                    type: 'state',
                    common: {
                        name: def.name,
                        type: def.type,
                        role: def.role,
                        read: true,
                        write: false,
                        unit: def.unit,
                        def: def.def !== undefined ? def.def : null,
                    },
                    native: {},
                });
            } catch (e) {
                this.safeWarn(`initObjects state ${def.id}`, e);
                if (this._stopping) {
                    return;
                }
            }
        }
    }

    /* DE: Setzt bei jedem Adapter-Start aktiv alle States (außer RESET_EXCLUDED_STATE_IDS) auf
       ihren "leeren" Wert zurück - anders als initObjects()/setObjectNotExistsAsync(), das
       einen bereits vorhandenen Wert unangetastet lässt. Sorgt dafür, dass jeder Neustart
       mit einem sauber initialisierten Zustand beginnt, unabhängig vom Stand davor. Läuft
       nach initObjects(), die States müssen also bereits existieren.
       Für RESET_EXCLUDED_STATE_IDS wird ein *bestehender* Wert nie überschrieben, aber bei
       einer frischen Installation (noch nie ein Wert gesetzt) trotzdem einmalig
       initialisiert - siehe initStateIfMissing(). Sonst bliebe z.B. einsatz.json.history10
       nach der Installation dauerhaft auf null stehen statt auf "[]".

       EN: Actively resets all states (except RESET_EXCLUDED_STATE_IDS) to their "empty"
       value on every adapter start - unlike initObjects()/setObjectNotExistsAsync(), which
       leaves an already-existing value untouched. Ensures every restart begins with a
       cleanly initialized state, regardless of what came before. Runs after initObjects(),
       so the states must already exist.
       For RESET_EXCLUDED_STATE_IDS, an *existing* value is never overwritten, but on a
       fresh install (no value ever set) it's still initialized once - see
       initStateIfMissing(). Otherwise e.g. einsatz.json.history10 would stay at null
       forever after installation instead of "[]". */
    async resetAllStates() {
        const tasks = [];
        for (const def of STATE_DEFS) {
            const emptyValue = this.computeEmptyStateValue(def);
            if (RESET_EXCLUDED_STATE_IDS.has(def.id)) {
                tasks.push(this.initStateIfMissing(def.id, emptyValue));
                continue;
            }
            tasks.push(this.setStateAsync(def.id, emptyValue, true));
        }
        const results = await Promise.allSettled(tasks);
        for (const r of results) {
            if (r.status === 'rejected') {
                this.safeWarn('resetAllStates', r.reason);
            }
        }
    }

    /* DE: Liefert den "leeren" Wert, den resetAllStates() für einen State-Def schreibt.
       EN: Returns the "empty" value that resetAllStates() writes for a given state def. */
    computeEmptyStateValue(def) {
        if (def.type === 'boolean') {
            return false;
        }
        if (def.type === 'number') {
            return NULLABLE_NUMBER_STATE_IDS.has(def.id) ? null : 0;
        }
        if (JSON_ARRAY_STATE_IDS.has(def.id)) {
            return '[]';
        }
        return null;
    }

    /* DE: Schreibt emptyValue nur, falls für id noch gar kein State-Wert existiert (frische
       Installation) - lässt einen bereits vorhandenen Wert unangetastet. Für die
       RESET_EXCLUDED_STATE_IDS-Ausnahmen in resetAllStates() genutzt.
       EN: Writes emptyValue only if no state value exists yet for id (fresh install) -
       leaves an already-existing value untouched. Used for the RESET_EXCLUDED_STATE_IDS
       exceptions in resetAllStates(). */
    async initStateIfMissing(id, emptyValue) {
        try {
            const st = await this.getStateAsync(id);
            if (!st || st.val === undefined || st.val === null) {
                await this.setStateAsync(id, emptyValue, true);
            }
        } catch (e) {
            this.safeWarn(`initStateIfMissing ${id}`, e);
        }
    }

    /* DE: Einfacher HTTP(S)-GET ohne zusätzliche Dependency; optional mit Cookie-Header.
       EN: Simple HTTP(S) GET without an extra dependency; optionally with a cookie header. */
    httpGet(targetUrl, cookie) {
        return new Promise((resolve, reject) => {
            let parsed;
            try {
                parsed = new URL(targetUrl);
            } catch (e) {
                reject(e);
                return;
            }
            const client = parsed.protocol === 'http:' ? http : https;
            const headers = { 'User-Agent': 'ioBroker.waip-web' };
            if (cookie) {
                headers.Cookie = cookie;
            }
            const req = client.get(parsed, { headers, timeout: 15000 }, res => {
                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('timeout')));
        });
    }

    /* DE: Holt die öffentliche Monitor-Übersichtsseite (/waip/) der übergebenen WAIP-Web-
       Instanz und parst daraus die verfügbaren Monitor-IDs für die Admin-Dropdown-Auswahl
       (siehe onMessage/'getMonitorList'). Rein lesend, erfordert keine Session/Cookie.
       EN: Fetches the given WAIP-Web instance's public monitor overview page (/waip/) and
       parses the available monitor IDs from it for the admin dropdown selection (see
       onMessage/'getMonitorList'). Read-only, requires no session/cookie. */
    async fetchMonitorList(baseUrl) {
        const clean = String(baseUrl || '').replace(/\/+$/, '');
        if (!clean) {
            throw new Error('no WAIP server URL configured');
        }
        const res = await this.httpGet(`${clean}/waip/`);
        if (res.statusCode !== 200 || !res.body) {
            throw new Error(`Could not fetch monitor overview (status ${res.statusCode})`);
        }
        const html = res.body;

        const LINK_RE = /href="\/waip\/(\d+)"[^>]*>\s*([^<]+?)\s*(?:<|$)/g;
        const extractLinks = section => {
            const out = [];
            let m;
            LINK_RE.lastIndex = 0;
            while ((m = LINK_RE.exec(section))) {
                const label = decodeHtmlEntities(m[2]);
                if (label) {
                    out.push({ value: m[1], label });
                }
            }
            return out;
        };

        // DE: "alle Wachalarme" ist ein eigener Link außerhalb der kategorisierten Listen -
        // wird unabhängig vom Parsing-Erfolg der übrigen Seite immer als erste Option angeboten.
        // Label beginnt jeweils mit der eigentlichen Monitor-ID (z.B. "4 - Leitstelle: Lausitz").
        // EN: "all dispatch monitors" is a separate link outside the categorized lists -
        // always offered as the first option regardless of whether parsing the rest of the
        // page succeeds. Each label starts with the actual monitor ID (e.g. "4 - Leitstelle: Lausitz").
        const result = [{ value: '0', label: '0 - Alle Wachalarme' }];
        const seen = new Set(['0']);

        const headingMatches = [];
        for (const cat of MONITOR_CATEGORY_HEADINGS) {
            const m = cat.re.exec(html);
            if (m) {
                headingMatches.push({ key: cat.key, index: m.index });
            }
        }

        if (headingMatches.length) {
            headingMatches.sort((a, b) => a.index - b.index);
            for (let i = 0; i < headingMatches.length; i++) {
                const start = headingMatches[i].index;
                const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : html.length;
                const sectionLabel = MONITOR_CATEGORY_LABELS[headingMatches[i].key] || headingMatches[i].key;
                for (const link of extractLinks(html.slice(start, end))) {
                    if (!seen.has(link.value)) {
                        seen.add(link.value);
                        result.push({ value: link.value, label: `${link.value} - ${sectionLabel}: ${link.label}` });
                    }
                }
            }
        } else {
            // DE: Keine der bekannten Überschriften gefunden -> gesamte Seite unkategorisiert parsen,
            // damit die Auswahl auch bei abweichend strukturierten WAIP-Web-Instanzen funktioniert.
            // EN: None of the known headings found -> parse the whole page uncategorized, so
            // the selection also works for differently structured WAIP-Web instances.
            for (const link of extractLinks(html)) {
                if (!seen.has(link.value)) {
                    seen.add(link.value);
                    result.push({ value: link.value, label: `${link.value} - ${link.label}` });
                }
            }
        }

        // DE: Nach numerischer Monitor-ID sortiert statt in der (je nach Kategorie/Instanz
        // unterschiedlichen) Reihenfolge der Quellseite - '0' (Alle Wachalarme) landet
        // dabei automatisch an erster Stelle, da alle echten Monitor-IDs größer sind.
        // EN: Sorted by numeric monitor ID instead of the source page's order (which varies
        // by category/instance) - '0' (all dispatch monitors) automatically ends up first,
        // since every real monitor ID is greater.
        result.sort((a, b) => Number(a.value) - Number(b.value));

        return result;
    }

    /* DE: Löst this.monitorID einmalig zu einem Anzeigenamen ohne ID auf (z.B. "Leitstelle:
       Lausitz" statt "4 - Leitstelle: Lausitz") und schreibt ihn nach status.registered-
       MonitorName. Wird nur einmal beim Start aufgerufen (nicht bei jedem Reconnect) - das
       Ergebnis wird in this.monitorName gecacht und von onSocketConnect() bei jedem
       (Re-)Connect erneut in den State geschrieben, ohne die Übersichtsseite erneut zu holen.
       EN: Resolves this.monitorID once to a display name without the ID (e.g. "Leitstelle:
       Lausitz" instead of "4 - Leitstelle: Lausitz") and writes it to
       status.registeredMonitorName. Called only once at startup (not on every reconnect) -
       the result is cached in this.monitorName and re-written to the state by
       onSocketConnect() on every (re)connect, without fetching the overview page again. */
    async refreshMonitorName() {
        const monStr = isValidMonitor(this.monitorID) ? this.monitorID : '0';
        try {
            const list = await this.fetchMonitorList(this.url);
            const match = list.find(item => item.value === String(monStr));
            this.monitorName = match ? match.label.replace(/^\d+\s*-\s*/, '') : null;
        } catch (e) {
            this.safeLog('debug', 'refreshMonitorName', e);
            this.monitorName = null;
        }
        await this.setField('status.registeredMonitorName', this.monitorName);
    }

    /* DE: Reagiert auf sendTo-Nachrichten aus dem Admin (aktuell nur 'getMonitorList' für das
       dynamische Monitor-Dropdown, siehe admin/jsonConfig.json).
       EN: Handles sendTo messages from the admin UI (currently only 'getMonitorList' for
       the dynamic monitor dropdown, see admin/jsonConfig.json). */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        if (obj.command === 'getMonitorList') {
            if (!obj.callback) {
                return;
            }
            const targetUrl = (obj.message && obj.message.url) || this.config.url;
            let list;
            try {
                list = await this.fetchMonitorList(targetUrl);
            } catch (e) {
                this.safeLog('debug', 'getMonitorList', e);
                list = [{ value: '0', label: '0 - Alle Wachalarme' }];
            }
            this.sendTo(obj.from, obj.command, list, obj.callback);
        }
    }

    /* DE: Baut aus einem oder mehreren Set-Cookie-Headern einen sendefertigen Cookie-Header (name=value; name2=value2).
       EN: Builds a ready-to-send cookie header (name=value; name2=value2) from one or more Set-Cookie headers. */
    extractCookieHeader(setCookieHeader) {
        const arr = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
        const pairs = arr.map(c => c.split(';')[0].trim()).filter(Boolean);
        return pairs.length ? pairs.join('; ') : null;
    }

    /*
     DE: Holt bzw. erneuert den Session-Cookie über GET /session/keepalive (rolling session,
     analog zum /js/session_keepalive.js der WAIP-Seite selbst). Ohne aktiven Cookie
     verbindet sich der Socket sonst anonym und die Session läuft ab, wodurch die
     Alarm-Zustellung stoppt.

     Solange die bisherige Session noch gültig ist, liefert der Server denselben
     connect.sid zurück (nur die Ablaufzeit wird verlängert). Ist die alte Session
     serverseitig nicht mehr gültig (z.B. weil der letzte Keepalive-Call die konfigurierte
     Cookie-Laufzeit überschritten hat, oder der Server sie aus anderen Gründen invalidiert
     hat), bekommen wir hier einen NEUEN Cookie-Wert - das wird erkannt (isRotation) und
     meldet dem Aufrufer, ob eine bestehende Socket.IO-Verbindung (die noch mit der alten
     Session verknüpft ist) neu aufgebaut werden sollte.

     Aus der vom Server gemeldeten Ablaufzeit wird außerdem die tatsächliche Cookie-
     Lebensdauer dieser Instanz abgeleitet und in this.nextSessionKeepaliveDelayMs
     abgelegt (siehe scheduleSessionKeepalive) - server/app_cfg.js des WAIP-Web-Projekts
     zeigt, dass die Lebensdauer per ENV konfigurierbar ist (Standard dort: 60s, diese
     Instanz nutzt offenbar 10 Min.), ein fest angenommenes Intervall wäre also für andere
     Instanzen potenziell falsch.

     EN: Fetches/renews the session cookie via GET /session/keepalive (rolling session,
     matching the WAIP page's own /js/session_keepalive.js). Without an active cookie the
     socket would otherwise connect anonymously and the session expires, stopping alarm
     delivery.

     As long as the previous session is still valid, the server returns the same
     connect.sid (only the expiry is extended). If the old session is no longer valid
     server-side (e.g. because the last keepalive call exceeded the configured cookie
     lifetime, or the server invalidated it for other reasons), we get a NEW cookie value
     here - this is detected (isRotation) and tells the caller whether an existing
     Socket.IO connection (still tied to the old session) should be rebuilt.

     The actual cookie lifetime of this instance is also derived from the expiry the
     server reports and stored in this.nextSessionKeepaliveDelayMs (see
     scheduleSessionKeepalive) - the WAIP-Web project's server/app_cfg.js shows the
     lifetime is configurable via an env var (default there: 60s, this instance
     apparently uses 10 min.), so a fixed assumed interval could potentially be wrong for
     other instances.
    */
    async refreshSessionCookie() {
        const previousCookie = this.sessionCookie;
        const requestStartedAt = Date.now();
        try {
            const keepaliveUrl = `${this.url}/session/keepalive`;
            const res = await this.httpGet(keepaliveUrl, this.sessionCookie);
            const newCookie = this.extractCookieHeader(res.headers['set-cookie']);
            if (newCookie) {
                const isRotation = !!previousCookie && newCookie !== previousCookie;
                this.sessionCookie = newCookie;
                let expires = null;
                try {
                    expires = JSON.parse(res.body).expires || null;
                } catch {
                    /* DE: ignorieren, body war kein JSON / EN: ignore, body wasn't JSON */
                }
                if (expires) {
                    try {
                        await this.setStateAsync('debug.sessionExpires', expires, true);
                    } catch {
                        /* ignore */
                    }
                    const expiresMs = new Date(expires).getTime();
                    if (!isNaN(expiresMs)) {
                        const observedMaxAgeMs = expiresMs - requestStartedAt;
                        if (observedMaxAgeMs > 0) {
                            // DE: gleiche Klammerung wie /js/session_keepalive.js: 80% der
                            // beobachteten Laufzeit, mindestens SESSION_KEEPALIVE_MIN_MS,
                            // höchstens die konfigurierte Obergrenze (this.SESSION_KEEPALIVE_MS)
                            // EN: same clamping as /js/session_keepalive.js: 80% of the
                            // observed lifetime, at least SESSION_KEEPALIVE_MIN_MS, at most
                            // the configured upper bound (this.SESSION_KEEPALIVE_MS)
                            const ceiling = Math.max(this.SESSION_KEEPALIVE_MS, SESSION_KEEPALIVE_MIN_MS);
                            this.nextSessionKeepaliveDelayMs = Math.min(
                                Math.max(observedMaxAgeMs * 0.8, SESSION_KEEPALIVE_MIN_MS),
                                ceiling,
                            );
                        }
                    }
                }
                if (isRotation) {
                    // DE: Teil des normalen, selbstheilenden Session-Zyklus dieser Instanz
                    // (siehe refreshSessionCookie-Kommentar oben) -> info statt warn.
                    // EN: Part of this instance's normal, self-healing session cycle (see
                    // the refreshSessionCookie comment above) -> info instead of warn.
                    this.log.info(
                        'Session cookie was reissued by the server (old session was invalid) – forcing reconnect',
                    );
                    this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'session_cookie_rotated' }).catch(
                        () => {},
                    );
                } else {
                    this.log.debug(
                        `session cookie renewed (status ${res.statusCode}${expires ? `, valid until ${expires}` : ''}${this.nextSessionKeepaliveDelayMs ? `, next keepalive in ${Math.round(this.nextSessionKeepaliveDelayMs / 1000)}s` : ''})`,
                    );
                }
                this.logRecovered('sessionCookie', 'Session cookie refresh recovered');
                return { ok: true, rotated: isRotation };
            }
            this.logRecurringFailure(
                'sessionCookie',
                'warn',
                'refreshSessionCookie',
                `keepalive response had no Set-Cookie header (status ${res.statusCode})`,
            );
            return { ok: false, rotated: false };
        } catch (e) {
            this.logRecurringFailure('sessionCookie', 'warn', 'refreshSessionCookie', e);
            return { ok: false, rotated: false };
        }
    }

    /* DE: Erzwingt einen Socket-Reconnect, falls gerade eine Verbindung aktiv/im Aufbau ist
       (z.B. weil der Session-Cookie rotiert ist oder der Server laut io.version neu
       gestartet wurde). Läuft gerade kein Socket (z.B. während der Wartezeit vor einem
       geplanten Reconnect), ist nichts zu tun - der nächste connect() erledigt das
       ohnehin mit den dann aktuellen Daten (Cookie etc.).
       EN: Forces a socket reconnect if a connection is currently active/being established
       (e.g. because the session cookie rotated or the server reported a restart via
       io.version). If no socket is currently running (e.g. during the wait before a
       scheduled reconnect), there's nothing to do - the next connect() will handle it
       anyway with the then-current data (cookie etc.). */
    forceReconnect(reason) {
        if (this.connecting) {
            this.log.debug(`forceReconnect(${reason}): connect() is already running, skipping the forced reconnect`);
            return;
        }
        if (!this.socket) {
            this.log.debug(
                `forceReconnect(${reason}): no open connection right now, the next connect() will handle this automatically`,
            );
            return;
        }
        this.log.info(`Rebuilding the Socket.IO connection (${reason})`);
        this.connect(true);
    }

    /* DE: Startet die adaptive Keepalive-Kette. Nutzt this.nextSessionKeepaliveDelayMs, falls
       aus einer vorherigen refreshSessionCookie()-Antwort bereits eine reale Cookie-Laufzeit
       bekannt ist (z.B. aus dem initialen Aufruf in onReady()), sonst die konfigurierte
       Obergrenze als vorsichtigen Startwert.
       EN: Starts the adaptive keepalive chain. Uses this.nextSessionKeepaliveDelayMs if a
       real cookie lifetime is already known from a previous refreshSessionCookie() response
       (e.g. from the initial call in onReady()), otherwise the configured upper bound as a
       cautious starting value. */
    startSessionKeepalive() {
        this.scheduleSessionKeepalive(this.nextSessionKeepaliveDelayMs || this.SESSION_KEEPALIVE_MS);
    }

    /* DE: setTimeout statt setInterval, weil sich das Intervall von Aufruf zu Aufruf ändern
       kann (adaptiv aus der vom Server gemeldeten Cookie-Laufzeit abgeleitet).
       EN: setTimeout instead of setInterval, since the interval can change from call to
       call (derived adaptively from the cookie lifetime the server reports). */
    scheduleSessionKeepalive(delayMs) {
        if (this.sessionKeepaliveTimer) {
            this.clearTimeout(this.sessionKeepaliveTimer);
        }
        this.sessionKeepaliveTimer = this.setTimeout(async () => {
            const { rotated } = await this.refreshSessionCookie();
            if (rotated) {
                this.forceReconnect('session cookie rotated');
            }
            this.scheduleSessionKeepalive(this.nextSessionKeepaliveDelayMs || this.SESSION_KEEPALIVE_MS);
        }, delayMs);
    }

    /* DE: Sicheres, deduplizierendes Logging. level ist 'error'/'warn'/'info'/'debug' -
       je unerwarteter/handlungsbedürftiger ein Fall ist, desto höher das Level.
       safeWarn() bleibt als Kurzform für den (weitaus häufigsten) warn-Fall erhalten.
       Dedupe ist pro Nachricht (nicht nur die zuletzt geloggte) - sonst würden sich
       abwechselnde unterschiedliche Meldungen gegenseitig die Deduplizierung einer
       jeweils wiederkehrenden Meldung verhindern.
       EN: Safe, deduplicating logging. level is 'error'/'warn'/'info'/'debug' - the more
       unexpected/actionable a case is, the higher the level. safeWarn() remains as a
       shorthand for the (by far most common) warn case. Deduplication is per message (not
       just the last one logged) - otherwise alternating different messages would prevent
       each other's deduplication of a recurring message. */
    safeLog(level, context, err) {
        try {
            const now = Date.now();
            const msg = typeof err === 'string' ? err : err && err.message ? err.message : String(err);
            const out = context ? `${context}: ${msg}` : msg;
            const lastLoggedAt = this._warnCache.get(out);
            if (lastLoggedAt !== undefined && now - lastLoggedAt < WARN_DEDUPE_MS) {
                return;
            }
            if (this._warnCache.size >= WARN_DEDUPE_CACHE_MAX) {
                this._warnCache.clear();
            }
            this._warnCache.set(out, now);
            this.log[level](out);
        } catch {
            /* silent */
        }
    }

    safeWarn(context, err) {
        this.safeLog('warn', context, err);
    }

    /* DE: Loggt einen wiederkehrbaren Fehler nach dem offiziellen ioBroker-Logging-Muster
       ("first occurrence at warn/error, repetitions at debug, recovery once at info" -
       siehe Adapter-Entwicklerdoku, Abschnitt "Logging"): beim ersten Auftreten auf
       `level`, bei jedem weiteren (bis zur Erholung via logRecovered()) nur noch auf
       debug. Für tatsächlich wiederkehrende Zustände (Session-Cookie, Registrierung,
       Verbindungsaufbau) gedacht, nicht für einmalige State-Write-Fehler.
       EN: Logs a recurring failure following the official ioBroker logging pattern
       ("first occurrence at warn/error, repetitions at debug, recovery once at info" -
       see the adapter dev docs, "Logging" section): on first occurrence at `level`, on
       every subsequent occurrence (until recovery via logRecovered()) only at debug.
       Meant for genuinely recurring conditions (session cookie, registration, connection
       setup), not for one-off state-write failures. */
    logRecurringFailure(key, level, context, err) {
        const isFirst = !this._recurringFailureKeys.has(key);
        this._recurringFailureKeys.add(key);
        this.safeLog(isFirst ? level : 'debug', context, err);
    }

    /* DE: Meldet die Erholung von einem zuvor über logRecurringFailure() gemeldeten Fehler -
       loggt einmalig auf info, aber nur falls der Fehler unter diesem key tatsächlich
       aktiv war (sonst kein Log, kein unnötiges Rauschen bei jedem erfolgreichen Versuch).
       EN: Reports recovery from a failure previously reported via logRecurringFailure() -
       logs once at info, but only if a failure under this key was actually active
       (otherwise no log, no unnecessary noise on every successful attempt). */
    logRecovered(key, msg) {
        if (this._recurringFailureKeys.delete(key)) {
            this.log.info(msg);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: `${key}_recovered` }).catch(() => {});
        }
    }

    /* DE: Dedupliziertes Info-Logging für Disconnects.
       EN: Deduplicated info-level logging for disconnects. */
    logDisconnect(msg) {
        try {
            const now = Date.now();
            if (msg === this._lastDisconnectMsg && now - this._lastDisconnectTs < DISCONNECT_DEDUPE_MS) {
                return;
            }
            this._lastDisconnectMsg = msg;
            this._lastDisconnectTs = now;
            this.log.info(msg);
        } catch {
            /* silent */
        }
    }

    /* DE: Hängt einen Eintrag an das Monitor-Audit-Log an (max. MONITOR_AUDIT_SIZE Einträge).
       Die Schreibvorgänge werden über this._monitorAuditQueue serialisiert: appendMonitorAudit()
       wird an ~10 Stellen fire-and-forget aufgerufen (siehe die .catch(() => {})-Aufrufe), und
       mehrere davon feuern millisekundennah hintereinander (z.B. connect_called -> emit_WAIP,
       oder manual_reconnect_triggered -> connect_called). Als reines
       getStateAsync -> unshift -> setStateAsync wäre das ein klassisches Read-Modify-Write-
       Rennen: beide Aufrufe lesen denselben Ausgangsstand, und der zweite Write überschreibt
       den Eintrag des ersten - Einträge gingen also genau dann verloren, wenn am meisten
       passiert. Zusätzlich wird der Stand in this._monitorAuditCache gehalten, damit nicht bei
       jedem Eintrag erneut aus der DB gelesen werden muss.
       EN: Appends an entry to the monitor audit log (max. MONITOR_AUDIT_SIZE entries).
       Writes are serialized through this._monitorAuditQueue: appendMonitorAudit() is called
       fire-and-forget from ~10 places (see the .catch(() => {}) calls), several of which fire
       within milliseconds of each other (e.g. connect_called -> emit_WAIP, or
       manual_reconnect_triggered -> connect_called). As a plain
       getStateAsync -> unshift -> setStateAsync this would be a classic read-modify-write
       race: both calls read the same starting state and the second write overwrites the
       first one's entry - so entries would be lost exactly when most is happening. The
       current state is additionally kept in this._monitorAuditCache to avoid re-reading
       from the DB for every entry. */
    appendMonitorAudit(entry) {
        // DE: An die bestehende Kette anhängen statt sofort auszuführen - dadurch läuft immer
        // höchstens ein Read-Modify-Write gleichzeitig. Der Rückgabewert bleibt ein Promise,
        // damit die bestehenden .catch(() => {})-Aufrufstellen unverändert funktionieren.
        // EN: Append to the existing chain instead of running immediately - that way at most
        // one read-modify-write runs at a time. The return value stays a promise so the
        // existing .catch(() => {}) call sites keep working unchanged.
        this._monitorAuditQueue = this._monitorAuditQueue.then(() => this._appendMonitorAuditNow(entry));
        return this._monitorAuditQueue;
    }

    async _appendMonitorAuditNow(entry) {
        try {
            // DE: Beim ersten Aufruf einmalig aus der DB laden (der State überlebt Neustarts,
            // siehe RESET_EXCLUDED_STATE_IDS), danach den Cache fortschreiben.
            // EN: Load from the DB once on the first call (the state survives restarts, see
            // RESET_EXCLUDED_STATE_IDS), then keep updating the cache.
            if (this._monitorAuditCache === null) {
                const st = await this.getStateAsync('debug.monitorAudit');
                try {
                    const parsed = st && st.val ? JSON.parse(st.val) : [];
                    this._monitorAuditCache = Array.isArray(parsed) ? parsed : [];
                } catch {
                    this._monitorAuditCache = [];
                }
            }
            this._monitorAuditCache.unshift(entry);
            if (this._monitorAuditCache.length > MONITOR_AUDIT_SIZE) {
                this._monitorAuditCache = this._monitorAuditCache.slice(0, MONITOR_AUDIT_SIZE);
            }
            await this.setStateAsync('debug.monitorAudit', JSON.stringify(this._monitorAuditCache), true);
        } catch (e) {
            // DE: betrifft nur das interne Audit-Log, keine echten Einsatzdaten -> debug statt warn
            // EN: only affects the internal audit log, not real incident data -> debug instead of warn
            this.safeLog('debug', 'appendMonitorAudit', e);
        }
    }

    incrementIgnoredCount() {
        this.getStateAsync('debug.ignoredCount')
            .then(c => this.setStateAsync('debug.ignoredCount', Number((c && c.val) || 0) + 1, true))
            .catch(() => {});
    }

    /* DE: Eskaliert wiederholte "Event für anderen Monitor"-Meldungen auf warn, wenn sie
       innerhalb eines Zeitfensters (WRONG_MONITOR_WARN_WINDOW_MS) einen Schwellwert
       (WRONG_MONITOR_WARN_THRESHOLD) überschreiten - Hinweis auf eine falsch
       konfigurierte Monitor-ID, statt dauerhaft nur auf info zu bleiben. Nutzt
       logRecurringFailure()/logRecovered() für das übliche warn-einmal/debug-danach/
       info-bei-Erholung-Muster.
       EN: Escalates repeated "event for a different monitor" messages to warn if they
       exceed a threshold (WRONG_MONITOR_WARN_THRESHOLD) within a time window
       (WRONG_MONITOR_WARN_WINDOW_MS) - a hint at a misconfigured monitor ID, instead of
       staying at info level indefinitely. Uses logRecurringFailure()/logRecovered() for
       the usual warn-once/debug-afterwards/info-on-recovery pattern. */
    checkWrongMonitorRate() {
        const now = Date.now();
        if (now - this._wrongMonitorWindowStart > WRONG_MONITOR_WARN_WINDOW_MS) {
            // DE: Fenster abgelaufen, ohne dass es nochmal den Schwellwert erreicht hat ->
            // falls zuvor eskaliert wurde, gilt die Rate jetzt als erholt.
            // EN: Window expired without reaching the threshold again -> if it was
            // escalated before, the rate is now considered recovered.
            this.logRecovered('wrongMonitor', 'Wrong-monitor event rate returned to normal');
            this._wrongMonitorWindowStart = now;
            this._wrongMonitorWindowCount = 0;
        }
        this._wrongMonitorWindowCount++;
        if (this._wrongMonitorWindowCount >= WRONG_MONITOR_WARN_THRESHOLD) {
            this.logRecurringFailure(
                'wrongMonitor',
                'warn',
                'ignoredEvent.wrongMonitor',
                `Repeatedly receiving events for a different monitor (current=${this.currentMonitor}, ` +
                    `${this._wrongMonitorWindowCount} in the last ${Math.round(WRONG_MONITOR_WARN_WINDOW_MS / 60000)}min) ` +
                    `- check the configured monitor ID`,
            );
        }
    }

    /* DE: Setzt einen State; Objekte/Arrays werden JSON-stringifiziert.
       EN: Sets a state; objects/arrays are JSON-stringified. */
    async setField(path, val) {
        try {
            let toSet;
            const def = STATE_DEF_BY_ID.get(path);
            if (val === null) {
                toSet = null;
            } else if (def && def.type === 'string') {
                // DE: Der State ist als "string" deklariert (z.B. role "json") - unabhängig vom
                // tatsächlichen JS-Typ der Serverantwort (etwa ein rohes Boolean/Number-Flag)
                // muss "val" den deklarierten Typ einhalten, sonst schlägt die
                // ioBroker-Objektstrukturprüfung fehl (E3005).
                // EN: The state is declared as "string" (e.g. role "json") - regardless of
                // the actual JS type of the server's response (e.g. a raw boolean/number
                // flag), "val" must match the declared type, otherwise the ioBroker object
                // structure check fails (E3005).
                toSet = typeof val === 'string' ? val : JSON.stringify(val);
            } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
                toSet = val;
            } else {
                toSet = JSON.stringify(val);
            }
            await this.setStateAsync(path, toSet, true);
        } catch (e) {
            this.safeWarn(`setField ${path}`, e);
        }
    }

    /* DE: Schreibt ein flaches Array (routen/rueckmeldungen/emAlarmiert/emWeitere) in einen
       einsatz.json.*-State. Wandelt Nicht-Arrays defensiv in ein leeres Array um, damit
       Tabellen-Widgets nie auf einen unerwarteten Werttyp treffen.
       EN: Writes a flat array (routen/rueckmeldungen/emAlarmiert/emWeitere) into an
       einsatz.json.* state. Defensively converts non-arrays into an empty array, so table
       widgets never encounter an unexpected value type. */
    async writeJsonArrayState(id, value) {
        try {
            await this.setStateAsync(id, JSON.stringify(Array.isArray(value) ? value : []), true);
        } catch (e) {
            this.safeWarn(`${id}.setState`, e);
        }
    }

    /* DE: Löst das verschachtelte position-Objekt eines Routen-Eintrags zu flachen lat/lon-Feldern
       auf (siehe einsatz.json.routen) - Tabellen-Widgets können nur eine Verschachtelungsebene
       abflachen, position{lat,lon} wäre bereits eine Ebene zu viel.
       EN: Resolves a route entry's nested position object into flat lat/lon fields (see
       einsatz.json.routen) - table widgets can only flatten one level of nesting,
       position{lat,lon} would already be one level too many. */
    flattenRoutenEntry(r) {
        if (!r || typeof r !== 'object') {
            return r;
        }
        const { position, ...rest } = r;
        return {
            ...rest,
            lat: position && typeof position.lat === 'number' ? position.lat : null,
            lon: position && typeof position.lon === 'number' ? position.lon : null,
        };
    }

    /* DE: Dekodiert Rettungsdienst-Stichwörter nach dem Schema "R<Anzahl RTW>N<Anzahl NEF>[p][f][-NT]"
       - von mehreren Leitstellen verwendet, dokumentiertes Beispiel:
       https://www.leitstelle-lausitz.de/anpassung-der-einsatzstichworte-rettungsdienst/
       (z.B. "R1N0" = 1 RTW, kein NEF). Toleriert dabei zwei Schreibweisen der Modifikatoren:
       ohne Leerzeichen/mit Bindestrich vor NT (Lausitz, "R1N1p"/"R1N0-NT") sowie mit
       Leerzeichen/ohne Bindestrich vor nt (Brandenburg/IRLS, "R1N1 p"/"R1N0 nt", siehe
       Einsatzstichworte Rettungsdienst der IRLS des Landes Brandenburg). Nur aktiv, wenn
       rdKeywordDecodingEnabled gesetzt ist (Default aus, da nicht jede Leitstelle/WAIP-Web-
       Instanz dieses Schema verwendet). Liefert null, falls das Stichwort keinem der beiden
       Muster entspricht.
       EN: Decodes rescue-service keywords following the scheme
       "R<ambulance count>N<physician-vehicle count>[p][f][-NT]" - used by several dispatch
       centers, documented example:
       https://www.leitstelle-lausitz.de/anpassung-der-einsatzstichworte-rettungsdienst/
       (e.g. "R1N0" = 1 ambulance, no physician vehicle). Tolerates two modifier spellings:
       no space/with hyphen before NT (Lausitz, "R1N1p"/"R1N0-NT") and with a space/no hyphen
       before nt (Brandenburg/IRLS, "R1N1 p"/"R1N0 nt", see Einsatzstichworte Rettungsdienst
       der IRLS des Landes Brandenburg). Only active if rdKeywordDecodingEnabled is set
       (default off, since not every dispatch center/WAIP-Web instance uses this scheme).
       Returns null if the keyword matches neither pattern. */
    decodeRettungsdienstStichwort(stichwort) {
        // DE: Zwei bekannte Schreibweisen der Modifikatoren toleriert: ohne Leerzeichen/mit
        // Bindestrich vor NT (Leitstelle Lausitz, z.B. "R1N1p", "R1N0-NT") sowie mit Leerzeichen
        // und ohne Bindestrich vor nt (Leitstelle Brandenburg/IRLS, z.B. "R1N1 p", "R1N0 nt").
        // EN: Tolerates two known modifier spellings: no space/with hyphen before NT (Leitstelle
        // Lausitz, e.g. "R1N1p", "R1N0-NT") and with a space and no hyphen before nt (Leitstelle
        // Brandenburg/IRLS, e.g. "R1N1 p", "R1N0 nt").
        const m = /^R(\d+)N(\d+)\s*([pf]*)\s*(-?nt)?$/i.exec(String(stichwort || '').trim());
        if (!m) {
            return null;
        }
        const rtw = m[1];
        const nef = m[2];
        const modifiers = (m[3] || '').toLowerCase();
        const labels = this.rdLabels || {};
        const parts = [`${labels.r || DEFAULT_RD_LABEL_R}: ${rtw}`, `${labels.n || DEFAULT_RD_LABEL_N}: ${nef}`];
        if (modifiers.includes('p')) {
            parts.push(labels.p || DEFAULT_RD_LABEL_P);
        }
        if (modifiers.includes('f')) {
            parts.push(labels.f || DEFAULT_RD_LABEL_F);
        }
        if (m[4]) {
            parts.push(labels.nt || DEFAULT_RD_LABEL_NT);
        }
        return parts.join(', ');
    }

    /* DE: Ermittelt die Beschreibung zu einem Stichwort: zuerst die Rettungsdienst-Dekodierung (falls
       aktiviert und das Muster passt), sonst die manuelle Stammdaten-Tabelle (this.stichwortMapping,
       case-insensitiv, Leerzeichen/Bindestriche äquivalent - siehe normalizeStichwortForMatch(),
       startsWith/contains je Eintrag). Bei mehreren passenden Einträgen gewinnt der mit dem
       LÄNGSTEN Muster (spezifischste Übereinstimmung) - unabhängig von der Tabellenreihenfolge,
       damit die Admin-Tabelle gefahrlos alphabetisch sortiert werden kann (z.B. "B:Wald groß/WSP"
       schlägt automatisch das kürzere "B:Wald", ganz gleich welche der beiden Zeilen zuerst in der
       Tabelle steht). Bei gleicher Musterlänge entscheidet die Tabellenreihenfolge als Tiebreaker.
       Liefert null, wenn nichts passt (kein Fehler).
       EN: Determines the description for a keyword: first the rescue-service decoder (if
       enabled and the pattern matches), otherwise the manual keyword table
       (this.stichwortMapping, case-insensitive, spaces/hyphens equivalent - see
       normalizeStichwortForMatch(), startsWith/contains per entry). If several entries match,
       the one with the LONGEST pattern (most specific match) wins - independent of table order,
       so the admin table can be sorted alphabetically without risk (e.g. "B:Wald groß/WSP"
       automatically beats the shorter "B:Wald", regardless of which of the two rows comes first
       in the table). If patterns tie in length, table order decides as a tiebreaker. Returns
       null if nothing matches (not an error). */
    lookupStichwortBeschreibung(stichwort) {
        if (!stichwort) {
            return null;
        }
        if (this.rdKeywordDecodingEnabled) {
            const decoded = this.decodeRettungsdienstStichwort(stichwort);
            if (decoded) {
                return decoded;
            }
        }
        const value = normalizeStichwortForMatch(stichwort);
        if (!value) {
            return null;
        }
        let best = null;
        for (const entry of this.stichwortMapping || []) {
            const isMatch =
                entry.matchType === 'contains' ? value.includes(entry.pattern) : value.startsWith(entry.pattern);
            if (isMatch && (!best || entry.pattern.length > best.pattern.length)) {
                best = entry;
            }
        }
        return best ? best.beschreibung : null;
    }

    /* DE: Baut das PNG-Kartenbild für einen Einsatz: lädt die für width/height/zoom nötigen
       OSM-Kacheln, setzt sie zu einer Leinwand zusammen, schneidet sie exakt (nicht nur
       kachelgenau) auf den konfigurierten Bildausschnitt um den Einsatzort zu und zeichnet
       das vom Server gesendete Einsatzgebiet ein (siehe unten), bevor die laut OSM-Lizenz
       (ODbL) erforderliche Attribution unten links aufgestempelt wird. Kachel-Fehlschläge
       (z.B. einzelner 404/Timeout) werden toleriert - die betroffene Kachel bleibt dann
       einfach die Hintergrundfarbe der Leinwand, ein Totalausfall aller Kacheln lässt
       Promise.all() aber durchschlagen. Wirft bei einem harten Fehler (z.B. keine einzige
       Kachel ladbar) - Aufrufer generateEinsatzMapImage() fängt das ab.
       Zoom-Level: Wird ein Einsatzgebiet-Polygon mitgeliefert, weicht der tatsächlich
       verwendete Zoom bei Bedarf nach unten (herauszoomen) vom konfigurierten
       this.mapImageZoom ab, damit das komplette Gebiet im Bild sichtbar bleibt statt am
       Rand abgeschnitten zu werden - siehe fitZoomToPolygon(). Ohne Polygon (Fallback auf
       den Punkt-Marker) bleibt es beim konfigurierten Zoom.
       EN: Builds the PNG map image for an incident: downloads the OSM tiles needed for
       width/height/zoom, composites them onto a canvas, crops it exactly (not just
       tile-aligned) to the configured image area around the incident location, and draws
       the incident area the server sent (see below), before stamping the attribution
       required by the OSM license (ODbL) in the bottom-left corner. Individual tile
       failures (e.g. a single 404/timeout) are tolerated - the affected tile just stays the
       canvas background color, but a total failure of all tiles propagates via
       Promise.all(). Throws on a hard failure (e.g. not a single tile loadable) - caller
       generateEinsatzMapImage() catches that.
       Zoom level: if an incident-area polygon is supplied (and mapImageShowPolygon is on),
       the actual zoom used deviates downward (zooms out) from the configured
       this.mapImageZoom as needed, so the full area stays visible in the image instead of
       being clipped at the edge - see fitZoomToPolygon(). Without a polygon (falling back
       to the point marker), it stays at the configured zoom.
       mapImageShowPolygon: when off, the polygon is never extracted/drawn at all - the
       function behaves exactly as if the incident carried no geometry, always falling back
       to the centered marker dot at the configured zoom. */
    async buildEinsatzMapImage(lat, lon, geometry) {
        const width = this.mapImageWidth;
        const height = this.mapImageHeight;
        const rings = this.mapImageShowPolygon ? extractPolygonRings(geometry) : [];
        let zoom = this.mapImageZoom;
        if (rings.length) {
            const fittedZoom = fitZoomToPolygon(rings, zoom, width, height);
            if (fittedZoom !== zoom) {
                this.log.debug(
                    `buildEinsatzMapImage: zooming out from ${zoom} to ${fittedZoom} so the incident area fits in the image`,
                );
                zoom = fittedZoom;
            }
        }

        const center = lonLatToGlobalPixel(lon, lat, zoom);
        const originX = center.x - width / 2;
        const originY = center.y - height / 2;

        const startTileX = Math.floor(originX / OSM_TILE_SIZE);
        const endTileX = Math.floor((originX + width - 1) / OSM_TILE_SIZE);
        const startTileY = Math.floor(originY / OSM_TILE_SIZE);
        const endTileY = Math.floor((originY + height - 1) / OSM_TILE_SIZE);
        const n = Math.pow(2, zoom);

        const canvasWidth = (endTileX - startTileX + 1) * OSM_TILE_SIZE;
        const canvasHeight = (endTileY - startTileY + 1) * OSM_TILE_SIZE;
        const canvas = new Jimp({ width: canvasWidth, height: canvasHeight, color: 0xcccccc_ff });

        const tileFetches = [];
        for (let tx = startTileX; tx <= endTileX; tx++) {
            for (let ty = startTileY; ty <= endTileY; ty++) {
                // DE: Keine Kacheln jenseits der Pol-nahen Web-Mercator-Grenze (siehe fetchOsmTile).
                // EN: No tiles beyond the near-pole Web Mercator limit (see fetchOsmTile).
                if (ty < 0 || ty >= n) {
                    continue;
                }
                const offsetX = (tx - startTileX) * OSM_TILE_SIZE;
                const offsetY = (ty - startTileY) * OSM_TILE_SIZE;
                tileFetches.push(
                    fetchOsmTile(zoom, tx, ty)
                        .then(buf => Jimp.read(buf))
                        .then(tileImg => {
                            canvas.composite(tileImg, offsetX, offsetY);
                        })
                        .catch(e => this.safeWarn(`buildEinsatzMapImage.tile ${zoom}/${tx}/${ty}`, e)),
                );
            }
        }
        if (!tileFetches.length) {
            throw new Error(`no tiles to fetch for lat=${lat} lon=${lon} zoom=${zoom}`);
        }
        await Promise.all(tileFetches);

        const cropX = Math.round(originX - startTileX * OSM_TILE_SIZE);
        const cropY = Math.round(originY - startTileY * OSM_TILE_SIZE);
        canvas.crop({ x: cropX, y: cropY, w: width, h: height });

        // DE: Einsatzgebiet einzeichnen: bevorzugt das/die Original-Polygon(e), die der
        // WAIP-Server im geometry-Feld sendet (i.d.R. ein kreisförmiges Polygon um den
        // Einsatzort, nicht nur dessen Mittelpunkt) - jeder Ringpunkt wird über
        // lonLatToGlobalPixel() in Bild-Pixelkoordinaten umgerechnet (Ursprung um
        // originX/originY verschoben, siehe deren Berechnung oben) und als geschlossene
        // Umrisslinie gezeichnet, in der konfigurierten Farbe/Strichstärke
        // (mapImageOutlineColor/-Thickness). Nur falls KEIN Polygon vorliegt (Geometrie
        // fehlt oder ist z.B. nur ein Point/LineString), fällt die Funktion auf einen
        // einfachen Punkt-Marker (zwei konzentrische Kreise, weißer Ring/Kern in der
        // konfigurierten Farbe) in der Bildmitte zurück - das circle()-Plugin von Jimp
        // maskiert dafür bereits zuverlässig.
        // EN: Draw the incident area: prefers the original polygon(s) the WAIP server sends
        // in the geometry field (usually a circle-shaped polygon around the incident
        // location, not just its center point) - each ring point is converted to image
        // pixel coordinates via lonLatToGlobalPixel() (origin shifted by originX/originY,
        // see their calculation above) and drawn as a closed outline, in the configured
        // color/thickness (mapImageOutlineColor/-Thickness). Only if NO polygon is available
        // (geometry missing, or e.g. just a Point/LineString) does the function fall back to
        // a simple point marker (two concentric circles, white ring/core in the configured
        // color) at the image center - Jimp's circle() plugin already masks that reliably.
        if (rings.length) {
            for (const ring of rings) {
                const pixelRing = ring.map(([plon, plat]) => {
                    const p = lonLatToGlobalPixel(plon, plat, zoom);
                    return [p.x - originX, p.y - originY];
                });
                drawPolyline(canvas, pixelRing, this.mapImageOutlineColorInt, this.mapImageOutlineThickness, true);
            }
        } else {
            const outerSize = Math.max(10, Math.round(Math.min(width, height) * 0.035));
            const innerSize = Math.round(outerSize * 0.6);
            const outerMarker = new Jimp({ width: outerSize, height: outerSize, color: 0xffffffff });
            outerMarker.circle();
            const innerMarker = new Jimp({ width: innerSize, height: innerSize, color: this.mapImageOutlineColorInt });
            innerMarker.circle();
            outerMarker.composite(
                innerMarker,
                Math.round((outerSize - innerSize) / 2),
                Math.round((outerSize - innerSize) / 2),
            );
            canvas.composite(
                outerMarker,
                Math.round(width / 2 - outerSize / 2),
                Math.round(height / 2 - outerSize / 2),
            );
        }

        // DE: OSM-Attribution (von der ODbL-Lizenz der Kartendaten vorgeschrieben) unten links,
        // mit halbtransparentem Hintergrund für Lesbarkeit über beliebigem Kartenuntergrund.
        // EN: OSM attribution (required by the ODbL license of the map data) at the
        // bottom-left, with a semi-transparent background for legibility over any map
        // background.
        const attributionText = '© OpenStreetMap contributors';
        const font = await loadFont(jimpFonts.SANS_8_WHITE);
        const attributionBg = new Jimp({ width: Math.min(width, 170), height: 12, color: 0x00000099 });
        canvas.composite(attributionBg, 0, height - 12);
        canvas.print({ x: 2, y: height - 11, text: attributionText, font });

        return canvas;
    }

    /* DE: Erzeugt (falls mapImageEnabled aktiv ist) das Einsatzkarten-PNG für lat/lon, schreibt
       es als Datei unter mapImageDir ab und aktualisiert einsatz.kartenbildPfad. Wird von
       handleAlarm() bewusst AWAITED aufgerufen (siehe dortigen Aufruf) - die Alarmverarbeitung
       wartet also auf das fertige Bild, damit kartenbildPfad garantiert schon den richtigen
       Wert für den aktuellen Einsatz trägt, sobald die übrigen einsatz.*-Felder (allen voran
       alarmAktiv) gesetzt werden - nicht erst irgendwann später asynchron.
       Um einen einzelnen langsamen/hängenden Kachel-Download trotzdem nicht die gesamte
       Alarmverarbeitung blockieren zu lassen, ist die Wartezeit auf this.mapImageTimeoutSeconds
       (Admin-Feld "OSM-Timeout", 1-60s) begrenzt: Wird das Bild nicht rechtzeitig fertig, wird
       eine Warnung geloggt, einsatz.kartenbildPfad bleibt/wird leer (null), und die Funktion
       kehrt zurück - die eigentliche Erzeugung läuft im Hintergrund weiter (Kacheln sind
       bereits angefragt), ihr Ergebnis wird aber verworfen (nicht mehr nach kartenbildPfad
       geschrieben), damit sie nicht verspätet einen inzwischen neueren/anderen Einsatz
       überschreibt. Fängt alle Fehler (inkl. Timeout) selbst ab, statt sie an den wartenden
       Aufrufer durchzureichen - ein misslungenes Kartenbild soll die Alarmverarbeitung selbst
       nie zum Absturz bringen.
       EN: Generates (if mapImageEnabled is on) the incident map PNG for lat/lon, writes it as
       a file under mapImageDir and updates einsatz.kartenbildPfad. Deliberately called AWAITED
       from handleAlarm() (see that call site) - alarm processing waits for the finished image,
       so kartenbildPfad is guaranteed to already hold the correct value for the current
       incident by the time the rest of the einsatz.* fields (most importantly alarmAktiv) get
       set, rather than only catching up asynchronously at some later point.
       To still keep a single slow/hanging tile download from blocking the entire alarm
       processing, the wait is capped at this.mapImageTimeoutSeconds (Admin field "OSM
       timeout", 1-60s): if the image doesn't finish in time, a warning is logged,
       einsatz.kartenbildPfad stays/becomes empty (null), and the function returns - the actual
       generation keeps running in the background (tiles are already in flight), but its result
       is discarded (never written to kartenbildPfad) so it can't later overwrite a by-then
       newer/different incident. Catches all errors (including the timeout) itself instead of
       passing them up to the waiting caller - a failed map image should never crash alarm
       processing itself. */
    async generateEinsatzMapImage(lat, lon, geometry) {
        if (!this.mapImageEnabled) {
            return;
        }
        // DE: Fragment schon vor dem eigentlichen Erzeugen einfrieren - currentEinsatzUuid
        // könnte sich ändern, falls die Erzeugung durch den Timeout unten im Hintergrund
        // weiterläuft und erst nach einem inzwischen neuen Einsatz fertig wird.
        // EN: Freeze the fragment before the actual generation - currentEinsatzUuid could
        // change if generation keeps running in the background past the timeout below and
        // only finishes after a by-then new incident.
        const uuidFragment = (this.currentEinsatzUuid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'na';
        const work = (async () => {
            await fsPromises.mkdir(this.mapImageDir, { recursive: true });
            const image = await this.buildEinsatzMapImage(lat, lon, geometry);
            // DE: Dateiname mit Zeitstempel-Präfix (sortierbar für pruneMapImages()) und den
            // ersten 8 Zeichen der Einsatz-UUID (Debugging-Hilfe, keine Eindeutigkeitsgarantie -
            // Date.now() allein reicht dafür bereits aus, da Einsätze nicht im Millisekundentakt
            // eintreffen).
            // EN: Filename with a timestamp prefix (sortable for pruneMapImages()) and the
            // first 8 characters of the incident UUID (debugging aid, not a uniqueness
            // guarantee - Date.now() alone is already sufficient for that, since incidents
            // don't arrive at millisecond intervals).
            const filename = `einsatz_${Date.now()}_${uuidFragment}.png`;
            const filePath = path.join(this.mapImageDir, filename);
            await image.write(filePath);
            return filePath;
        })();

        let timedOut = false;
        let timeoutHandle;
        const timeout = new Promise(resolve => {
            timeoutHandle = this.setTimeout(() => {
                timedOut = true;
                resolve();
            }, this.mapImageTimeoutSeconds * 1000);
        });

        let filePath;
        try {
            filePath = await Promise.race([work, timeout]);
        } catch (e) {
            this.clearTimeout(timeoutHandle);
            this.safeWarn('generateEinsatzMapImage', e);
            try {
                await this.setStateAsync('einsatz.kartenbildPfad', null, true);
            } catch (e2) {
                this.safeWarn('einsatz.kartenbildPfad.setState', e2);
            }
            return;
        }
        this.clearTimeout(timeoutHandle);

        if (timedOut) {
            this.safeWarn(
                'generateEinsatzMapImage.timeout',
                `image was not ready within the configured OSM timeout of ${this.mapImageTimeoutSeconds}s - leaving einsatz.kartenbildPfad empty for this incident`,
            );
            try {
                await this.setStateAsync('einsatz.kartenbildPfad', null, true);
            } catch (e) {
                this.safeWarn('einsatz.kartenbildPfad.setState', e);
            }
            // DE: Ergebnis der im Hintergrund weiterlaufenden Erzeugung bewusst verwerfen (siehe
            // Funktionskommentar) - nur noch aufräumen, falls sie doch noch fertig wird, aber
            // nicht mehr nach kartenbildPfad schreiben.
            // EN: Deliberately discard the result of the still-running background generation
            // (see function comment) - only still clean up if it does finish, but no longer
            // write to kartenbildPfad.
            work.then(() => this.pruneMapImages().catch(e => this.safeWarn('pruneMapImages', e))).catch(() => {
                /* already logged inside buildEinsatzMapImage's own per-tile handling, or
                   irrelevant now that the result is discarded */
            });
            return;
        }

        try {
            await this.setStateAsync('einsatz.kartenbildPfad', filePath, true);
            await this.pruneMapImages();
        } catch (e) {
            this.safeWarn('einsatz.kartenbildPfad.setState', e);
        }
    }

    /* DE: Löscht die ältesten Einsatzkarten-PNGs in mapImageDir, bis nur noch
       MAP_IMAGE_RETENTION_COUNT übrig sind. Sortierung über den Zeitstempel-Präfix im
       Dateinamen (siehe generateEinsatzMapImage()) statt über mtime - unabhängig davon, ob
       das Dateisystem mtime zuverlässig/mit ausreichender Auflösung führt.
       EN: Deletes the oldest incident-map PNGs in mapImageDir until only
       MAP_IMAGE_RETENTION_COUNT remain. Sorts by the timestamp prefix in the filename (see
       generateEinsatzMapImage()) rather than mtime - independent of whether the
       filesystem tracks mtime reliably/with sufficient resolution. */
    async pruneMapImages() {
        try {
            const entries = await fsPromises.readdir(this.mapImageDir);
            const mapFiles = entries.filter(f => f.startsWith('einsatz_') && f.endsWith('.png')).sort();
            const excess = mapFiles.length - MAP_IMAGE_RETENTION_COUNT;
            if (excess <= 0) {
                return;
            }
            const toDelete = mapFiles.slice(0, excess);
            await Promise.all(
                toDelete.map(f =>
                    fsPromises
                        .unlink(path.join(this.mapImageDir, f))
                        .catch(e => this.safeWarn(`pruneMapImages ${f}`, e)),
                ),
            );
        } catch (e) {
            this.safeWarn('pruneMapImages', e);
        }
    }

    /* DE: Extrahiert aus einem Einsatz-Snapshot nur die flachen Einsatzstamm-Felder
       (ALLOWED_EINSATZ_FIELDS + lat/lon aus position), ergänzt um den zum Aufrufzeitpunkt
       registrierten Monitor - ohne routen/rueckmeldungen/emAlarmiert/emWeitere. Gemeinsam
       genutzt von persistEinsatzSnapshot() (einsatz.json.current) und
       pushEinsatzToHistory() (einsatz.json.history10), damit beide garantiert dasselbe
       Schema haben. registeredMonitor/registeredMonitorName machen bei history10
       nachvollziehbar, auf welchen Monitor der Adapter zum Zeitpunkt des jeweiligen
       Einsatzes konfiguriert war (kann sich über die Zeit ändern) - bei current sind sie
       redundant zu status.registeredMonitor/.registeredMonitorName, aber harmlos, da
       beide Schemas identisch bleiben sollen.
       EN: Extracts only the flat incident-master fields (ALLOWED_EINSATZ_FIELDS + lat/lon
       from position) from an incident snapshot, adding the monitor registered at call
       time - without routen/rueckmeldungen/emAlarmiert/emWeitere. Shared by
       persistEinsatzSnapshot() (einsatz.json.current) and pushEinsatzToHistory()
       (einsatz.json.history10) so both are guaranteed to have the same schema.
       registeredMonitor/registeredMonitorName let history10 entries show which monitor
       the adapter was configured for at the time of that incident (can change over time) -
       for current they're redundant with status.registeredMonitor/.registeredMonitorName,
       but harmless, since both schemas should stay identical. */
    buildFlatEinsatzJson(snapshot) {
        const src = snapshot || {};
        const flat = {};
        for (const k of this.ALLOWED_EINSATZ_FIELDS) {
            flat[k] = Object.prototype.hasOwnProperty.call(src, k) ? src[k] : null;
        }
        flat.lat = src.position && typeof src.position.lat === 'number' ? src.position.lat : null;
        flat.lon = src.position && typeof src.position.lon === 'number' ? src.position.lon : null;
        // DE: beschreibung kommt nicht vom Server (daher nicht in ALLOWED_EINSATZ_FIELDS),
        // sondern wird von handleAlarm() lokal ermittelt und im Snapshot mitgeführt (siehe
        // lookupStichwortBeschreibung()).
        // EN: beschreibung doesn't come from the server (hence not in ALLOWED_EINSATZ_FIELDS),
        // but is determined locally by handleAlarm() and carried along in the snapshot (see
        // lookupStichwortBeschreibung()).
        flat.beschreibung = Object.prototype.hasOwnProperty.call(src, 'beschreibung') ? src.beschreibung : null;
        // DE: alarmierungszeit kommt vom Server als "zeitstempel" und wird ebenfalls als
        // Sonderfall im Snapshot mitgeführt (siehe handleAlarm()), da der State-Name vom
        // Server-Feldnamen abweicht - daher nicht in ALLOWED_EINSATZ_FIELDS.
        // EN: alarmierungszeit comes from the server as "zeitstempel" and is likewise
        // carried along in the snapshot as a special case (see handleAlarm()), since the
        // state name differs from the server's field name - hence not in
        // ALLOWED_EINSATZ_FIELDS.
        flat.alarmierungszeit = Object.prototype.hasOwnProperty.call(src, 'alarmierungszeit')
            ? src.alarmierungszeit
            : null;
        flat.registeredMonitor = this.currentMonitor || null;
        flat.registeredMonitorName = this.monitorName || null;
        return flat;
    }

    /* DE: Löst eine vom Server per io.playtts gesendete TTS-URL zu einer vollständigen absoluten
       URL auf. Bereits absolute URLs (http(s)://...) bleiben unverändert, relative Pfade
       (z.B. "/tts/xyz.mp3") werden mit der konfigurierten WAIP-Server-URL zusammengesetzt.
       EN: Resolves a TTS URL sent by the server via io.playtts to a full absolute URL.
       Already-absolute URLs (http(s)://...) are left unchanged, relative paths (e.g.
       "/tts/xyz.mp3") are combined with the configured WAIP server URL. */
    resolveTtsUrl(raw) {
        if (typeof raw !== 'string' || !raw) {
            return raw;
        }
        if (/^https?:\/\//i.test(raw)) {
            return raw;
        }
        const base = (this.url || '').replace(/\/+$/, '');
        const path = raw.startsWith('/') ? raw : `/${raw}`;
        return `${base}${path}`;
    }

    /* DE: Prüft ob eine eingehende Payload eindeutig einem Monitor zuordenbar ist und mit currentMonitor übereinstimmt.
       EN: Checks whether an incoming payload can be unambiguously attributed to a monitor and matches currentMonitor. */
    payloadMonitorMatch(p) {
        if (!p || typeof p !== 'object') {
            return null;
        }
        // DE: wache_nr/wache_id/wacheId bewusst NICHT hier: server/waip.js sendet io.new_rmld-
        // Events mit einem realen "wache_nr"-Feld (Wachennummer der zurückmeldenden Einsatz-
        // kraft aus der waip_rueckmeldungen-Tabelle) - das hat nichts mit der Monitor-/
        // Leitstellen-ID zu tun, wurde hier aber fälschlich so behandelt und hat dadurch
        // praktisch jede Rückmeldung als "falscher Monitor" verworfen, sobald die
        // Wachennummer von der registrierten Monitor-ID abwich (0.7.19 gefunden/behoben).
        // wache_id/wacheId kommen in keiner geprüften Server-Tabelle (waip_einsaetze,
        // waip_rueckmeldungen, Routen) überhaupt vor - ebenso unbegründete Kandidaten mit
        // demselben Kollisionsrisiko, daher ebenfalls entfernt.
        // EN: wache_nr/wache_id/wacheId deliberately NOT here: server/waip.js sends
        // io.new_rmld events with a real "wache_nr" field (the responding unit's station
        // number, from the waip_rueckmeldungen table) - that has nothing to do with the
        // monitor/dispatch-center ID, but was mistakenly treated as if it did, which
        // caused practically every feedback event to be discarded as "wrong monitor"
        // whenever the station number differed from the registered monitor ID (found/fixed
        // in 0.7.19). wache_id/wacheId don't appear in any checked server table
        // (waip_einsaetze, waip_rueckmeldungen, routes) at all - equally unfounded
        // candidates with the same collision risk, hence also removed.
        const keys = [
            'monitor',
            'monitorID',
            'monitor_id',
            'monitorId',
            'waip_monitor',
            'waip_monitor_id',
            'room',
            'tenant',
            'group',
        ];
        for (const k of keys) {
            if (p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== '') {
                const val = String(p[k]).trim();
                if (val === String(this.currentMonitor)) {
                    return true;
                }
                if (
                    !isNaN(Number(val)) &&
                    !isNaN(Number(this.currentMonitor)) &&
                    Number(val) === Number(this.currentMonitor)
                ) {
                    return true;
                }
                return false;
            }
        }
        return null; // DE: kein Monitor-Kennungsfeld gefunden / EN: no monitor-identifying field found
    }

    /*
     DE: Handler-Wrapper: prüft Monitor-Match bevor der eigentliche Handler ausgeführt wird.

     WICHTIG (siehe client_waip.js des offiziellen Frontends): Die Monitor-Zuordnung
     passiert vollständig serverseitig über eine Socket.IO-Room-Registrierung
     (ausgelöst durch emit('WAIP', monitorId) in onSocketConnect). Kein einziges
     reales Event (io.new_waip/io.new_rmld/io.routes/io.playtts/io.standby) trägt ein
     eigenes Monitor-Kennungsfeld im Payload - das offizielle Frontend prüft beim
     Empfang auch gar nichts. payloadMonitorMatch() liefert für reale Payloads daher
     praktisch immer null.

     Frühere Version verwarf Events ohne Monitor-Feld nach Ablauf des Registrierungs-
     Timeouts als "unknownMonitor" - das hat bei jeder nicht-globalen Monitor-ID (≠ '0')
     die komplette Alarm-Zustellung nach dem Timeout stillschweigend gestoppt. Jetzt
     gilt: jedes empfangene Event bestätigt die Registrierung und wird verarbeitet,
     außer das Payload nennt EXPLIZIT eine andere Monitor-Kennung (match === false).

     EN: Handler wrapper: checks the monitor match before the actual handler runs.

     IMPORTANT (see the official frontend's client_waip.js): Monitor attribution happens
     entirely server-side via a Socket.IO room registration (triggered by
     emit('WAIP', monitorId) in onSocketConnect). Not a single real event
     (io.new_waip/io.new_rmld/io.routes/io.playtts/io.standby) carries its own
     monitor-identifying field in the payload - the official frontend doesn't check
     anything on receipt either. payloadMonitorMatch() therefore practically always
     returns null for real payloads.

     An earlier version discarded events without a monitor field as "unknownMonitor"
     once the registration timeout expired - for every non-global monitor ID (≠ '0')
     this silently stopped all alarm delivery after the timeout. Now: every received
     event confirms the registration and gets processed, unless the payload EXPLICITLY
     names a different monitor identifier (match === false).
    */
    wrapHandlerWithMonitorCheck(handler) {
        return payload => {
            try {
                const match = this.payloadMonitorMatch(payload);

                if (match === false) {
                    // DE: Reine, erwartete Filterlogik (kein Fehler) - Häufigkeit ist über
                    // debug.ignoredCount messbar; checkWrongMonitorRate() eskaliert bei
                    // dauerhaft hoher Anzahl auf warn (Hinweis auf falsch konfigurierte
                    // Monitor-ID), bleibt sonst bei info.
                    // EN: Plain, expected filtering logic (not an error) - frequency is
                    // measurable via debug.ignoredCount; checkWrongMonitorRate() escalates to
                    // warn when the count stays persistently high (a hint at a misconfigured
                    // monitor ID), otherwise stays at info.
                    this.safeLog(
                        'info',
                        'ignoredEvent.wrongMonitor',
                        `Received an event for a different monitor (current=${this.currentMonitor})`,
                    );
                    this.incrementIgnoredCount();
                    this.checkWrongMonitorRate();
                    return;
                }

                // DE: match === true (Monitor-Feld passt) oder match === null (kein
                // Monitor-Feld im Payload, der Normalfall) -> Registrierung bestätigt.
                // EN: match === true (monitor field matches) or match === null (no monitor
                // field in the payload, the normal case) -> registration confirmed.
                if (this.registrationPending || match === true) {
                    this.setState('status.registrationAccepted', true, true);
                    this.setState('status.registeredMonitor', this.currentMonitor, true);
                    if (this.registrationTimer) {
                        this.clearTimeout(this.registrationTimer);
                        this.registrationTimer = null;
                    }
                    this.registrationPending = false;
                    this.setState('status.registrationPending', false, true);
                    this.logRecovered('registration', 'WAIP registration recovered');
                }

                try {
                    handler(payload);
                } catch (e) {
                    // DE: Ein empfangenes Event konnte nicht verarbeitet werden -> echter
                    // Datenverlust, daher error statt warn.
                    // EN: A received event couldn't be processed -> actual data loss, hence
                    // error instead of warn.
                    this.safeLog('error', 'handler.exec', e);
                }
            } catch (e) {
                this.safeLog('error', 'wrapHandlerWithMonitorCheck', e);
            }
        };
    }

    /* DE: Schreibt this.currentEinsatzSnapshot komplett (inkl. verschachtelter Arrays) nach einsatz.json.
       EN: Writes this.currentEinsatzSnapshot in full (including nested arrays) to einsatz.json. */
    async persistEinsatzSnapshot() {
        try {
            const flat = this.buildFlatEinsatzJson(this.currentEinsatzSnapshot);
            // DE: Als Array mit einem Element speichern (nicht das nackte Objekt) - VIS-Tabellen-
            // Widgets erwarten am Root immer ein Array, sonst liefern sie keine Zeile.
            // EN: Store as an array with one element (not the bare object) - VIS table widgets
            // always expect an array at the root, otherwise they render no row.
            await this.setStateAsync('einsatz.json.current', JSON.stringify([flat]), true);
        } catch (e) {
            this.safeWarn('persistEinsatzSnapshot', e);
        }
    }

    /* DE: Legt den aktuellen Einsatz-Snapshot als abgeschlossenen Eintrag vorne in einsatz.json.history10 ab
       (z.B. bei io.standby oder wenn ein neuer Einsatz beginnt, ohne dass zuvor io.standby kam).
       Dedupliziert über die uuid, damit derselbe Einsatz nicht doppelt eingetragen wird, falls
       sowohl io.standby als auch der nächste io.new_waip diese Methode auslösen.
       snapshot ist optional: finalizeCurrentEinsatz() übergibt ihn explizit, weil es
       this.currentEinsatzSnapshot bereits vor dem ersten await genullt hat (siehe dort);
       ohne Argument wird wie bisher der aktuelle Snapshot verwendet.
       EN: Records the current incident snapshot as a completed entry at the front of
       einsatz.json.history10 (e.g. on io.standby, or when a new incident starts without a
       preceding io.standby). Deduplicates by uuid so the same incident isn't recorded twice
       if both io.standby and the next io.new_waip trigger this method.
       snapshot is optional: finalizeCurrentEinsatz() passes it explicitly because it has
       already nulled this.currentEinsatzSnapshot before its first await (see there);
       without an argument the current snapshot is used as before. */
    async pushEinsatzToHistory(snapshot) {
        try {
            const src = snapshot !== undefined ? snapshot : this.currentEinsatzSnapshot;
            if (!src || !src.uuid) {
                return;
            }
            const st = await this.getStateAsync('einsatz.json.history10');
            let arr = [];
            try {
                arr = st && st.val ? JSON.parse(st.val) : [];
            } catch {
                arr = [];
            }
            if (arr.length && arr[0] && arr[0].uuid === src.uuid) {
                return;
            }
            // DE: Nur den flachen Einsatzstamm archivieren - Routen/Rückmeldungen/Alarmierungen
            // gelten nur für den jeweils aktuellen Einsatz und werden nicht historisiert.
            // EN: Only archive the flat incident master data - routes/feedback/alerting only
            // apply to the current incident and aren't kept in history.
            arr.unshift(this.buildFlatEinsatzJson(src));
            if (arr.length > this.HISTORY_SIZE) {
                arr = arr.slice(0, this.HISTORY_SIZE);
            }
            await this.setStateAsync('einsatz.json.history10', JSON.stringify(arr), true);
        } catch (e) {
            this.safeWarn('pushEinsatzToHistory', e);
        }
    }

    /* DE: Berechnet aus den im Snapshot gesammelten Rückmeldungen die Zähler pro Rolle/Fähigkeit
       (analog zu den Badges EK/GF/ZF/VF/AGT/FZF/MA/MED/Gesamt der Weboberfläche) und
       aktualisiert einsatz.rueckmeldungen.rollen.<k> und .funktionen.<k> sowie
       einsatz.rueckmeldungenGesamt. EK/GF/ZF/VF (aus rmld_role) liegen unter .rollen, AGT/FZF/MA/
       MED (aus den rmld_capability_*-Flags) unter .funktionen.
       EN: Computes the per-role/skill counters from the feedback entries collected in the
       snapshot (mirroring the EK/GF/ZF/VF/AGT/FZF/MA/MED/total badges of the web UI) and
       updates einsatz.rueckmeldungen.rollen.<k> and .funktionen.<k> as well as
       einsatz.rueckmeldungenGesamt. EK/GF/ZF/VF (from rmld_role) live under .rollen, AGT/FZF/MA/
       MED (from the rmld_capability_* flags) under .funktionen. */
    async updateRueckmeldungCounts() {
        const list = (this.currentEinsatzSnapshot && this.currentEinsatzSnapshot.rueckmeldungen) || [];
        const counts = { ek: 0, gf: 0, zf: 0, vf: 0, agt: 0, fzf: 0, ma: 0, med: 0 };
        for (const r of list) {
            if (r.rmld_role === 'team_member') {
                counts.ek++;
            } else if (r.rmld_role === 'crew_leader') {
                counts.gf++;
            } else if (r.rmld_role === 'division_chief') {
                counts.zf++;
            } else if (r.rmld_role === 'group_commander') {
                counts.vf++;
            }
            if (Number(r.rmld_capability_agt) > 0) {
                counts.agt++;
            }
            if (Number(r.rmld_capability_fzf) > 0) {
                counts.fzf++;
            }
            if (Number(r.rmld_capability_ma) > 0) {
                counts.ma++;
            }
            if (Number(r.rmld_capability_med) > 0) {
                counts.med++;
            }
        }
        const tasks = [
            ...RUECKMELDUNG_ROLLEN_KEYS.map(k =>
                this.setStateAsync(`einsatz.rueckmeldungen.rollen.${k}`, counts[k], true),
            ),
            ...RUECKMELDUNG_FUNKTIONEN_KEYS.map(k =>
                this.setStateAsync(`einsatz.rueckmeldungen.funktionen.${k}`, counts[k], true),
            ),
        ];
        tasks.push(this.setStateAsync('einsatz.rueckmeldungenGesamt', list.length, true));
        const results = await Promise.allSettled(tasks);
        for (const r of results) {
            if (r.status === 'rejected') {
                this.safeWarn('updateRueckmeldungCounts', r.reason);
            }
        }
    }

    /* DE: Handler für eingehende Alarme (io.new_waip). Ignoriert Rettungsdienst-Einsätze
       komplett (kein State-Update, keine History, kein TTS), wenn rdAlarmierungEnabled
       deaktiviert ist - siehe isRettungsdienstEinsatz() und den "Rettungsdienst
       verarbeiten"-Haken auf dem Rettungsdienst-Tab. Der Check läuft VOR jedem State-Write
       (auch vor debug.rawPayloadShort), damit "komplett ignoriert" auch wirklich stimmt.
       EN: Handler for incoming alarms (io.new_waip). Completely ignores rescue-service
       incidents (no state update, no history, no TTS) when rdAlarmierungEnabled is
       disabled - see isRettungsdienstEinsatz() and the "Process rescue-service
       incidents" checkbox on the Rescue service tab. The check runs BEFORE any state
       write (even debug.rawPayloadShort), so "completely ignored" actually holds true. */
    async handleAlarm(incoming) {
        if (!this.rdAlarmierungEnabled && isRettungsdienstEinsatz(incoming && incoming.einsatzart)) {
            this.log.debug(
                `Ignoring rescue-service incident (einsatzart="${incoming && incoming.einsatzart}") - rdAlarmierungEnabled is disabled`,
            );
            return;
        }
        try {
            try {
                await this.setStateAsync('debug.rawPayloadShort', JSON.stringify(incoming).slice(0, 500), true);
            } catch {
                /* ignore */
            }

            const data = normalizeData(incoming || {});
            try {
                // DE: Flach halten (lat/lon statt eines verschachtelten position-Objekts) und als
                // Array mit einem Element speichern (nicht das nackte Objekt) - VIS-Tabellen-
                // Widgets erwarten am Root immer ein Array, sonst liefern sie keine Zeile.
                // EN: Keep it flat (lat/lon instead of a nested position object) and store as
                // an array with one element (not the bare object) - VIS table widgets always
                // expect an array at the root, otherwise they render no row.
                await this.setStateAsync(
                    'debug.normalizedPosition',
                    JSON.stringify([
                        {
                            lat: data.position && typeof data.position.lat === 'number' ? data.position.lat : null,
                            lon: data.position && typeof data.position.lon === 'number' ? data.position.lon : null,
                        },
                    ]),
                    true,
                );
            } catch {
                /* ignore */
            }

            // DE: Neuer Einsatz (andere uuid als der aktuell verfolgte) -> vorherigen Snapshot (falls
            // noch nicht per io.standby archiviert) sichern und mit leeren Listen neu beginnen.
            // Bei einer bloßen Aktualisierung desselben Einsatzes (gleiche uuid, z.B. Korrektur
            // der Besonderheiten) bleiben bereits erfasste Routen/Rückmeldungen bewusst erhalten -
            // anders als die Live-Webseite, die bei JEDEM io.new_waip zurücksetzt.
            // EN: New incident (different uuid than the one currently tracked) -> save the
            // previous snapshot (if not already archived via io.standby) and start over with
            // empty lists. For a mere update of the same incident (same uuid, e.g. a
            // correction to the special remarks), already-captured routes/feedback are
            // deliberately kept - unlike the live website, which resets on EVERY io.new_waip.
            const isNewEinsatz = data.uuid && data.uuid !== this.currentEinsatzUuid;
            if (isNewEinsatz) {
                await this.pushEinsatzToHistory();
                this.currentEinsatzUuid = data.uuid;
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
                // DE: Sofort leeren statt auf das nächste io.routes/io.new_rmld für den neuen
                // Einsatz zu warten - sonst zeigen diese States/Zähler bis dahin noch die
                // Routen/Rückmeldungen des alten Einsatzes (z.B. relevant, wenn zwischen
                // beiden Einsätzen ein io.standby verpasst wurde). einsatz.json.current und
                // .emAlarmiert/.emWeitere werden weiter unten in dieser Methode ohnehin
                // unbedingt neu geschrieben, brauchen hier keine gesonderte Behandlung.
                // EN: Clear immediately instead of waiting for the next io.routes/io.new_rmld
                // for the new incident - otherwise these states/counters would still show the
                // old incident's routes/feedback until then (e.g. relevant if an io.standby
                // was missed between the two incidents). einsatz.json.current and
                // .emAlarmiert/.emWeitere get unconditionally rewritten further down in this
                // method anyway, so they need no special handling here.
                await this.writeJsonArrayState('einsatz.json.routen', []);
                await this.writeJsonArrayState('einsatz.json.rueckmeldungen', []);
                try {
                    await this.setStateAsync('einsatz.routenGesamt', 0, true);
                } catch (e) {
                    this.safeWarn('einsatz.routenGesamt.setState', e);
                }
                await this.updateRueckmeldungCounts();
                // DE: kartenbildPfad ebenfalls sofort leeren, statt auf generateEinsatzMapImage()
                // weiter unten zu warten - sonst könnte er für den neuen Einsatz kurzzeitig (oder,
                // falls keine gültigen Koordinaten vorliegen bzw. mapImageEnabled aus ist, sogar
                // dauerhaft) noch den Bildpfad des VORHERIGEN Einsatzes zeigen, obwohl alarmAktiv
                // bereits für den neuen Einsatz gesetzt wird.
                // EN: Also clear kartenbildPfad immediately instead of waiting for
                // generateEinsatzMapImage() further down - otherwise it could briefly (or, if no
                // valid coordinates are present or mapImageEnabled is off, even permanently) still
                // show the PREVIOUS incident's image path for the new incident, even though
                // alarmAktiv is already being set for the new one.
                try {
                    await this.setStateAsync('einsatz.kartenbildPfad', null, true);
                } catch (e) {
                    this.safeWarn('einsatz.kartenbildPfad.setState', e);
                }
            } else if (!this.currentEinsatzSnapshot) {
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
            }

            let lat = null;
            let lon = null;
            if (data.position && data.position.lat !== undefined && data.position.lon !== undefined) {
                lat = Number(data.position.lat);
                lon = Number(data.position.lon);
            }

            if (lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon)) {
                try {
                    await this.setStateAsync('einsatz.latitude', lat, true);
                } catch (e) {
                    this.safeWarn('einsatz.latitude.setState', e);
                }
                try {
                    await this.setStateAsync('einsatz.longitude', lon, true);
                } catch (e) {
                    this.safeWarn('einsatz.longitude.setState', e);
                }
                this.currentEinsatzSnapshot.position = { lat, lon };
                // DE: Rohe (nicht von normalizeData() bereinigte) geometry aus incoming
                // entnehmen - normalizeData() löscht data.geometry nach der Positions-
                // Ermittlung, buildEinsatzMapImage() braucht aber die vollen Polygon-Daten,
                // nicht nur den daraus abgeleiteten Mittelpunkt (siehe extractPolygonRings()).
                // Bewusst AWAITED - die übrigen einsatz.*-Felder (allen voran alarmAktiv gleich
                // im Anschluss) sollen erst gesetzt werden, wenn kartenbildPfad bereits den
                // richtigen Wert für DIESEN Einsatz trägt, statt ihn erst irgendwann später
                // asynchron nachzuliefern. generateEinsatzMapImage() begrenzt die Wartezeit
                // selbst über this.mapImageTimeoutSeconds und fängt alle Fehler ab, blockiert die
                // Alarmverarbeitung also nie unbegrenzt. Kein-op, falls mapImageEnabled
                // deaktiviert ist.
                // EN: Take the raw (not normalizeData()-stripped) geometry from incoming -
                // normalizeData() deletes data.geometry after determining the position, but
                // buildEinsatzMapImage() needs the full polygon data, not just the centroid
                // derived from it (see extractPolygonRings()). Deliberately AWAITED - the rest
                // of the einsatz.* fields (most importantly alarmAktiv right after) should only
                // be set once kartenbildPfad already holds the correct value for THIS incident,
                // instead of catching up asynchronously at some later point.
                // generateEinsatzMapImage() itself caps the wait via
                // this.mapImageTimeoutSeconds and catches all errors, so it never blocks alarm
                // processing indefinitely. No-op if mapImageEnabled is disabled.
                await this.generateEinsatzMapImage(lat, lon, incoming && incoming.geometry);
            } else {
                try {
                    await this.setStateAsync('einsatz.latitude', null, true);
                } catch {
                    /* ignore */
                }
                try {
                    await this.setStateAsync('einsatz.longitude', null, true);
                } catch {
                    /* ignore */
                }
                this.currentEinsatzSnapshot.position = null;
            }

            try {
                await this.setStateAsync('einsatz.alarmAktiv', true, true);
            } catch (e) {
                this.safeWarn('einsatz.alarmAktiv.setState', e);
            }

            // DE: flache Felder setzen und gleichzeitig im Snapshot mitführen
            // EN: set flat fields and carry them along in the snapshot at the same time
            const tasks = [];
            for (const k of this.ALLOWED_EINSATZ_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(data, k)) {
                    this.currentEinsatzSnapshot[k] = data[k];
                    tasks.push(this.setField(`einsatz.${k}`, data[k]));
                }
            }
            if (data.em_alarmiert !== undefined) {
                this.currentEinsatzSnapshot.emAlarmiert = data.em_alarmiert;
            }
            if (data.em_weitere !== undefined) {
                this.currentEinsatzSnapshot.emWeitere = data.em_weitere;
            }

            // DE: Server-Feld "zeitstempel" -> State/Snapshot-Feld einsatz.alarmierungszeit -
            // bewusst als Sonderfall behandelt (nicht in ALLOWED_EINSATZ_FIELDS), da der
            // State-Name vom Server-Feldnamen abweicht.
            // EN: Server field "zeitstempel" -> einsatz.alarmierungszeit state/snapshot field -
            // deliberately handled as a special case (not in ALLOWED_EINSATZ_FIELDS), since
            // the state name differs from the server's field name.
            if (Object.prototype.hasOwnProperty.call(data, 'zeitstempel')) {
                this.currentEinsatzSnapshot.alarmierungszeit = data.zeitstempel;
                tasks.push(this.setField('einsatz.alarmierungszeit', data.zeitstempel));
            }

            // DE: Beschreibung zum Stichwort lokal ermitteln (kommt nicht vom Server) und wie die
            // übrigen flachen Felder setzen/im Snapshot mitführen.
            // EN: Determine the keyword's description locally (doesn't come from the server)
            // and set/carry it along like the other flat fields.
            const beschreibung = this.lookupStichwortBeschreibung(this.currentEinsatzSnapshot.stichwort);
            this.currentEinsatzSnapshot.beschreibung = beschreibung;
            tasks.push(this.setField('einsatz.beschreibung', beschreibung));

            const results = await Promise.allSettled(tasks);
            for (const r of results) {
                if (r.status === 'rejected') {
                    this.safeWarn('handleAlarm.setFields', r.reason);
                }
            }

            await this.persistEinsatzSnapshot();
            await this.writeJsonArrayState('einsatz.json.emAlarmiert', this.currentEinsatzSnapshot.emAlarmiert);
            await this.writeJsonArrayState('einsatz.json.emWeitere', this.currentEinsatzSnapshot.emWeitere);
        } catch (e) {
            // DE: Ein Alarm-Event konnte nicht verarbeitet werden -> echter Datenverlust.
            // EN: An alarm event couldn't be processed -> actual data loss.
            this.safeLog('error', 'handleAlarm', e);
        }
    }

    /* DE: Handler für Rückmeldungen (io.new_rmld). Werden im Snapshot des aktuellen Einsatzes
       gesammelt (dedupliziert über rmld_uuid) statt in einem separaten "letzte Rückmeldung"-State.
       EN: Handler for feedback events (io.new_rmld). Collected in the current incident's
       snapshot (deduplicated by rmld_uuid) rather than in a separate "last feedback" state. */
    async handleRueckmeldung(incoming) {
        try {
            const data = normalizeData(incoming || {});

            if (!this.currentEinsatzSnapshot) {
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
            }
            if (!Array.isArray(this.currentEinsatzSnapshot.rueckmeldungen)) {
                this.currentEinsatzSnapshot.rueckmeldungen = [];
            }

            // DE: Rückmeldungen für einen anderen (alten) Einsatz nicht mit aufnehmen.
            // EN: Don't include feedback for a different (old) incident.
            if (data.waip_uuid && this.currentEinsatzUuid && data.waip_uuid !== this.currentEinsatzUuid) {
                this.log.debug(
                    `Ignoring feedback for a different incident ${data.waip_uuid} (current=${this.currentEinsatzUuid})`,
                );
                return;
            }

            const list = this.currentEinsatzSnapshot.rueckmeldungen;
            if (data.rmld_uuid) {
                const idx = list.findIndex(r => r.rmld_uuid === data.rmld_uuid);
                if (idx >= 0) {
                    list[idx] = data;
                } else {
                    list.push(data);
                }
            } else {
                list.push(data);
            }

            await this.persistEinsatzSnapshot();
            await this.writeJsonArrayState('einsatz.json.rueckmeldungen', this.currentEinsatzSnapshot.rueckmeldungen);
            await this.updateRueckmeldungCounts();
        } catch (e) {
            // DE: Eine Rückmeldung konnte nicht verarbeitet werden -> echter Datenverlust.
            // EN: A feedback event couldn't be processed -> actual data loss.
            this.safeLog('error', 'handleRueckmeldung', e);
        }
    }

    /* DE: Handler für Standby (io.standby) - Einsatz beendet / Monitor im Ruhezustand.
       Analog zum offiziellen Frontend (client_waip.js leert dabei Stichwort, Ortsdaten,
       Besonderheiten etc. und setzt die Karte zurück): der abgeschlossene Einsatz wird
       zuerst archiviert (einsatz.json.history10), danach werden alle auf den aktuellen Einsatz
       bezogenen States geleert - so bleibt alarmAktiv ein verlässlicher Schalter dafür, ob
       einsatz.* gerade echte Live-Daten enthält, statt still den letzten (beendeten)
       Einsatz weiter anzuzeigen.
       EN: Handler for standby (io.standby) - incident ended / monitor idle. Mirroring the
       official frontend (client_waip.js clears keyword, location data, special remarks etc.
       and resets the map in this case): the completed incident is archived first
       (einsatz.json.history10), then all states related to the current incident are cleared -
       that way alarmAktiv stays a reliable switch for whether einsatz.* currently holds real
       live data, instead of silently continuing to show the last (finished) incident. */
    /* DE: Schließt den aktuellen Einsatz ab: alarmAktiv=false, Archivierung nach
       einsatz.json.history10, Leeren aller einsatz.*-States. Gemeinsam genutzt von einem
       echten io.standby (handleStandby()) und vom Watchdog in restzeitInterval, falls
       io.standby verpasst wurde (siehe dort).
       EN: Concludes the current incident: alarmAktiv=false, archival to
       einsatz.json.history10, clearing of all einsatz.* states. Shared by a real io.standby
       (handleStandby()) and the watchdog in restzeitInterval in case io.standby was missed
       (see there). */
    async finalizeCurrentEinsatz() {
        // DE: currentEinsatzUuid/-Snapshot SOFORT nullen, bevor der erste await läuft.
        // handleRoutes()/handleTTS() prüfen genau diese Felder, um verspätete Events nach
        // einem io.standby zu verwerfen (siehe dort). Würden sie erst am Ende von
        // clearCurrentEinsatzStates() genullt, könnte die Event-Loop während der awaits
        // unten ein wartendes io.routes verarbeiten: dessen Guard sähe die uuid noch als
        // gesetzt, ließe das Event passieren und schriebe einsatz.json.current/.routen
        // womöglich NACH den Leer-Writes - also genau das Symptom, gegen das der Guard
        // eingeführt wurde.
        // Der Snapshot wird vorher in eine lokale Variable gerettet, da
        // pushEinsatzToHistory() ihn zum Archivieren noch braucht.
        // EN: Null currentEinsatzUuid/snapshot IMMEDIATELY, before the first await.
        // handleRoutes()/handleTTS() check exactly these fields to discard late events
        // after an io.standby (see there). If they were only nulled at the end of
        // clearCurrentEinsatzStates(), the event loop could process a pending io.routes
        // during the awaits below: its guard would still see the uuid as set, let the
        // event through, and possibly write einsatz.json.current/.routen AFTER the
        // clearing writes - exactly the symptom the guard was introduced against.
        // The snapshot is saved into a local first, since pushEinsatzToHistory() still
        // needs it for archiving.
        const snapshot = this.currentEinsatzSnapshot;
        this.currentEinsatzUuid = null;
        this.currentEinsatzSnapshot = null;

        try {
            await this.setStateAsync('einsatz.alarmAktiv', false, true);
        } catch (e) {
            this.safeWarn('einsatz.alarmAktiv.setState', e);
        }
        await this.pushEinsatzToHistory(snapshot);
        await this.clearCurrentEinsatzStates();
        this._restzeitZeroSince = null;
    }

    async handleStandby() {
        try {
            this.log.info('Standby received - incident ended, or monitor idle');
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'standby' }).catch(() => {});
            await this.finalizeCurrentEinsatz();
        } catch (e) {
            // DE: Standby konnte nicht verarbeitet werden -> Historie/States ggf. inkonsistent.
            // EN: Standby couldn't be processed -> history/states may be inconsistent.
            this.safeLog('error', 'handleStandby', e);
        }
    }

    /* DE: Leert alle States, die sich auf den aktuellen (jetzt beendeten) Einsatz beziehen -
       flache einsatz.*-Felder, einsatz.json.current/.routen/.rueckmeldungen/.emAlarmiert/
       .emWeitere sowie alle abgeleiteten Zähler. Wird nach pushEinsatzToHistory() aufgerufen,
       der abgeschlossene Einsatz bleibt also weiterhin über einsatz.json.history10 abrufbar.
       EN: Clears all states related to the current (now finished) incident - flat einsatz.*
       fields, einsatz.json.current/.routen/.rueckmeldungen/.emAlarmiert/.emWeitere, and all
       derived counters. Called after pushEinsatzToHistory(), so the completed incident
       remains retrievable via einsatz.json.history10. */
    async clearCurrentEinsatzStates() {
        const tasks = this.ALLOWED_EINSATZ_FIELDS.map(k => this.setStateAsync(`einsatz.${k}`, null, true));
        tasks.push(this.setStateAsync('einsatz.beschreibung', null, true));
        // DE: alarmierungszeit ist wie beschreibung ein Sonderfall (nicht in
        // ALLOWED_EINSATZ_FIELDS, siehe handleAlarm()) und muss daher hier separat geleert
        // werden.
        // EN: alarmierungszeit is a special case like beschreibung (not in
        // ALLOWED_EINSATZ_FIELDS, see handleAlarm()), so it needs to be cleared separately
        // here.
        tasks.push(this.setStateAsync('einsatz.alarmierungszeit', null, true));
        tasks.push(this.setStateAsync('einsatz.latitude', null, true));
        tasks.push(this.setStateAsync('einsatz.longitude', null, true));
        // DE: Anders als einsatz.tts.last (dessen Vorbild ursprünglich für kartenbildPfad
        // übernommen wurde) wird kartenbildPfad jetzt doch wie die übrigen einsatz.*-Felder
        // geleert - kein Alarm aktiv soll auch bedeuten, dass kein Kartenbild mehr referenziert
        // wird.
        // EN: Unlike einsatz.tts.last (whose pattern was originally borrowed for
        // kartenbildPfad), kartenbildPfad is now cleared like the other einsatz.* fields
        // after all - no active alarm should also mean no map image is referenced anymore.
        tasks.push(this.setStateAsync('einsatz.kartenbildPfad', null, true));
        tasks.push(this.writeJsonArrayState('einsatz.json.current', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.routen', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.rueckmeldungen', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.emAlarmiert', []));
        tasks.push(this.writeJsonArrayState('einsatz.json.emWeitere', []));
        tasks.push(this.setStateAsync('einsatz.routenGesamt', 0, true));
        const results = await Promise.allSettled(tasks);
        for (const r of results) {
            if (r.status === 'rejected') {
                this.safeWarn('clearCurrentEinsatzStates', r.reason);
            }
        }

        this.currentEinsatzUuid = null;
        this.currentEinsatzSnapshot = null;
        // DE: Defensiv erneut genullt. finalizeCurrentEinsatz() - der einzige Aufrufer -
        // erledigt das bereits vor seinem ersten await (dort steht die Begründung; das ist
        // die eigentlich wirksame Stelle gegen verspätete Events). Hier bleibt es stehen,
        // damit die Methode auch bei einem künftigen zweiten Aufrufer für sich genommen
        // einen konsistenten Zustand hinterlässt.
        // EN: Defensively nulled again. finalizeCurrentEinsatz() - the only caller -
        // already does this before its first await (the reasoning is documented there;
        // that is the location that actually protects against late events). Kept here so
        // the method still leaves a consistent state on its own should a second caller be
        // added later.
        // DE: rueckmeldungenGesamt/rueckmeldungen.* liest aus this.currentEinsatzSnapshot,
        // ist jetzt also null -> alle Zähler werden konsistent auf 0 zurückgesetzt.
        // EN: rueckmeldungenGesamt/rueckmeldungen.* reads from this.currentEinsatzSnapshot,
        // which is now null -> all counters get consistently reset to 0.
        await this.updateRueckmeldungCounts();
    }

    /* DE: Handler für Server-Fehlermeldungen (io.error). Das bekannte "Fehler beim Erneuern
       der Session"-Muster gehört zum normalen, selbstheilenden ~10-Minuten-Session-Zyklus
       dieser Instanz (Reconnect erfolgt automatisch über refreshSessionCookie/forceReconnect)
       und wird deshalb nur als info geloggt. Alle anderen, unbekannten io.error-Inhalte
       bleiben warn, da dort nicht bekannt ist, ob sie folgenlos sind.
       EN: Handler for server error messages (io.error). The known "Fehler beim Erneuern der
       Session" (error renewing the session) pattern is part of this instance's normal,
       self-healing ~10-minute session cycle (reconnect happens automatically via
       refreshSessionCookie/forceReconnect) and is therefore only logged as info. All other,
       unknown io.error content stays warn, since it's unknown whether it's consequence-free. */
    async handleServerError(data) {
        try {
            const msg = typeof data === 'string' ? data : JSON.stringify(data);
            const isKnownSessionRenewalError = /Fehler beim Erneuern der Session/i.test(msg);
            this.safeLog(isKnownSessionRenewalError ? 'info' : 'warn', 'io.error (Server)', msg);
            await this.setField('debug.lastError', data);
        } catch {
            /* ignore */
        }
    }

    /* DE: Handler für io.version - Server-Identität/Version. Ändert sich die vom Server
       gemeldete ID zur Laufzeit, ist der Server vermutlich neu gestartet (das offizielle
       Frontend lädt in diesem Fall die Seite komplett neu). Laut server/auth.js des
       WAIP-Web-Projekts werden Sessions persistent (SQLite) gespeichert, ein Neustart
       löscht sie also normalerweise NICHT automatisch - trotzdem ist ein Server-Neustart
       ein guter genereller Anlass, Cookie und Verbindung vorsorglich aufzufrischen (billige
       Absicherung gegen jede Art von serverseitiger Zustandsänderung, nicht nur Sessions).
       EN: Handler for io.version - server identity/version. If the ID reported by the server
       changes at runtime, the server has likely restarted (the official frontend does a full
       page reload in that case). Per the WAIP-Web project's server/auth.js, sessions are
       stored persistently (SQLite), so a restart normally does NOT delete them automatically -
       still, a server restart is a good general occasion to proactively refresh the cookie
       and connection (a cheap safeguard against any kind of server-side state change, not
       just sessions). */
    async handleServerVersion(serverId) {
        try {
            await this.setStateAsync('debug.serverVersion', String(serverId), true);
            if (this.lastServerVersion && this.lastServerVersion !== serverId) {
                // DE: Wird bereits automatisch behandelt (Session-Refresh + Reconnect) ->
                // kein Handlungsbedarf, daher info statt warn.
                // EN: Already handled automatically (session refresh + reconnect) -> no
                // action needed, hence info instead of warn.
                this.log.info(
                    `WAIP server reports a new version/instance ID (${this.lastServerVersion} -> ${serverId}) - likely a server restart`,
                );
                this.appendMonitorAudit({
                    ts: new Date().toISOString(),
                    event: 'server_version_changed',
                    from: this.lastServerVersion,
                    to: serverId,
                }).catch(() => {});
                this.lastServerVersion = serverId;
                await this.refreshSessionCookie();
                this.forceReconnect('server version changed');
                return;
            }
            this.lastServerVersion = serverId;
        } catch (e) {
            this.safeWarn('handleServerVersion', e);
        }
    }

    /* DE: Handler für Routen (io.routes). Routen sind der aktuell gültige Satz für den laufenden
       Einsatz (wird bei jedem Event ersetzt, nicht akkumuliert) und liegt daher als Array
       innerhalb von einsatz.json.routen[].
       EN: Handler for routes (io.routes). Routes are the currently valid set for the
       ongoing incident (replaced on every event, not accumulated) and are therefore stored
       as an array within einsatz.json.routen[]. */
    async handleRoutes(incoming) {
        try {
            // DE: Ohne aktiven Einsatz ignorieren - anders als bei Rückmeldungen enthält die
            // Routen-Payload keine waip_uuid zum gezielten Abgleich (siehe README, Abschnitt
            // einsatz.json.routen), daher hier nur die schwächere Prüfung "läuft überhaupt
            // noch ein Einsatz". Verhindert, dass ein verspätetes io.routes-Event, das erst
            // NACH einem bereits verarbeiteten io.standby eintrifft, einsatz.json.current/
            // .routen und einsatz.routenGesamt für den bereits beendeten Einsatz wiederbelebt,
            // während alle anderen einsatz.*-Felder korrekt geleert bleiben.
            // EN: Ignore without an active incident - unlike feedback, the routes payload
            // carries no waip_uuid to match against (see README, einsatz.json.routen
            // section), so this only applies the weaker check "is an incident still being
            // tracked at all". Prevents a late io.routes event that arrives AFTER an
            // already-processed io.standby from reviving einsatz.json.current/.routen and
            // einsatz.routenGesamt for the already-finished incident, while every other
            // einsatz.* field correctly stays cleared.
            if (!this.currentEinsatzUuid) {
                this.log.debug('Ignoring routes update - no incident is currently active');
                return;
            }

            let data = incoming;
            if (Array.isArray(incoming)) {
                data = incoming.map(i => normalizeData(i));
            } else if (typeof incoming === 'object' && incoming !== null) {
                data = normalizeData(incoming);
            }

            if (!this.currentEinsatzSnapshot) {
                this.currentEinsatzSnapshot = { routen: [], rueckmeldungen: [] };
            }
            this.currentEinsatzSnapshot.routen = Array.isArray(data) ? data : data ? [data] : [];

            await this.persistEinsatzSnapshot();
            await this.writeJsonArrayState(
                'einsatz.json.routen',
                this.currentEinsatzSnapshot.routen.map(r => this.flattenRoutenEntry(r)),
            );
            try {
                await this.setStateAsync('einsatz.routenGesamt', this.currentEinsatzSnapshot.routen.length, true);
            } catch (e) {
                this.safeWarn('einsatz.routenGesamt.setState', e);
            }
        } catch (e) {
            // DE: Ein Routen-Event konnte nicht verarbeitet werden -> echter Datenverlust.
            // EN: A routes event couldn't be processed -> actual data loss.
            this.safeLog('error', 'handleRoutes', e);
        }
    }

    /* DE: Handler für TTS-Events (io.playtts). Payload ist laut client_waip.js nur eine URL
       (direkt als audio.src verwendet) - im Browser funktioniert das auch als relativer
       Pfad, weil er implizit gegen die aktuelle Seiten-Origin aufgelöst wird. Für uns nicht
       (VIS/Automationen haben nicht zwangsläufig dieselbe Origin wie der WAIP-Server),
       daher wird hier explizit zu einer vollständigen absoluten URL aufgelöst.
       EN: Handler for TTS events (io.playtts). Per client_waip.js the payload is just a URL
       (used directly as audio.src) - in a browser that also works as a relative path
       because it's implicitly resolved against the current page origin. Not for us (VIS/
       automations don't necessarily share the same origin as the WAIP server), so it's
       explicitly resolved to a full absolute URL here. */
    async handleTTS(incoming) {
        try {
            // DE: Ohne aktiven Einsatz ignorieren - die io.playtts-Payload ist laut
            // client_waip.js nur eine nackte URL-Zeichenkette, enthält also keine waip_uuid
            // zum gezielten Abgleich (anders als bei Rückmeldungen). Verhindert, dass eine
            // verspätete TTS-Ansage, die erst NACH einem bereits verarbeiteten io.standby
            // eintrifft, einsatz.tts.last/.lastTimestamp für den bereits beendeten Einsatz
            // wiederbelebt.
            // EN: Ignore without an active incident - per client_waip.js the io.playtts
            // payload is just a bare URL string, so it carries no waip_uuid to match against
            // (unlike feedback). Prevents a late TTS announcement that arrives AFTER an
            // already-processed io.standby from reviving einsatz.tts.last/.lastTimestamp for
            // the already-finished incident.
            if (!this.currentEinsatzUuid) {
                this.log.debug('Ignoring TTS announcement - no incident is currently active');
                return;
            }

            const data = normalizeData(incoming || {});
            const ts = new Date().toISOString();
            await this.setField('einsatz.tts.last', this.resolveTtsUrl(data));
            await this.setField('einsatz.tts.lastTimestamp', ts);
        } catch (e) {
            // DE: Ein TTS-Event konnte nicht verarbeitet werden -> echter Datenverlust.
            // EN: A TTS event couldn't be processed -> actual data loss.
            this.safeLog('error', 'handleTTS', e);
        }
    }

    /* DE: Cleanup helper: schließt und entfernt eine vorhandene socket-Instanz vollständig.
       EN: Cleanup helper: fully closes and removes an existing socket instance. */
    cleanupSocket() {
        // DE: Nur wenn tatsächlich ein Socket existierte, ist auch initObjects() bereits
        // gelaufen (this.socket wird ausschließlich in connect() gesetzt, das erst nach
        // initObjects() läuft) - sonst könnte onUnload() (ruft cleanupSocket() unbedingt
        // auf) die States unten setzen, bevor deren Objekte überhaupt angelegt wurden,
        // z.B. bei einem sehr schnellen Neustart der Instanz kurz nach der Installation.
        // EN: Only if a socket actually existed has initObjects() also already run
        // (this.socket is set exclusively in connect(), which only runs after
        // initObjects()) - otherwise onUnload() (which unconditionally calls
        // cleanupSocket()) could set the states below before their objects even exist,
        // e.g. on a very fast instance restart shortly after installation.
        const hadSocket = !!this.socket;
        try {
            if (!this.socket) {
                return;
            }
            try {
                this.socket.removeAllListeners();
            } catch {
                /* ignore */
            }
            try {
                this.socket.disconnect();
            } catch {
                /* ignore */
            }
            try {
                if (typeof this.socket.close === 'function') {
                    this.socket.close();
                }
            } catch {
                /* ignore */
            }
        } catch (e) {
            // DE: Reines Aufräumen der alten Socket-Instanz, kein Datenverlust -> debug statt warn.
            // EN: Plain cleanup of the old socket instance, no data loss -> debug instead of warn.
            this.safeLog('debug', 'cleanupSocket', e);
        } finally {
            this.socket = null;
            this.connecting = false;
            this.registrationPending = false;
            if (hadSocket) {
                this.setState('status.registrationPending', false, true);
            }
            if (this.registrationTimer) {
                this.clearTimeout(this.registrationTimer);
                this.registrationTimer = null;
            }
        }
    }

    onSocketConnect(monStr) {
        this.connecting = false;
        this.setState('status.connected', true, true);
        this.setState('info.connection', true, true);
        this.logRecovered('connection', 'Socket.IO connection recovered');

        try {
            // DE: Ein einzelner Emit reicht: Socket.IO liefert ab einem bestehenden 'connect'
            // bereits zuverlässig zu, und ein echter Verbindungsabbruch wird ohnehin über
            // onSocketDisconnect()/onSocketConnectError() samt Reconnect (und damit einem
            // frischen Emit) abgefangen. Bleibt die Registrierung trotzdem unbestätigt,
            // greift REGISTRATION_TIMEOUT_MS weiter unten als Sicherheitsnetz. Frühere
            // Versionen emittierten hier 3× - das führte nur dazu, dass der Server bei
            // jedem (redundanten) Emit erneut mit dem aktuellen Status antwortete
            // (io.standby/io.new_waip), ohne einen zusätzlichen Zuverlässigkeitsgewinn.
            // EN: A single emit is enough: Socket.IO already delivers reliably once a
            // 'connect' exists, and a real connection loss is caught anyway via
            // onSocketDisconnect()/onSocketConnectError() plus reconnect (and thus a fresh
            // emit). If the registration still remains unconfirmed, REGISTRATION_TIMEOUT_MS
            // below acts as a safety net. Earlier versions emitted 3× here - that only
            // caused the server to respond again with the current status
            // (io.standby/io.new_waip) on every (redundant) emit, with no extra reliability
            // gain.
            this.log.info(`socket.emit('WAIP', ${monStr})`);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'emit_WAIP', value: monStr }).catch(
                () => {},
            );
            this.socket.emit('WAIP', monStr);
        } catch (e) {
            this.logRecurringFailure('registration', 'warn', 'socket.emit.WAIP', e);
        }

        this.registrationPending = true;
        this.setState('status.registeredMonitor', monStr, true);
        // DE: Gecachter Anzeigename (siehe refreshMonitorName) - keine erneute HTTP-Abfrage
        // bei jedem (Re-)Connect, ist ggf. beim allerersten Connect noch null.
        // EN: Cached display name (see refreshMonitorName) - no repeated HTTP request on
        // every (re)connect; may still be null on the very first connect.
        this.setState('status.registeredMonitorName', this.monitorName, true);
        this.setState('status.registrationAccepted', false, true);
        this.setState('status.registrationPending', true, true);
        if (this.registrationTimer) {
            this.clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
        }
        this.registrationTimer = this.setTimeout(async () => {
            this.registrationPending = false;
            this.setState('status.registrationPending', false, true);
            const accState = await this.getStateAsync('status.registrationAccepted');
            const acc = accState ? accState.val : null;
            if (acc !== true) {
                await this.setStateAsync('status.registrationAccepted', false, true);
                this.logRecurringFailure(
                    'registration',
                    'warn',
                    'onSocketConnect',
                    `WAIP registration for monitor ${this.currentMonitor} not confirmed within ${this.REGISTRATION_TIMEOUT_MS}ms`,
                );
                this.appendMonitorAudit({
                    ts: new Date().toISOString(),
                    event: 'registration_timeout',
                    monitor: this.currentMonitor,
                }).catch(() => {});
            }
            this.registrationTimer = null;
        }, this.REGISTRATION_TIMEOUT_MS);

        this.log.info(`Connected monitor ${monStr} -> namespace /waip (registered via WAIP emit)`);
    }

    onSocketDisconnect(reason) {
        this.connecting = false;
        this.setState('status.connected', false, true);
        this.setState('info.connection', false, true);
        this.logDisconnect(`Socket disconnected: ${reason}`);
        this.registrationPending = false;
        this.setState('status.registrationAccepted', false, true);
        this.setState('status.registrationPending', false, true);
        if (this.registrationTimer) {
            this.clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
        }

        this.cleanupSocket();
        this.reconnectTimer = this.setTimeout(() => {
            this.log.info(`manual reconnect triggered for monitor '${this.currentMonitor}'`);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'manual_reconnect_triggered' }).catch(
                () => {},
            );
            this.connect();
        }, this.RECONNECT_DELAY_MS);
    }

    onSocketConnectError(err) {
        this.connecting = false;
        this.setState('status.connected', false, true);
        this.setState('info.connection', false, true);
        // DE: War zuvor doppelt geloggt (safeWarn zusätzlich zu logDisconnect für dasselbe
        // Event) - logDisconnect() unten reicht aus.
        // EN: Used to be logged twice (safeWarn in addition to logDisconnect for the same
        // event) - logDisconnect() below is sufficient.
        this.logDisconnect(`connect_error: ${String(err)}`);
        this.cleanupSocket();
        this.reconnectTimer = this.setTimeout(() => {
            this.log.info(`manual reconnect after connect_error for monitor '${this.currentMonitor}'`);
            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'manual_reconnect_after_error' }).catch(
                () => {},
            );
            this.connect();
        }, this.RECONNECT_DELAY_MS);
    }

    /*
     DE: Connect: verbindet zur socket.io-namespace '/waip' (über path '/socket.io'),
     registriert sich per emit('WAIP', monitor).

     WICHTIG: automatische reconnects deaktiviert (reconnection: false). Nach
     disconnect/connect_error wird manuell reconnect() nach RECONNECT_DELAY_MS aufgerufen.

     EN: Connect: connects to the socket.io namespace '/waip' (via path '/socket.io'),
     registers itself via emit('WAIP', monitor).

     IMPORTANT: automatic reconnects are disabled (reconnection: false). After
     disconnect/connect_error, reconnect() is called manually after RECONNECT_DELAY_MS.
    */
    async connect(force = false) {
        try {
            const monStr = isValidMonitor(this.monitorID) ? this.monitorID : '0';

            if (!force && this.socket && this.currentMonitor === monStr && !this.connecting) {
                this.log.debug(`connect(): already connected to monitor ${monStr}, skipping`);
                return;
            }

            // DE: Falls (z.B. nach einem längeren Disconnect) noch kein/kein frischer
            // Session-Cookie vorliegt, vor dem (Re-)Connect einen holen.
            // EN: If (e.g. after a longer disconnect) there's no/no fresh session cookie
            // yet, fetch one before the (re)connect.
            if (!this.sessionCookie) {
                await this.refreshSessionCookie();
            }

            this.cleanupSocket();
            this.connecting = true;
            this.currentMonitor = monStr;

            this.appendMonitorAudit({ ts: new Date().toISOString(), event: 'connect_called', using: monStr }).catch(
                () => {},
            );
            this.log.info(`connect(): using monitor '${monStr}'`);

            const namespaceUrl = `${this.url}/waip`;
            this.socket = io(namespaceUrl, {
                path: '/socket.io',
                forceNew: true,
                transports: ['websocket', 'polling'],
                reconnection: false,
                timeout: 20000,
                query: { monitor: monStr },
                // DE: Session-Cookie mitschicken, damit die Verbindung nicht anonym/ohne
                // Server-Session läuft (siehe refreshSessionCookie/startSessionKeepalive)
                // EN: Send along the session cookie so the connection doesn't run
                // anonymously/without a server session (see refreshSessionCookie/
                // startSessionKeepalive)
                extraHeaders: this.sessionCookie ? { Cookie: this.sessionCookie } : undefined,
            });

            try {
                if (this.socket && this.socket.io && this.socket.io.engine) {
                    const eng = this.socket.io.engine;
                    this.log.debug(`engine pingInterval=${eng.pingInterval} pingTimeout=${eng.pingTimeout}`);
                    // DE: ping/pong/open/close wiederholen sich für die gesamte Verbindungsdauer
                    // (alle pingInterval ms) ohne diagnostischen Mehrwert nach den ersten paar -
                    // deshalb hier begrenzt, anders als die Message-Preview darunter (jeweils
                    // anderer Inhalt, seltener, bleibt bewusst unbegrenzt).
                    // EN: ping/pong/open/close repeat for the entire connection lifetime
                    // (every pingInterval ms) with no diagnostic value after the first few -
                    // hence capped here, unlike the message preview below (different content
                    // each time, rarer, deliberately left uncapped).
                    let enginePingPongLogCount = 0;
                    eng.on('packet', pkt => {
                        try {
                            if (pkt && pkt.type) {
                                if (['ping', 'pong', 'open', 'close'].includes(String(pkt.type))) {
                                    if (enginePingPongLogCount < 10) {
                                        enginePingPongLogCount++;
                                        this.log.debug(`engine.packet: ${JSON.stringify(pkt)}`);
                                    }
                                } else if (pkt.data && typeof pkt.data === 'string') {
                                    const preview = pkt.data.length > 200 ? `${pkt.data.slice(0, 200)}...` : pkt.data;
                                    this.log.debug(`engine.packet.message preview: ${preview}`);
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    });
                }
            } catch {
                /* ignore */
            }

            this.socket.on('connect', () => this.onSocketConnect(monStr));
            this.socket.on('disconnect', reason => this.onSocketDisconnect(reason));
            this.socket.on('connect_error', err => this.onSocketConnectError(err));

            // DE: Diagnostik: erste eingehende Rohdaten als Preview loggen (max. 6 Events)
            // EN: Diagnostics: log the first incoming raw data as a preview (max. 6 events)
            let firstCount = 0;
            const anyListener = (event, ...args) => {
                try {
                    firstCount++;
                    const previewArgs =
                        args && args.length
                            ? typeof args[0] === 'string'
                                ? args[0].slice(0, 500)
                                : JSON.stringify(args[0]).slice(0, 500)
                            : '';
                    this.log.debug(`incoming event '${event}' preview: ${previewArgs}`);
                    if (firstCount >= 6 && this.socket && typeof this.socket.offAny === 'function') {
                        try {
                            this.socket.offAny(anyListener);
                        } catch {
                            /* ignore */
                        }
                    }
                } catch {
                    /* ignore */
                }
            };
            try {
                if (this.socket && typeof this.socket.onAny === 'function') {
                    this.socket.onAny(anyListener);
                }
            } catch {
                /* ignore */
            }

            this.socket.on('io.new_waip', this.wrapHandlerWithMonitorCheck(this.handleAlarm.bind(this)));
            this.socket.on('io.new_rmld', this.wrapHandlerWithMonitorCheck(this.handleRueckmeldung.bind(this)));
            this.socket.on('io.routes', this.wrapHandlerWithMonitorCheck(this.handleRoutes.bind(this)));
            this.socket.on('io.playtts', this.wrapHandlerWithMonitorCheck(this.handleTTS.bind(this)));
            this.socket.on('io.standby', this.wrapHandlerWithMonitorCheck(this.handleStandby.bind(this)));
            // DE: io.error/io.version sind serverweite, nicht monitor-gebundene Signale ->
            // bewusst ohne wrapHandlerWithMonitorCheck registriert.
            // EN: io.error/io.version are server-wide signals, not tied to a monitor ->
            // deliberately registered without wrapHandlerWithMonitorCheck.
            this.socket.on('io.error', data => this.handleServerError(data));
            this.socket.on('io.version', serverId => this.handleServerVersion(serverId));

            this.socket.onAny((event, ...args) => {
                try {
                    const now = Date.now();
                    if (event !== this._lastDebugEvent.event || now - this._lastDebugEvent.ts > 5000) {
                        this._lastDebugEvent = { event, ts: now };
                        // DE: Als Array mit einem Element speichern (nicht das nackte Objekt) -
                        // VIS-Tabellen-Widgets erwarten am Root immer ein Array, sonst liefern
                        // sie keine Zeile.
                        // EN: Store as an array with one element (not the bare object) - VIS
                        // table widgets always expect an array at the root, otherwise they
                        // render no row.
                        this.setField('debug.lastEvent', [
                            {
                                event,
                                ts: new Date().toISOString(),
                                argsCount: args.length,
                            },
                        ]).catch(() => {});
                    }
                } catch {
                    /* ignore */
                }
            });
        } catch (e) {
            this.logRecurringFailure('connection', 'warn', 'connect', e);
            this.connecting = false;
        }
    }

    /* DE: Intervall: Restzeit bis Einsatzende.
       EN: Interval: remaining time until the incident ends. */
    startRestzeitInterval() {
        this.restzeitInterval = this.setInterval(async () => {
            let rest = 0;
            try {
                const s = await this.getStateAsync('einsatz.ablaufzeit');
                if (s && s.val !== undefined && s.val !== null && s.val !== '') {
                    const end = new Date(s.val);
                    if (!isNaN(end.getTime())) {
                        rest = Math.max(0, Math.floor((end.getTime() - Date.now()) / 1000));
                    }
                }
            } catch {
                rest = 0;
            }
            await this.updateRestzeit(rest);
            await this.checkMissedStandby(rest);
        }, 1000);
    }

    /* DE: Watchdog gegen ein verpasstes io.standby: steht einsatz.restzeit seit
       MISSED_STANDBY_GRACE_MS auf 0, obwohl noch ein Einsatz als aktiv geführt wird, wird
       angenommen, dass io.standby verpasst wurde (z.B. durch einen Disconnect zum
       falschen Zeitpunkt) - der Einsatz wird dann automatisch abgeschlossen, statt
       unbegrenzt mit veralteten Daten als "aktiv" stehen zu bleiben.
       EN: Watchdog against a missed io.standby: if einsatz.restzeit has been 0 for
       MISSED_STANDBY_GRACE_MS while an incident is still tracked as active, it's assumed
       that io.standby was missed (e.g. due to a disconnect at the wrong moment) - the
       incident is then finalized automatically instead of remaining "active" indefinitely
       with stale data. */
    async checkMissedStandby(rest) {
        if (rest > 0 || !this.currentEinsatzUuid || !this.currentEinsatzSnapshot) {
            this._restzeitZeroSince = null;
            return;
        }
        if (this._restzeitZeroSince === null) {
            this._restzeitZeroSince = Date.now();
            return;
        }
        if (Date.now() - this._restzeitZeroSince < MISSED_STANDBY_GRACE_MS) {
            return;
        }
        const einsatzUuid = this.currentEinsatzUuid;
        this.log.warn(
            `Likely missed io.standby detected (ablaufzeit exceeded by more than ${Math.round(
                MISSED_STANDBY_GRACE_MS / 1000,
            )}s) - finalizing incident ${einsatzUuid} automatically.`,
        );
        this.appendMonitorAudit({
            ts: new Date().toISOString(),
            event: 'missed_standby_timeout',
            einsatz: einsatzUuid,
        }).catch(() => {});
        await this.finalizeCurrentEinsatz();
    }

    async updateRestzeit(rest) {
        if (this._lastRestzeit !== rest) {
            this._lastRestzeit = rest;
            try {
                await this.setStateAsync('einsatz.restzeit', rest, true);
            } catch {
                /* ignore */
            }
        }
    }
}

if (require.main !== module) {
    module.exports = options => new WaipWeb(options);
    /* DE: Interne, ioBroker-freie Hilfsfunktionen für Unit-Tests zugänglich machen (siehe
       test/unit.js). Bewusst als Property AN der Factory-Funktion, nicht als eigenes
       Export-Objekt: @iobroker/adapter-core erwartet, dass module.exports selbst die
       Factory ist (options => new WaipWeb(options)) - ein { default, testables }-Objekt
       würde den Adapter-Start brechen. Diese Funktionen sind rein (keine this-Bindung,
       keine State-Zugriffe) und dadurch ohne Mock testbar; genau hier lagen mehrere
       vergangene Fehler (payloadMonitorMatch/wache_nr in 0.7.19, das Modifikator-Regex in
       0.7.23, die Bitshift-Falle in hexColorToJimpInt).
       EN: Expose internal, ioBroker-free helpers for unit tests (see test/unit.js).
       Deliberately as a property ON the factory function rather than as a separate export
       object: @iobroker/adapter-core expects module.exports itself to be the factory
       (options => new WaipWeb(options)) - a { default, testables } object would break
       adapter startup. These functions are pure (no this binding, no state access) and
       therefore testable without a mock; several past bugs lived exactly here
       (payloadMonitorMatch/wache_nr in 0.7.19, the modifier regex in 0.7.23, the bit-shift
       trap in hexColorToJimpInt). */
    module.exports.testables = {
        isValidMonitor,
        unwrapGeometryObject,
        extractPolygonRings,
        getCenterFromGeometry,
        normalizeData,
        decodeHtmlEntities,
        normalizeStichwortForMatch,
        isRettungsdienstEinsatz,
        clampNumber,
        hexColorToJimpInt,
        lonLatToGlobalPixel,
        fitZoomToPolygon,
        STATE_DEFS,
        CHANNEL_DEFS,
        JSON_ARRAY_STATE_IDS,
        NULLABLE_NUMBER_STATE_IDS,
        RESET_EXCLUDED_STATE_IDS,
        ALLOWED_EINSATZ_FIELDS,
        OBSOLETE_OBJECT_IDS,
        OBSOLETE_FOLDER_IDS,
        HISTORY_SIZE,
        MONITOR_AUDIT_SIZE,
        WaipWeb,
    };
} else {
    new WaipWeb();
}
