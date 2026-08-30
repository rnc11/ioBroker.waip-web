/*
 * DE: Unit-Tests für die reinen, ioBroker-freien Hilfsfunktionen aus main.js
 * (module.exports.testables). Laufen in Millisekunden und brauchen weder einen
 * js-controller noch einen Socket-Server - komplementär zu den .claude/skills-Rezepten
 * `verify` (gemockter Core + echter Socket) und `verify-live` (echte Instanz).
 *
 * Schwerpunkt sind die Stellen, an denen historisch echte Fehler saßen:
 * - payloadMonitorMatch/wache_nr (0.7.19)
 * - das Modifikator-Regex der Rettungsdienst-Dekodierung (0.7.23)
 * - die Bitshift-Falle in hexColorToJimpInt
 * - die wgs84_x/y-Vertauschung gegenüber der üblichen GIS-Konvention
 *
 * EN: Unit tests for the pure, ioBroker-free helpers from main.js
 * (module.exports.testables). They run in milliseconds and need neither a js-controller
 * nor a socket server - complementary to the .claude/skills recipes `verify` (mocked core
 * + real socket) and `verify-live` (real instance).
 *
 * The focus is on the places where real bugs historically lived:
 * - payloadMonitorMatch/wache_nr (0.7.19)
 * - the modifier regex of the rescue-service decoder (0.7.23)
 * - the bit-shift trap in hexColorToJimpInt
 * - the wgs84_x/y swap relative to the usual GIS convention
 */

/*
 * DE: chai und mocha kommen bewusst transitiv über @iobroker/testing und stehen NICHT in
 * den devDependencies - der repochecker verlangt das ausdrücklich (E0063: "chai, mocha are
 * included in @iobroker/testing. Remove from devDependencies"). Ein explizites Deklarieren
 * wirkt zwar robuster, verstößt hier aber gegen die Projektkonvention.
 * EN: chai and mocha deliberately come in transitively via @iobroker/testing and are NOT
 * listed in devDependencies - the repochecker explicitly requires this (E0063: "chai, mocha
 * are included in @iobroker/testing. Remove from devDependencies"). Declaring them
 * explicitly looks more robust but violates the project convention here.
 */
const { expect } = require('chai');

/*
 * DE: @iobroker/adapter-core sucht beim Laden nach einer echten js-controller-Installation
 * und wirft sonst "Cannot find js-controller" - main.js wäre also gar nicht ladbar. Ein
 * minimaler Mock im require-Cache (VOR dem require von main.js) genügt hier, weil die
 * getesteten Funktionen den Adapter selbst nicht anfassen.
 * EN: @iobroker/adapter-core looks for a real js-controller installation on load and
 * otherwise throws "Cannot find js-controller" - so main.js couldn't be required at all. A
 * minimal mock in the require cache (BEFORE requiring main.js) is enough here, since the
 * functions under test don't touch the adapter itself.
 */
const corePath = require.resolve('@iobroker/adapter-core');
require.cache[corePath] = {
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: {
        Adapter: class {},
        adapter: class {},
        getAbsoluteInstanceDataDir: () => '/tmp/waip-web-test',
    },
};

const mainExport = require('../main.js');
const t = mainExport.testables;

describe('main.js exports', () => {
    it('exports a factory function (required by @iobroker/adapter-core)', () => {
        // DE: Bricht der Export je auf ein Objekt um, startet der Adapter nicht mehr.
        // EN: If the export ever changes to an object, the adapter no longer starts.
        expect(mainExport).to.be.a('function');
    });

    it('exposes the testables without replacing the factory', () => {
        expect(t).to.be.an('object');
        expect(t.WaipWeb).to.be.a('function');
    });
});

describe('isValidMonitor', () => {
    it('accepts numeric monitor ids', () => {
        expect(t.isValidMonitor('4')).to.be.true;
        expect(t.isValidMonitor('0')).to.be.true;
        expect(t.isValidMonitor(4)).to.be.true;
    });

    it('rejects only empty values (non-numeric strings are the caller\'s concern)', () => {
        // DE: isValidMonitor() prüft bewusst NUR auf "nicht leer" - die Monitor-ID wird als
        // String an emit('WAIP', id) durchgereicht, der Server entscheidet über Gültigkeit.
        // EN: isValidMonitor() deliberately checks ONLY for "not empty" - the monitor ID is
        // passed through to emit('WAIP', id) as a string, the server decides validity.
        expect(t.isValidMonitor('')).to.be.false;
        expect(t.isValidMonitor('   ')).to.be.false;
        expect(t.isValidMonitor(null)).to.be.false;
        expect(t.isValidMonitor(undefined)).to.be.false;
    });
});

describe('dbrdEntryMatchesMonitor', () => {
    // DE: Beispiel-Eintrag angelehnt an die live gegen /waip/ verifizierten Werte
    // (Plandokument Abschnitt 1a): l=Leitstelle, a=Kreis, b=Träger, c=Wachen-Liste.
    // EN: Example entry modeled on the values live-verified against /waip/ (plan document
    // section 1a): l=dispatch center, a=district, b=carrier, c=station list.
    const entry = { l: '4', a: '71', b: '7105', c: '710512,710506,710503' };

    it('matches on l (Leitstelle)', () => {
        expect(t.dbrdEntryMatchesMonitor(entry, '4')).to.be.true;
    });

    it('matches on a (Kreis)', () => {
        expect(t.dbrdEntryMatchesMonitor(entry, '71')).to.be.true;
    });

    it('matches on b (Träger)', () => {
        expect(t.dbrdEntryMatchesMonitor(entry, '7105')).to.be.true;
    });

    it('matches on a single value within the comma-separated c list (Wache)', () => {
        expect(t.dbrdEntryMatchesMonitor(entry, '710506')).to.be.true;
    });

    it('rejects a monitor id that matches none of l/a/b/c', () => {
        expect(t.dbrdEntryMatchesMonitor(entry, '999')).to.be.false;
    });

    it('treats monitorID "0" as "all" (global), like the /waip namespace', () => {
        expect(t.dbrdEntryMatchesMonitor(entry, '0')).to.be.true;
        expect(t.dbrdEntryMatchesMonitor({ l: '1', a: '2', b: '3', c: '4' }, '0')).to.be.true;
    });

    it('treats an empty/missing monitorID as "all", consistent with isValidMonitor()', () => {
        expect(t.dbrdEntryMatchesMonitor(entry, '')).to.be.true;
        expect(t.dbrdEntryMatchesMonitor(entry, null)).to.be.true;
        expect(t.dbrdEntryMatchesMonitor(entry, undefined)).to.be.true;
    });

    it('tolerates whitespace and empty segments in the c list', () => {
        const messy = { l: '1', a: '2', b: '3', c: ' 710506 ,, 710503 ,' };
        expect(t.dbrdEntryMatchesMonitor(messy, '710506')).to.be.true;
        expect(t.dbrdEntryMatchesMonitor(messy, '710503')).to.be.true;
        expect(t.dbrdEntryMatchesMonitor(messy, '')).to.be.true; // still "all"
    });

    it('rejects a non-global monitorID against a non-object entry instead of throwing', () => {
        expect(t.dbrdEntryMatchesMonitor(null, '4')).to.be.false;
        expect(t.dbrdEntryMatchesMonitor(undefined, '4')).to.be.false;
        expect(t.dbrdEntryMatchesMonitor('a string', '4')).to.be.false;
    });
});

describe('buildDashboardChannelDefs/buildDashboardStateDefs', () => {
    // DE: dashboardSlotCount ist eine Laufzeit-Config (1..20, siehe Plandokument Frage 13) -
    // die Defs werden pro Slotanzahl frisch gebaut, nicht mehr wie sonst in diesem Adapter
    // üblich beim Modul-Laden statisch angelegt.
    // EN: dashboardSlotCount is a runtime config value (1..20, see the plan document
    // question 13) - the defs are built fresh per slot count, not statically at module
    // load like everything else in this adapter.
    // DE: 15 flache Felder + 8 Rückmeldungs-Zähler (4 Rollen + 4 Funktionen) + 5 json.*-States
    // = 28 States pro Slot. Explizit ausgezählt statt geschätzt, damit ein versehentlich
    // entferntes/hinzugefügtes Feld hier auffällt.
    // EN: 15 flat fields + 8 feedback counters (4 roles + 4 functions) + 5 json.* states =
    // 28 states per slot. Explicitly counted rather than guessed, so an accidentally
    // removed/added field shows up here.
    const FIELDS_PER_SLOT = 28;

    it('builds exactly one root channel plus 5 channel/folder objects per slot', () => {
        const defs = t.buildDashboardChannelDefs(3);
        expect(defs.filter(d => d.id === 'dashboard')).to.have.lengthOf(1);
        for (let i = 1; i <= 3; i++) {
            expect(defs.some(d => d.id === `dashboard.einsatz${i}`)).to.be.true;
            expect(defs.some(d => d.id === `dashboard.einsatz${i}.rueckmeldungen`)).to.be.true;
            expect(defs.some(d => d.id === `dashboard.einsatz${i}.rueckmeldungen.rollen`)).to.be.true;
            expect(defs.some(d => d.id === `dashboard.einsatz${i}.rueckmeldungen.funktionen`)).to.be.true;
            expect(defs.some(d => d.id === `dashboard.einsatz${i}.json`)).to.be.true;
        }
        // 1 root + 3 slots * 5 objects each
        expect(defs).to.have.lengthOf(1 + 3 * 5);
        expect(defs.some(d => d.id === 'dashboard.einsatz4')).to.be.false;
    });

    it('builds no slot channels for slotCount 0 (only the root channel)', () => {
        const defs = t.buildDashboardChannelDefs(0);
        expect(defs).to.have.lengthOf(1);
        expect(defs[0].id).to.equal('dashboard');
    });

    it('tolerates non-finite slotCount by treating it as 0', () => {
        expect(t.buildDashboardChannelDefs(NaN)).to.have.lengthOf(1);
        expect(t.buildDashboardChannelDefs(undefined)).to.have.lengthOf(1);
        expect(t.buildDashboardChannelDefs(null)).to.have.lengthOf(1);
    });

    it('builds state defs for exactly the requested number of slots, no more', () => {
        const defs = t.buildDashboardStateDefs(2);
        const slot1 = defs.filter(d => d.id.startsWith('dashboard.einsatz1.'));
        const slot2 = defs.filter(d => d.id.startsWith('dashboard.einsatz2.'));
        const slot3 = defs.filter(d => d.id.startsWith('dashboard.einsatz3.'));
        expect(slot1.length).to.be.above(0);
        expect(slot2.length).to.equal(slot1.length);
        expect(slot3).to.have.lengthOf(0);
    });

    it('gives every slot a state count consistent across slots', () => {
        const defs = t.buildDashboardStateDefs(1);
        expect(defs).to.have.lengthOf(FIELDS_PER_SLOT);
    });

    it('has no restzeit/ablaufzeit/tts states (do not exist in the /dbrd payload)', () => {
        const defs = t.buildDashboardStateDefs(1);
        const ids = defs.map(d => d.id);
        expect(ids.some(id => id.endsWith('.restzeit'))).to.be.false;
        expect(ids.some(id => id.endsWith('.ablaufzeit'))).to.be.false;
        expect(ids.some(id => id.includes('.tts.'))).to.be.false;
    });

    it('has a json.wachen state with no einsatzAktuell.* counterpart (deliberate asymmetry)', () => {
        const defs = t.buildDashboardStateDefs(1);
        expect(defs.some(d => d.id === 'dashboard.einsatz1.json.wachen')).to.be.true;
        expect(t.STATE_DEFS.some(d => d.id === 'einsatzAktuell.json.wachen')).to.be.false;
    });

    it('has no json.history10/emWeitere states (not part of the dashboard schema)', () => {
        const defs = t.buildDashboardStateDefs(1);
        const ids = defs.map(d => d.id);
        expect(ids.some(id => id.includes('history10'))).to.be.false;
        expect(ids.some(id => id.includes('emWeitere'))).to.be.false;
    });

    it('declares every generated state with a type and a role', () => {
        const defs = t.buildDashboardStateDefs(2);
        const bad = defs.filter(d => !d.type || !d.role).map(d => d.id);
        expect(bad, bad.join(', ')).to.be.empty;
    });

    it('has a channel/folder parent for every generated state path segment', () => {
        // DE: dieselbe Struktur-Garantie wie der bestehende 'state definitions -
        // internal consistency'-Test, aber für die dynamisch erzeugten Dashboard-Defs.
        // EN: the same structural guarantee as the existing 'state definitions -
        // internal consistency' test, but for the dynamically generated dashboard defs.
        const channelDefs = t.buildDashboardChannelDefs(2);
        const stateDefs = t.buildDashboardStateDefs(2);
        const channelIds = new Set(channelDefs.map(d => d.id));
        const missing = [];
        for (const def of stateDefs) {
            const parts = def.id.split('.');
            for (let i = 1; i < parts.length; i++) {
                const parent = parts.slice(0, i).join('.');
                if (!channelIds.has(parent)) {
                    missing.push(`${def.id} -> missing parent ${parent}`);
                }
            }
        }
        expect(missing, missing.join('; ')).to.be.empty;
    });

    it('produces no duplicate state ids across slots', () => {
        const defs = t.buildDashboardStateDefs(5);
        const ids = defs.map(d => d.id);
        expect(ids).to.have.lengthOf(new Set(ids).size);
    });
});

describe('normalizeStichwortForMatch', () => {
    it('treats spaces and hyphens as equivalent (dispatch-center spelling variants)', () => {
        // DE: Kern der Stichwort-Tabelle: eine Zeile muss alle Schreibvarianten abdecken.
        // EN: Core of the keyword table: one row has to cover all spelling variants.
        const expected = 'h:vu mit p';
        expect(t.normalizeStichwortForMatch('H:VU mit P')).to.equal(expected);
        expect(t.normalizeStichwortForMatch('H:VU-mit-P')).to.equal(expected);
        expect(t.normalizeStichwortForMatch('H:VU - mit - P')).to.equal(expected);
        expect(t.normalizeStichwortForMatch('  h:vu   MIT   p  ')).to.equal(expected);
    });

    it('handles empty input without throwing', () => {
        expect(t.normalizeStichwortForMatch('')).to.equal('');
        expect(t.normalizeStichwortForMatch(null)).to.equal('');
        expect(t.normalizeStichwortForMatch(undefined)).to.equal('');
    });
});

describe('isRettungsdienstEinsatz', () => {
    it('detects rescue-service incidents case-insensitively', () => {
        expect(t.isRettungsdienstEinsatz('Rettungseinsatz')).to.be.true;
        expect(t.isRettungsdienstEinsatz('rettungsdiensteinsatz')).to.be.true;
        expect(t.isRettungsdienstEinsatz('Krankentransport')).to.be.true;
    });

    it('does not match fire-service incidents', () => {
        expect(t.isRettungsdienstEinsatz('Brandeinsatz')).to.be.false;
        expect(t.isRettungsdienstEinsatz('Hilfeleistungseinsatz')).to.be.false;
    });

    it('tolerates non-string input', () => {
        expect(t.isRettungsdienstEinsatz(null)).to.be.false;
        expect(t.isRettungsdienstEinsatz(undefined)).to.be.false;
        expect(t.isRettungsdienstEinsatz(42)).to.be.false;
    });
});

describe('clampNumber', () => {
    it('clamps to the given range', () => {
        expect(t.clampNumber(5000, 100, 2000, 600)).to.equal(2000);
        expect(t.clampNumber(-5, 100, 2000, 600)).to.equal(100);
        expect(t.clampNumber(800, 100, 2000, 600)).to.equal(800);
    });

    it('falls back to the default for unusable input', () => {
        // DE: Schützt vor unsinnigen Werten aus einem externen Config-JSON-Import.
        // null/'' sind dabei besonders heikel: Number() macht daraus 0, das wäre finite
        // und würde auf min statt auf den Default geklemmt (in 0.7.38 gefixt).
        // EN: Protects against nonsensical values from an external config JSON import.
        // null/'' are particularly tricky: Number() turns them into 0, which would be
        // finite and get clamped to min instead of the default (fixed in 0.7.38).
        expect(t.clampNumber(undefined, 100, 2000, 600)).to.equal(600);
        expect(t.clampNumber(null, 100, 2000, 600)).to.equal(600);
        expect(t.clampNumber('', 100, 2000, 600)).to.equal(600);
        expect(t.clampNumber('   ', 100, 2000, 600)).to.equal(600);
        expect(t.clampNumber('abc', 100, 2000, 600)).to.equal(600);
        expect(t.clampNumber(NaN, 100, 2000, 600)).to.equal(600);
        expect(t.clampNumber(Infinity, 100, 2000, 600)).to.equal(600);
    });

    it('still accepts a legitimate 0 that is inside the range', () => {
        // DE: Gegenprobe zum Leerwert-Fix: eine echte 0 darf nicht verschluckt werden.
        // EN: Counter-check to the empty-value fix: a genuine 0 must not be swallowed.
        expect(t.clampNumber(0, 0, 10, 5)).to.equal(0);
        expect(t.clampNumber('0', 0, 10, 5)).to.equal(0);
    });

    it('rounds fractional values', () => {
        expect(t.clampNumber(600.4, 100, 2000, 600)).to.equal(600);
        expect(t.clampNumber(600.6, 100, 2000, 600)).to.equal(601);
    });
});

describe('hexColorToJimpInt', () => {
    it('keeps high colors positive (the signed-32-bit bit-shift trap)', () => {
        // DE: Mit <<8 | 0xff wäre Weiß -1/-256 statt 0xffffffff - Jimp bekäme einen
        // negativen Wert. Deshalb *256 + 0xff (plain arithmetic).
        // EN: With <<8 | 0xff white would be -1/-256 instead of 0xffffffff - Jimp would
        // receive a negative value. Hence *256 + 0xff (plain arithmetic).
        const white = t.hexColorToJimpInt('#ffffff', '#dd2020');
        expect(white).to.equal(0xffffffff);
        expect(white).to.be.above(0);
    });

    it('converts a normal color with full alpha', () => {
        expect(t.hexColorToJimpInt('#dd2020', '#dd2020')).to.equal(0xdd2020ff);
    });

    it('accepts a missing leading hash', () => {
        expect(t.hexColorToJimpInt('dd2020', '#dd2020')).to.equal(0xdd2020ff);
    });

    it('falls back to the default for invalid input', () => {
        const fallback = 0xdd2020ff;
        expect(t.hexColorToJimpInt('', '#dd2020')).to.equal(fallback);
        expect(t.hexColorToJimpInt(null, '#dd2020')).to.equal(fallback);
        expect(t.hexColorToJimpInt('#xyz', '#dd2020')).to.equal(fallback);
        expect(t.hexColorToJimpInt('#ff', '#dd2020')).to.equal(fallback);
    });
});

describe('decodeHtmlEntities', () => {
    it('decodes the named entities used on the /waip/ overview page', () => {
        expect(t.decodeHtmlEntities('L&ouml;bau')).to.equal('Löbau');
        expect(t.decodeHtmlEntities('Wei&szlig;wasser')).to.equal('Weißwasser');
        expect(t.decodeHtmlEntities('A &amp; B')).to.equal('A & B');
    });

    it('decodes numeric entities', () => {
        expect(t.decodeHtmlEntities('L&#246;bau')).to.equal('Löbau');
        expect(t.decodeHtmlEntities('L&#xf6;bau')).to.equal('Löbau');
    });

    it('collapses whitespace and trims', () => {
        expect(t.decodeHtmlEntities('  Leitstelle   Lausitz  ')).to.equal('Leitstelle Lausitz');
    });
});

describe('normalizeData - geo normalization', () => {
    it('uses the WAIP convention wgs84_x=lat / wgs84_y=lon (NOT the usual GIS order)', () => {
        // DE: Bestätigt über client_waip.js des offiziellen Frontends. Ein Vertauschen
        // hier würde jeden Einsatz an eine falsche Position setzen.
        // EN: Confirmed via the official frontend's client_waip.js. Swapping these would
        // place every incident at a wrong position.
        const out = t.normalizeData({ wgs84_x: 51.5, wgs84_y: 14.4, stichwort: 'B2' });
        expect(out.position).to.deep.equal({ lat: 51.5, lon: 14.4 });
    });

    it('ignores a 0/0 coordinate (real but wrong position)', () => {
        const out = t.normalizeData({ wgs84_x: 0, wgs84_y: 0 });
        expect(out.position).to.be.undefined;
    });

    it('falls back to data.position when wgs84 fields are absent', () => {
        const out = t.normalizeData({ position: { lat: 51.1, lon: 14.1 } });
        expect(out.position).to.deep.equal({ lat: 51.1, lon: 14.1 });
    });

    it('falls back to the geometry centroid', () => {
        const out = t.normalizeData({
            geometry: { type: 'Point', coordinates: [14.2, 51.2] },
        });
        expect(out.position).to.deep.equal({ lat: 51.2, lon: 14.2 });
    });

    it('uses the first LineString point as position, not the centroid (route case)', () => {
        // DE: Regressionstest für den Bugfix - eine Route ist keine Fläche; ihre Bounding-
        // Box-Mitte war vorher ein bedeutungsloser Punkt "irgendwo auf dem Weg". Der erste
        // Punkt entspricht dem Wachenstandort, siehe getCenterFromGeometry().
        // EN: Regression test for the bug fix - a route is not an area; its bounding-box
        // center used to be a meaningless point "somewhere along the way". The first point
        // corresponds to the station location, see getCenterFromGeometry().
        const out = t.normalizeData({
            geometry: {
                type: 'LineString',
                coordinates: [
                    [13.610583938139387, 52.34045015968357],
                    [13.7, 52.5],
                    [14.0, 53.0],
                ],
            },
        });
        expect(out.position).to.deep.equal({ lat: 52.34045, lon: 13.610584 });
    });

    it('falls back to data.coords ([lat, lon], live-confirmed io.routes fallback format)', () => {
        // DE: Live bestätigt an einem echten io.routes-Eintrag ohne Routenberechnung -
        // der Server liefert dann nur den Wachenstandort als [lat, lon]-Paar statt eines
        // geometry-LineStrings.
        // EN: Live-confirmed on a real io.routes entry without a route calculation - the
        // server then only supplies the station's own location as a [lat, lon] pair
        // instead of a geometry LineString.
        const out = t.normalizeData({
            nr_wache: 610703,
            name_wache: 'LDS FW Miersdorf',
            coords: [52.34045015968357, 13.610583938139387],
        });
        expect(out.position).to.deep.equal({ lat: 52.34045015968357, lon: 13.610583938139387 });
        expect(out).to.not.have.property('coords');
    });

    it('ignores a 0/0 data.coords pair', () => {
        const out = t.normalizeData({ coords: [0, 0] });
        expect(out.position).to.be.undefined;
    });

    it('prioritizes wgs84_x/y over data.coords when both are present', () => {
        const out = t.normalizeData({ wgs84_x: 51.5, wgs84_y: 14.4, coords: [1, 2] });
        expect(out.position).to.deep.equal({ lat: 51.5, lon: 14.4 });
    });

    it('strips the raw geo fields from the result', () => {
        // DE: Wichtig: buildEinsatzMapImage() braucht deshalb die ROHE incoming.geometry.
        // EN: Important: that's why buildEinsatzMapImage() needs the RAW incoming.geometry.
        const out = t.normalizeData({
            wgs84_x: 51.5,
            wgs84_y: 14.4,
            geometry: { type: 'Point', coordinates: [1, 2] },
            geojson: '{}',
            geometry_type: 'Point',
        });
        expect(out).to.not.have.property('geometry');
        expect(out).to.not.have.property('wgs84_x');
        expect(out).to.not.have.property('wgs84_y');
        expect(out).to.not.have.property('geojson');
        expect(out).to.not.have.property('geometry_type');
    });

    it('does not mutate the input object', () => {
        const input = { wgs84_x: 51.5, wgs84_y: 14.4 };
        t.normalizeData(input);
        expect(input.wgs84_x).to.equal(51.5);
    });

    it('tolerates malformed input', () => {
        expect(t.normalizeData(null)).to.be.null;
        expect(t.normalizeData(undefined)).to.be.undefined;
        expect(() => t.normalizeData({ geometry: 'not json' })).to.not.throw();
    });
});

describe('getCenterFromGeometry', () => {
    it('returns the first point of a LineString, not its bounding-box center', () => {
        const out = t.getCenterFromGeometry({
            type: 'LineString',
            coordinates: [
                [13.6, 52.3],
                [14.0, 53.0],
            ],
        });
        expect(out).to.deep.equal({ lat: 52.3, lon: 13.6 });
    });

    it('returns null for an empty LineString', () => {
        expect(t.getCenterFromGeometry({ type: 'LineString', coordinates: [] })).to.be.null;
    });

    it('returns null for a LineString whose first point is 0/0', () => {
        expect(
            t.getCenterFromGeometry({
                type: 'LineString',
                coordinates: [
                    [0, 0],
                    [14.0, 53.0],
                ],
            }),
        ).to.be.null;
    });

    it('still averages a Polygon into its bounding-box center (unaffected by the LineString fix)', () => {
        const out = t.getCenterFromGeometry({
            type: 'Polygon',
            coordinates: [
                [
                    [14.0, 51.0],
                    [14.2, 51.0],
                    [14.2, 51.2],
                    [14.0, 51.2],
                    [14.0, 51.0],
                ],
            ],
        });
        expect(out).to.deep.equal({ lat: 51.1, lon: 14.1 });
    });
});

describe('unwrapGeometryObject', () => {
    it('accepts a plain geometry object', () => {
        const g = { type: 'Point', coordinates: [14, 51] };
        expect(t.unwrapGeometryObject(g)).to.deep.equal(g);
    });

    it('accepts a stringified geometry', () => {
        const g = t.unwrapGeometryObject('{"type":"Point","coordinates":[14,51]}');
        expect(g).to.have.property('type', 'Point');
    });

    it('unwraps a GeoJSON Feature', () => {
        const g = t.unwrapGeometryObject({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [14, 51] },
        });
        expect(g).to.have.property('type', 'Point');
    });

    it('returns null for unusable input', () => {
        expect(t.unwrapGeometryObject(null)).to.be.null;
        expect(t.unwrapGeometryObject('not json')).to.be.null;
        expect(t.unwrapGeometryObject(42)).to.be.null;
    });
});

describe('extractPolygonRings', () => {
    it('extracts a Polygon ring', () => {
        const rings = t.extractPolygonRings({
            type: 'Polygon',
            coordinates: [
                [
                    [14.0, 51.0],
                    [14.1, 51.0],
                    [14.1, 51.1],
                    [14.0, 51.0],
                ],
            ],
        });
        expect(rings).to.have.lengthOf(1);
        expect(rings[0]).to.have.lengthOf(4);
    });

    it('extracts every ring of a MultiPolygon', () => {
        const ring = [
            [14.0, 51.0],
            [14.1, 51.0],
            [14.1, 51.1],
        ];
        const rings = t.extractPolygonRings({
            type: 'MultiPolygon',
            coordinates: [[ring], [ring]],
        });
        expect(rings).to.have.lengthOf(2);
    });

    it('rejects a degenerate ring with fewer than 3 points', () => {
        const rings = t.extractPolygonRings({
            type: 'Polygon',
            coordinates: [
                [
                    [14.0, 51.0],
                    [14.1, 51.0],
                ],
            ],
        });
        expect(rings).to.have.lengthOf(0);
    });
});

describe('lonLatToGlobalPixel', () => {
    it('maps 0/0 to the center of the world at any zoom', () => {
        const z = 2;
        const size = Math.pow(2, z) * 256;
        const p = t.lonLatToGlobalPixel(0, 0, z);
        expect(p.x).to.be.closeTo(size / 2, 0.001);
        expect(p.y).to.be.closeTo(size / 2, 0.001);
    });

    it('grows x eastwards and y southwards (Web Mercator)', () => {
        const west = t.lonLatToGlobalPixel(10, 51, 10);
        const east = t.lonLatToGlobalPixel(14, 51, 10);
        expect(east.x).to.be.above(west.x);

        const north = t.lonLatToGlobalPixel(14, 53, 10);
        const south = t.lonLatToGlobalPixel(14, 51, 10);
        expect(south.y).to.be.above(north.y);
    });
});

describe('fitZoomToPolygon', () => {
    const smallRing = [
        [14.0, 51.0],
        [14.001, 51.0],
        [14.001, 51.001],
        [14.0, 51.001],
    ];

    it('never zooms in beyond the configured maximum', () => {
        // DE: Kernzusage: die Konfiguration ist eine Obergrenze, nur Herauszoomen erlaubt.
        // EN: Core guarantee: the configuration is an upper bound, only zooming out is allowed.
        expect(t.fitZoomToPolygon([smallRing], 15, 600, 400)).to.be.at.most(15);
    });

    it('zooms out for a large area so it stays fully visible', () => {
        const largeRing = [
            [13.0, 50.0],
            [15.0, 50.0],
            [15.0, 52.0],
            [13.0, 52.0],
        ];
        const zoom = t.fitZoomToPolygon([largeRing], 19, 600, 400);
        expect(zoom).to.be.below(19);
    });

    it('returns the configured zoom for an empty ring list', () => {
        expect(t.fitZoomToPolygon([], 19, 600, 400)).to.equal(19);
    });
});

describe('state definitions - internal consistency', () => {
    it('has a channel/folder object for every path segment', () => {
        // DE: ioBroker verlangt ein Objekt pro Pfadsegment - ein State unter a.b.c braucht
        // Objekte für a und a.b, sonst entsteht ein kaputter Baum.
        // EN: ioBroker requires an object per path segment - a state at a.b.c needs objects
        // for a and a.b, otherwise the tree is broken.
        const channelIds = new Set(t.CHANNEL_DEFS.map(d => d.id));
        const missing = [];
        for (const def of t.STATE_DEFS) {
            const parts = def.id.split('.');
            for (let i = 1; i < parts.length; i++) {
                const parent = parts.slice(0, i).join('.');
                // DE: info ist der von ioBroker selbst angelegte Standard-Kanal.
                // EN: info is the default channel created by ioBroker itself.
                if (parent !== 'info' && !channelIds.has(parent)) {
                    missing.push(`${def.id} -> missing parent ${parent}`);
                }
            }
        }
        expect(missing, missing.join('; ')).to.be.empty;
    });

    it('has no duplicate state ids', () => {
        const ids = t.STATE_DEFS.map(d => d.id);
        expect(ids).to.have.lengthOf(new Set(ids).size);
    });

    it('declares every state with a type and a role', () => {
        const bad = t.STATE_DEFS.filter(d => !d.type || !d.role).map(d => d.id);
        expect(bad, bad.join(', ')).to.be.empty;
    });

    it('only lists existing states in the special-handling sets', () => {
        const ids = new Set(t.STATE_DEFS.map(d => d.id));
        const check = (set, label) => {
            const unknown = [...set].filter(id => !ids.has(id));
            expect(unknown, `${label}: ${unknown.join(', ')}`).to.be.empty;
        };
        check(t.JSON_ARRAY_STATE_IDS, 'JSON_ARRAY_STATE_IDS');
        check(t.NULLABLE_NUMBER_STATE_IDS, 'NULLABLE_NUMBER_STATE_IDS');
        check(t.RESET_EXCLUDED_STATE_IDS, 'RESET_EXCLUDED_STATE_IDS');
    });

    it('declares every JSON-array state as a string (they hold stringified JSON)', () => {
        const byId = new Map(t.STATE_DEFS.map(d => [d.id, d]));
        for (const id of t.JSON_ARRAY_STATE_IDS) {
            expect(byId.get(id).type, `${id} must be a string state`).to.equal('string');
        }
    });

    it('declares every nullable-number state as a number', () => {
        const byId = new Map(t.STATE_DEFS.map(d => [d.id, d]));
        for (const id of t.NULLABLE_NUMBER_STATE_IDS) {
            expect(byId.get(id).type, `${id} must be a number state`).to.equal('number');
        }
    });

    it('has a state for every allowed incident field', () => {
        // DE: ALLOWED_EINSATZ_FIELDS wird 1:1 nach einsatzAktuell.<feld> geschrieben.
        // EN: ALLOWED_EINSATZ_FIELDS is written 1:1 to einsatzAktuell.<field>.
        const ids = new Set(t.STATE_DEFS.map(d => d.id));
        const missing = t.ALLOWED_EINSATZ_FIELDS.filter(f => !ids.has(`einsatzAktuell.${f}`));
        expect(missing, missing.join(', ')).to.be.empty;
    });

    it('does not list a current state as obsolete', () => {
        // DE: Ein Eintrag in beiden Listen würde das Objekt bei jedem Start löschen und
        // neu anlegen.
        // EN: An entry in both lists would delete and recreate the object on every start.
        const ids = new Set(t.STATE_DEFS.map(d => d.id));
        const channelIds = new Set(t.CHANNEL_DEFS.map(d => d.id));
        const conflictStates = t.OBSOLETE_OBJECT_IDS.filter(id => ids.has(id));
        expect(conflictStates, `also in STATE_DEFS: ${conflictStates.join(', ')}`).to.be.empty;
        const conflictFolders = t.OBSOLETE_FOLDER_IDS.filter(id => channelIds.has(id));
        expect(conflictFolders, `also in CHANNEL_DEFS: ${conflictFolders.join(', ')}`).to.be.empty;
    });
});

describe('WaipWeb.prototype - pure instance helpers', () => {
    /* DE: Methoden, die weder ioBroker-State noch Netzwerk anfassen, lassen sich direkt
       gegen ein Minimalobjekt aufrufen (call statt Instanziierung - der Konstruktor würde
       die Adapter-Basisklasse benötigen).
       EN: Methods touching neither ioBroker state nor the network can be called directly
       against a minimal object (call instead of instantiation - the constructor would
       require the adapter base class). */
    const proto = t.WaipWeb.prototype;

    describe('decodeRettungsdienstStichwort', () => {
        const ctx = {
            rdLabels: { r: 'RTW', n: 'NEF', p: 'Poly', f: 'First', nt: 'NT' },
        };
        const decode = s => proto.decodeRettungsdienstStichwort.call(ctx, s);

        it('decodes the basic R/N scheme', () => {
            expect(decode('R1N0')).to.equal('RTW: 1, NEF: 0');
            expect(decode('R2N1')).to.equal('RTW: 2, NEF: 1');
        });

        it('accepts the Lausitz spelling (no space, hyphen before NT)', () => {
            expect(decode('R1N1p')).to.contain('Poly');
            expect(decode('R1N0-NT')).to.contain('NT');
        });

        it('accepts the Brandenburg/IRLS spelling (space, no hyphen) - the 0.7.23 fix', () => {
            expect(decode('R1N1 p')).to.contain('Poly');
            expect(decode('R1N0 nt')).to.contain('NT');
        });

        it('is case-insensitive', () => {
            expect(decode('r1n0')).to.equal('RTW: 1, NEF: 0');
        });

        it('returns null for a non-matching keyword', () => {
            expect(decode('B2')).to.be.null;
            expect(decode('H:VU mit P')).to.be.null;
            expect(decode('')).to.be.null;
            expect(decode(null)).to.be.null;
        });
    });

    describe('lookupStichwortBeschreibung', () => {
        const makeCtx = (mapping, rdDecoding = false) => ({
            rdKeywordDecodingEnabled: rdDecoding,
            rdLabels: { r: 'RTW', n: 'NEF', p: 'Poly', f: 'First', nt: 'NT' },
            // DE: lookupStichwortBeschreibung() ruft this.decodeRettungsdienstStichwort()
            // auf - der Minimal-Context braucht die Methode also mit.
            // EN: lookupStichwortBeschreibung() calls this.decodeRettungsdienstStichwort() -
            // so the minimal context has to carry that method too.
            decodeRettungsdienstStichwort: proto.decodeRettungsdienstStichwort,
            stichwortMapping: mapping.map(m => ({
                pattern: t.normalizeStichwortForMatch(m.stichwort),
                beschreibung: m.beschreibung,
                matchType: m.matchType || 'startsWith',
            })),
        });
        const lookup = (ctx, s) => proto.lookupStichwortBeschreibung.call(ctx, s);

        it('prefers the longest (most specific) pattern regardless of table order', () => {
            // DE: Damit die Admin-Tabelle gefahrlos alphabetisch sortiert werden kann.
            // EN: So the admin table can be sorted alphabetically without risk.
            const short = { stichwort: 'B:Wald', beschreibung: 'short' };
            const long = { stichwort: 'B:Wald groß/WSP', beschreibung: 'long' };
            expect(lookup(makeCtx([short, long]), 'B:Wald groß/WSP')).to.equal('long');
            expect(lookup(makeCtx([long, short]), 'B:Wald groß/WSP')).to.equal('long');
        });

        it('matches spelling variants via normalization', () => {
            const ctx = makeCtx([{ stichwort: 'H:VU mit P', beschreibung: 'Verkehrsunfall' }]);
            expect(lookup(ctx, 'H:VU-mit-P')).to.equal('Verkehrsunfall');
            expect(lookup(ctx, 'h:vu MIT p')).to.equal('Verkehrsunfall');
        });

        it('honours matchType contains', () => {
            const ctx = makeCtx([{ stichwort: 'BMA', beschreibung: 'Brandmeldeanlage', matchType: 'contains' }]);
            expect(lookup(ctx, 'B:BMA ausgelöst')).to.equal('Brandmeldeanlage');
        });

        it('prefers the rescue-service decoder when enabled', () => {
            const ctx = makeCtx([{ stichwort: 'R1N0', beschreibung: 'from table' }], true);
            expect(lookup(ctx, 'R1N0')).to.equal('RTW: 1, NEF: 0');
        });

        it('falls back to the table when the decoder is disabled', () => {
            const ctx = makeCtx([{ stichwort: 'R1N0', beschreibung: 'from table' }], false);
            expect(lookup(ctx, 'R1N0')).to.equal('from table');
        });

        it('returns null when nothing matches', () => {
            expect(lookup(makeCtx([]), 'B2')).to.be.null;
            expect(lookup(makeCtx([]), '')).to.be.null;
        });
    });

    describe('payloadMonitorMatch', () => {
        const match = (currentMonitor, payload) =>
            proto.payloadMonitorMatch.call({ currentMonitor }, payload);

        it('returns null when no monitor field is present (the normal case for real events)', () => {
            // DE: Reale WAIP-Events tragen KEIN Monitor-Feld - die Zuordnung passiert
            // serverseitig über die Socket.IO-Room-Registrierung.
            // EN: Real WAIP events carry NO monitor field - attribution happens server-side
            // via the Socket.IO room registration.
            expect(match('4', { stichwort: 'B2', uuid: 'abc' })).to.be.null;
        });

        it('ignores wache_nr - the 0.7.19 regression', () => {
            // DE: wache_nr ist die Wachennummer der zurückmeldenden Einsatzkraft, NICHT die
            // Monitor-ID. Wurde sie hier ausgewertet, verwarf der Adapter praktisch jede
            // Rückmeldung als "falscher Monitor".
            // EN: wache_nr is the responding unit's station number, NOT the monitor ID. When
            // it was evaluated here, the adapter discarded practically every feedback event
            // as "wrong monitor".
            expect(match('4', { wache_nr: 17, rmld_uuid: 'x' })).to.be.null;
            expect(match('4', { wache_id: 17 })).to.be.null;
            expect(match('4', { wacheId: 17 })).to.be.null;
        });

        it('matches an explicit monitor field', () => {
            expect(match('4', { monitor: '4' })).to.be.true;
            expect(match('4', { monitor: 4 })).to.be.true;
            expect(match('4', { monitorID: '4' })).to.be.true;
        });

        it('rejects an explicitly different monitor', () => {
            expect(match('4', { monitor: '7' })).to.be.false;
        });

        it('returns null for a non-object payload', () => {
            expect(match('4', null)).to.be.null;
            expect(match('4', 'a string')).to.be.null;
        });
    });

    describe('flattenRoutenEntry', () => {
        it('flattens nested position into sibling lat/lon (VIS widget limitation)', () => {
            const out = proto.flattenRoutenEntry.call({}, {
                nr_wache: 5,
                name_wache: 'FF Musterstadt',
                position: { lat: 51.5, lon: 14.4 },
            });
            expect(out).to.deep.equal({
                nr_wache: 5,
                name_wache: 'FF Musterstadt',
                lat: 51.5,
                lon: 14.4,
            });
            expect(out).to.not.have.property('position');
        });

        it('yields null lat/lon when position is missing', () => {
            const out = proto.flattenRoutenEntry.call({}, { nr_wache: 5 });
            expect(out.lat).to.be.null;
            expect(out.lon).to.be.null;
        });

        it('passes through non-objects unchanged', () => {
            expect(proto.flattenRoutenEntry.call({}, null)).to.be.null;
        });
    });

    describe('computeEmptyStateValue', () => {
        const ctx = {};
        const empty = def => proto.computeEmptyStateValue.call(ctx, def);

        it('empties booleans to false', () => {
            expect(empty({ id: 'einsatzAktuell.alarmAktiv', type: 'boolean' })).to.be.false;
        });

        it('empties ordinary numbers to 0', () => {
            expect(empty({ id: 'einsatzAktuell.restzeit', type: 'number' })).to.equal(0);
        });

        it('empties coordinates to null, not 0 (0/0 is a real position)', () => {
            expect(empty({ id: 'einsatzAktuell.latitude', type: 'number' })).to.be.null;
            expect(empty({ id: 'einsatzAktuell.longitude', type: 'number' })).to.be.null;
            expect(empty({ id: 'einsatzAktuell.id', type: 'number' })).to.be.null;
        });

        it('empties JSON-array states to "[]", not null', () => {
            expect(empty({ id: 'einsatzAktuell.json.routen', type: 'string' })).to.equal('[]');
        });

        it('empties ordinary strings to null', () => {
            expect(empty({ id: 'einsatzAktuell.stichwort', type: 'string' })).to.be.null;
        });
    });

    describe('resolveTtsUrl', () => {
        const resolve = (url, raw) => proto.resolveTtsUrl.call({ url }, raw);

        it('leaves an absolute URL unchanged', () => {
            expect(resolve('https://waip.example', 'https://cdn.example/a.mp3')).to.equal(
                'https://cdn.example/a.mp3',
            );
        });

        it('prefixes a relative path with the configured server URL', () => {
            expect(resolve('https://waip.example', '/tts/x.mp3')).to.equal('https://waip.example/tts/x.mp3');
            expect(resolve('https://waip.example', 'tts/x.mp3')).to.equal('https://waip.example/tts/x.mp3');
        });

        it('does not produce a double slash for a trailing-slash base URL', () => {
            expect(resolve('https://waip.example/', '/tts/x.mp3')).to.equal('https://waip.example/tts/x.mp3');
        });

        it('passes through unusable input', () => {
            expect(resolve('https://waip.example', '')).to.equal('');
            expect(resolve('https://waip.example', null)).to.be.null;
        });
    });
});

describe('deriveDashboardJsonArrayStateIds/deriveDashboardNullableNumberStateIds', () => {
    it('derives json-array ids only from string/json-role defs', () => {
        const defs = t.buildDashboardStateDefs(1);
        const ids = t.deriveDashboardJsonArrayStateIds(defs);
        expect(ids.has('dashboard.einsatz1.json.current')).to.be.true;
        expect(ids.has('dashboard.einsatz1.json.wachen')).to.be.true;
        expect(ids.has('dashboard.einsatz1.stichwort')).to.be.false;
    });

    it('derives nullable-number ids only for id/latitude/longitude', () => {
        const defs = t.buildDashboardStateDefs(1);
        const ids = t.deriveDashboardNullableNumberStateIds(defs);
        expect(ids.has('dashboard.einsatz1.id')).to.be.true;
        expect(ids.has('dashboard.einsatz1.latitude')).to.be.true;
        expect(ids.has('dashboard.einsatz1.longitude')).to.be.true;
        expect(ids.has('dashboard.einsatz1.sondersignal')).to.be.false; // ordinary number, stays 0
        expect(ids.has('dashboard.einsatz1.routenGesamt')).to.be.false;
    });

    it('never drifts out of sync when buildDashboardStateDefs changes slot count', () => {
        const defs2 = t.buildDashboardStateDefs(2);
        const jsonIds = t.deriveDashboardJsonArrayStateIds(defs2);
        const numIds = t.deriveDashboardNullableNumberStateIds(defs2);
        // 5 json.* states per slot * 2 slots
        expect(jsonIds.size).to.equal(10);
        // id/latitude/longitude per slot * 2 slots
        expect(numIds.size).to.equal(6);
    });
});

describe('WaipWeb - syncDashboardObjects / deleteObjectTreeAsync (mocked ioBroker core)', () => {
    /* DE: Nutzt @iobroker/testing's createMocks() für eine In-Memory-Objekt-DB - siehe Skill
       iobroker-adapter-development, Abschnitt Testing. delObjectAsync fehlt im Mock (bekannte
       Lücke, siehe dort) und wird hier nachgerüstet.
       EN: Uses @iobroker/testing's createMocks() for an in-memory object DB - see the
       iobroker-adapter-development skill, Testing section. delObjectAsync is missing from
       the mock (known gap, see there) and is patched on here. */
    const { utils } = require('@iobroker/testing');

    function makeInstance({ dashboardEnabled, dashboardSlotCount, existingIds = [] }) {
        const { database, adapter } = utils.unit.createMocks({ name: 'waip-web', instance: 0 });
        adapter.delObjectAsync = id =>
            new Promise((res, rej) => adapter.delObject(id, e => (e ? rej(e) : res())));
        for (const id of existingIds) {
            database.publishObject({ _id: `${adapter.namespace}.${id}`, type: id.includes('.') ? 'channel' : 'channel', common: { name: id }, native: {} });
        }
        const inst = Object.create(t.WaipWeb.prototype);
        Object.assign(inst, adapter);
        inst.getObjectAsync = adapter.getObjectAsync;
        inst.getObjectListAsync = adapter.getObjectListAsync;
        inst.delObjectAsync = adapter.delObjectAsync;
        inst.namespace = adapter.namespace;
        inst.log = adapter.log;
        inst.dashboardEnabled = dashboardEnabled;
        inst.dashboardSlotCount = dashboardSlotCount;
        inst.appendMonitorAudit = () => Promise.resolve();
        return { inst, database, adapter };
    }

    function objectIds(database, adapter) {
        return Object.keys(database.getObjects(`${adapter.namespace}.*`));
    }

    it('Fall A: deaktiviert + bestehender dashboard-Kanal -> wird komplett entfernt', async () => {
        const { inst, database, adapter } = makeInstance({
            dashboardEnabled: false,
            dashboardSlotCount: 10,
            existingIds: [
                'dashboard',
                'dashboard.einsatz1',
                'dashboard.einsatz1.stichwort',
                'dashboard.einsatz2',
                'dashboard.einsatz2.stichwort',
            ],
        });
        await inst.syncDashboardObjects();
        const remaining = objectIds(database, adapter).filter(id => id.includes('.dashboard'));
        expect(remaining).to.be.empty;
    });

    it('Fall A2: deaktiviert + kein dashboard-Kanal -> no-op, kein Fehler', async () => {
        const { inst, database, adapter } = makeInstance({ dashboardEnabled: false, dashboardSlotCount: 10 });
        await inst.syncDashboardObjects();
        expect(objectIds(database, adapter).filter(id => id.includes('.dashboard'))).to.be.empty;
    });

    it('Fall B: aktiv, Slot-Anzahl 10 -> 5 -> Slots 6-10 entfernt, 1-5 bleiben', async () => {
        const existingIds = ['dashboard'];
        for (let i = 1; i <= 10; i++) {
            existingIds.push(`dashboard.einsatz${i}`, `dashboard.einsatz${i}.stichwort`);
        }
        const { inst, database, adapter } = makeInstance({ dashboardEnabled: true, dashboardSlotCount: 5, existingIds });
        await inst.syncDashboardObjects();
        const remaining = objectIds(database, adapter).filter(id => id.includes('.dashboard.einsatz'));
        for (let i = 1; i <= 5; i++) {
            expect(remaining.some(id => id.endsWith(`.dashboard.einsatz${i}`))).to.be.true;
        }
        for (let i = 6; i <= 10; i++) {
            expect(remaining.some(id => id.includes(`.dashboard.einsatz${i}`))).to.be.false;
        }
    });

    it('Fall C: aktiv, Slot-Anzahl 5 -> 10 -> keine Löschung (initObjects legt 6-10 neu an)', async () => {
        const existingIds = ['dashboard'];
        for (let i = 1; i <= 5; i++) {
            existingIds.push(`dashboard.einsatz${i}`, `dashboard.einsatz${i}.stichwort`);
        }
        const { inst, database, adapter } = makeInstance({ dashboardEnabled: true, dashboardSlotCount: 10, existingIds });
        await inst.syncDashboardObjects();
        const remaining = objectIds(database, adapter).filter(id => id.includes('.dashboard.einsatz'));
        for (let i = 1; i <= 5; i++) {
            expect(remaining.some(id => id.endsWith(`.dashboard.einsatz${i}`))).to.be.true;
        }
    });

    it('Fall D: Reaktivierung nach vollständiger Löschung -> kein dashboard-Kanal, kein Fehler', async () => {
        const { inst, database, adapter } = makeInstance({ dashboardEnabled: true, dashboardSlotCount: 10 });
        await inst.syncDashboardObjects();
        expect(objectIds(database, adapter).filter(id => id.includes('.dashboard'))).to.be.empty;
    });

    it('deleteObjectTreeAsync removes children before the parent, root last', async () => {
        const { inst, database, adapter } = makeInstance({
            dashboardEnabled: false,
            dashboardSlotCount: 10,
            existingIds: ['dashboard', 'dashboard.einsatz1', 'dashboard.einsatz1.json', 'dashboard.einsatz1.json.current'],
        });
        await inst.deleteObjectTreeAsync('dashboard');
        expect(objectIds(database, adapter).filter(id => id.includes('.dashboard'))).to.be.empty;
    });
});

describe('fetchDbrdList', () => {
    const proto = t.WaipWeb.prototype;

    // DE: Nachgebildetes /dbrd/-HTML, angelehnt an das live verifizierte Format
    // (Plandokument Abschnitt 1): ein serverseitig gerendertes Grundgerüst mit einem
    // eingebetteten <script>-Block, der `let data = [...]` enthält. Das GeoJSON-Feld
    // enthält bewusst eigene eckige Klammern (Polygon-Koordinaten), um die
    // Balanced-Bracket-Extraktion gegen ein zu simples "erstes ]"-Regex abzusichern.
    // EN: Reconstructed /dbrd/ HTML, modeled on the live-verified format (plan document
    // section 1): a server-rendered skeleton with an embedded <script> block containing
    // `let data = [...]`. The GeoJSON field deliberately contains its own square brackets
    // (polygon coordinates) to guard the balanced-bracket extraction against a
    // too-simple "first ]" regex.
    function makeHtml(entries) {
        return `<!DOCTYPE html><html><body><div id="app"></div>
<script>
let data = ${JSON.stringify(entries)};
renderDashboard(data);
</script>
</body></html>`;
    }

    const sampleEntry = {
        uuid: '40411df6-1081-483c-4edb-d1e740bdc943',
        einsatzart: 'Hilfeleistungseinsatz',
        stichwort: 'H:VU-mit-P',
        ort: 'Burg (Spreewald)',
        ortsteil: null,
        geometry:
            '{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[14.1,51.7],[14.2,51.7],[14.2,51.8]]]}}',
        l: '4',
        a: '71',
        b: '7105',
        c: '710512,710506,710503',
    };

    function makeInstance(body, statusCode = 200) {
        const inst = Object.create(proto);
        inst.url = 'https://waip.example';
        inst.httpGet = async () => ({ statusCode, body });
        return inst;
    }

    it('extracts the embedded data array, including entries with nested brackets in geometry', async () => {
        const inst = makeInstance(makeHtml([sampleEntry]));
        const list = await inst.fetchDbrdList();
        expect(list).to.have.lengthOf(1);
        expect(list[0].uuid).to.equal(sampleEntry.uuid);
        expect(list[0].l).to.equal('4');
        expect(list[0].c).to.equal('710512,710506,710503');
        expect(JSON.parse(list[0].geometry).geometry.coordinates[0]).to.have.lengthOf(3);
    });

    it('returns an empty array for an empty data array (no active incidents)', async () => {
        const inst = makeInstance(makeHtml([]));
        const list = await inst.fetchDbrdList();
        expect(list).to.deep.equal([]);
    });

    it('handles multiple entries', async () => {
        const second = { ...sampleEntry, uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', l: '4', a: '71', b: '7105', c: '710503' };
        const inst = makeInstance(makeHtml([sampleEntry, second]));
        const list = await inst.fetchDbrdList();
        expect(list).to.have.lengthOf(2);
        expect(list.map(e => e.uuid)).to.deep.equal([sampleEntry.uuid, second.uuid]);
    });

    it('throws when the URL is not configured', async () => {
        const inst = makeInstance('');
        inst.url = '';
        let threw = false;
        try {
            await inst.fetchDbrdList();
        } catch (e) {
            threw = true;
            expect(e.message).to.match(/no WAIP server URL configured/);
        }
        expect(threw).to.be.true;
    });

    it('throws on a non-200 status', async () => {
        const inst = makeInstance('not found', 404);
        let threw = false;
        try {
            await inst.fetchDbrdList();
        } catch (e) {
            threw = true;
            expect(e.message).to.match(/status 404/);
        }
        expect(threw).to.be.true;
    });

    it('throws when the page has no embedded data array (server format changed)', async () => {
        const inst = makeInstance('<html><body>no dashboard here</body></html>');
        let threw = false;
        try {
            await inst.fetchDbrdList();
        } catch (e) {
            threw = true;
            expect(e.message).to.match(/could not find/);
        }
        expect(threw).to.be.true;
    });

    it('throws on malformed JSON inside the data array', async () => {
        const html = `<script>let data = [ { uuid: 'unquoted-key-is-invalid-json' } ];</script>`;
        const inst = makeInstance(html);
        let threw = false;
        try {
            await inst.fetchDbrdList();
        } catch (e) {
            threw = true;
            expect(e.message).to.match(/could not parse/);
        }
        expect(threw).to.be.true;
    });
});

describe('fetchDbrdDetail', () => {
    const proto = t.WaipWeb.prototype;

    /* DE: Minimaler Fake-Socket (EventEmitter-Stil) statt eines echten socket.io-Servers -
       trigger() simuliert einen eingehenden Server-Event, emit()/on() spiegeln die vom
       Code tatsächlich genutzte socket.io-client-API.
       EN: Minimal fake socket (EventEmitter-style) instead of a real socket.io server -
       trigger() simulates an incoming server event, emit()/on() mirror the socket.io-client
       API the code actually uses. */
    class FakeSocket {
        constructor() {
            this.handlers = {};
            this.emitted = [];
            this.disconnected = false;
        }
        on(event, handler) {
            (this.handlers[event] = this.handlers[event] || []).push(handler);
        }
        emit(event, data) {
            this.emitted.push([event, data]);
        }
        removeAllListeners() {
            this.handlers = {};
        }
        disconnect() {
            this.disconnected = true;
        }
        trigger(event, data) {
            for (const h of this.handlers[event] || []) {
                h(data);
            }
        }
    }

    // DE: setTimeout/clearTimeout werden durch manuell steuerbare Fakes ersetzt (kein
    // sinon/fake-timer-Setup nötig) - der Test feuert die Timer-Callbacks gezielt selbst,
    // statt DASHBOARD_CONNECT_TIMEOUT_MS/DASHBOARD_COLLECT_WINDOW_MS real abzuwarten.
    // EN: setTimeout/clearTimeout are replaced by manually controllable fakes (no
    // sinon/fake-timer setup needed) - the test fires the timer callbacks itself instead
    // of actually waiting out DASHBOARD_CONNECT_TIMEOUT_MS/DASHBOARD_COLLECT_WINDOW_MS.
    function makeInstance() {
        const socket = new FakeSocket();
        const timers = [];
        const inst = Object.create(proto);
        inst.url = 'https://waip.example';
        inst.sessionCookie = null;
        inst.ioClientFactory = () => socket;
        inst.setTimeout = (fn, ms) => {
            const handle = { fn, ms, cleared: false };
            timers.push(handle);
            return handle;
        };
        inst.clearTimeout = handle => {
            handle.cleared = true;
        };
        inst.safeLog = () => {};
        return { inst, socket, timers };
    }

    const sampleEinsatz = { id: 1607178, uuid: 'fbacf1ff-uuid', einsatzart: 'Hilfeleistungseinsatz', stichwort: 'H:VU-mit-P' };

    it('collects einsatz/routes/rueckmeldungen on a normal successful cycle', async () => {
        const { inst, socket, timers } = makeInstance();
        const promise = inst.fetchDbrdDetail('fbacf1ff-uuid');

        socket.trigger('connect');
        expect(socket.emitted).to.deep.equal([['dbrd', 'fbacf1ff-uuid']]);

        socket.trigger('io.Einsatz', sampleEinsatz);
        socket.trigger('io.routes', [{ nr_wache: 5 }]);
        socket.trigger('io.new_rmld', { rmld_uuid: 'a' });
        socket.trigger('io.new_rmld', { rmld_uuid: 'b' });

        // DE: den Sammelfenster-Timer (nach io.Einsatz gesetzt, kürzer als der
        // Verbindungs-Timeout) manuell auslösen - über den ms-Wert unterschieden, da beide
        // Timer-Callbacks "finish" im Funktionstext enthalten.
        // EN: manually fire the collection-window timer (set after io.Einsatz, shorter
        // than the connect timeout) - distinguished by the ms value, since both timer
        // callbacks contain "finish" in their function text.
        const collectTimer = timers.find(tm => tm.ms === 2000);
        collectTimer.fn();

        const result = await promise;
        expect(result.einsatz).to.deep.equal(sampleEinsatz);
        expect(result.routes).to.deep.equal([{ nr_wache: 5 }]);
        expect(result.rueckmeldungen).to.deep.equal([{ rmld_uuid: 'a' }, { rmld_uuid: 'b' }]);
        expect(socket.disconnected).to.be.true;
    });

    it('resolves to "timeout" on a connect timeout (distinguished from io.error/io.deleted for logRecurringFailure)', async () => {
        const { inst, timers } = makeInstance();
        const promise = inst.fetchDbrdDetail('some-uuid');

        // DE: nie 'connect' auslösen, stattdessen den Verbindungs-Timeout-Timer selbst feuern.
        // EN: never fire 'connect', instead trigger the connection-timeout timer itself.
        timers[0].fn();

        const result = await promise;
        expect(result).to.equal('timeout');
    });

    it('resolves to null on io.error (incident already gone, race with /dbrd/ listing)', async () => {
        const { inst, socket } = makeInstance();
        const promise = inst.fetchDbrdDetail('some-uuid');
        socket.trigger('connect');
        socket.trigger('io.error', 'Einsatz ist nicht mehr vorhanden (Anfrage lieferte kein Ergebnis)!');
        const result = await promise;
        expect(result).to.be.null;
        expect(socket.disconnected).to.be.true;
    });

    it('resolves to null on io.deleted', async () => {
        const { inst, socket } = makeInstance();
        const promise = inst.fetchDbrdDetail('some-uuid');
        socket.trigger('connect');
        socket.trigger('io.deleted');
        const result = await promise;
        expect(result).to.be.null;
    });

    it('resolves to "timeout" on connect_error', async () => {
        const { inst, socket } = makeInstance();
        const promise = inst.fetchDbrdDetail('some-uuid');
        socket.trigger('connect_error', new Error('ECONNREFUSED'));
        const result = await promise;
        expect(result).to.equal('timeout');
    });

    it('ignores a second terminal event after the first one already settled the promise', async () => {
        // DE: Absicherung gegen einen doppelten finish()-Aufruf (z.B. io.error gefolgt von
        // einem verzögerten io.deleted) - darf die bereits aufgelöste Promise nicht erneut anfassen.
        // EN: Guards against a double finish() call (e.g. io.error followed by a delayed
        // io.deleted) - must not touch the already-settled promise again.
        const { inst, socket } = makeInstance();
        const promise = inst.fetchDbrdDetail('some-uuid');
        socket.trigger('connect');
        socket.trigger('io.error', 'gone');
        socket.trigger('io.deleted');
        const result = await promise;
        expect(result).to.be.null;
    });

    it('defaults routes to an empty array when the server sends a non-array', async () => {
        const { inst, socket, timers } = makeInstance();
        const promise = inst.fetchDbrdDetail('some-uuid');
        socket.trigger('connect');
        socket.trigger('io.Einsatz', sampleEinsatz);
        socket.trigger('io.routes', null);
        const collectTimer = timers.find(tm => tm.ms === 2000);
        collectTimer.fn();
        const result = await promise;
        expect(result.routes).to.deep.equal([]);
    });
});

describe('updateRueckmeldungCounts (parametrized, plan document section 4.8)', () => {
    const proto = t.WaipWeb.prototype;

    // DE: rmld_role deckt EK/GF/ZF/VF ab, die rmld_capability_*-Flags AGT/FZF/MA/MED -
    // eine Rückmeldung kann beides gleichzeitig tragen (z.B. Gruppenführer, der zugleich
    // Atemschutzgeräteträger ist).
    // EN: rmld_role covers EK/GF/ZF/VF, the rmld_capability_* flags cover AGT/FZF/MA/MED -
    // a single feedback entry can carry both at once (e.g. a crew leader who is also an
    // apparatus wearer).
    const sampleRueckmeldungen = [
        { rmld_role: 'team_member', rmld_capability_agt: '1' },
        { rmld_role: 'team_member' },
        { rmld_role: 'crew_leader', rmld_capability_fzf: '1' },
        { rmld_role: 'division_chief' },
        { rmld_role: 'group_commander' },
        { rmld_capability_ma: '1' },
        { rmld_capability_med: '1' },
    ];

    function makeInstance() {
        const written = {};
        const inst = Object.create(proto);
        inst.setStateAsync = async (id, val) => {
            written[id] = val;
        };
        inst.safeWarn = () => {};
        return { inst, written };
    }

    it('writes the expected counts under the given statePrefix (einsatzAktuell.*, regression for the pre-4.8 behavior)', async () => {
        const { inst, written } = makeInstance();
        await inst.updateRueckmeldungCounts(sampleRueckmeldungen, 'einsatzAktuell');
        expect(written['einsatzAktuell.rueckmeldungen.rollen.ek']).to.equal(2);
        expect(written['einsatzAktuell.rueckmeldungen.rollen.gf']).to.equal(1);
        expect(written['einsatzAktuell.rueckmeldungen.rollen.zf']).to.equal(1);
        expect(written['einsatzAktuell.rueckmeldungen.rollen.vf']).to.equal(1);
        expect(written['einsatzAktuell.rueckmeldungen.funktionen.agt']).to.equal(1);
        expect(written['einsatzAktuell.rueckmeldungen.funktionen.fzf']).to.equal(1);
        expect(written['einsatzAktuell.rueckmeldungen.funktionen.ma']).to.equal(1);
        expect(written['einsatzAktuell.rueckmeldungen.funktionen.med']).to.equal(1);
        expect(written['einsatzAktuell.rueckmeldungenGesamt']).to.equal(sampleRueckmeldungen.length);
    });

    it('writes to a dashboard slot prefix with the identical counting logic', async () => {
        const { inst, written } = makeInstance();
        await inst.updateRueckmeldungCounts(sampleRueckmeldungen, 'dashboard.einsatz3');
        expect(written['dashboard.einsatz3.rueckmeldungen.rollen.ek']).to.equal(2);
        expect(written['dashboard.einsatz3.rueckmeldungen.funktionen.med']).to.equal(1);
        expect(written['dashboard.einsatz3.rueckmeldungenGesamt']).to.equal(sampleRueckmeldungen.length);
        // DE: keine Vermischung mit dem einsatzAktuell.*-Präfix.
        // EN: no bleed-over into the einsatzAktuell.* prefix.
        expect(written['einsatzAktuell.rueckmeldungenGesamt']).to.be.undefined;
    });

    it('resets all counters to 0 for an empty/null rueckmeldungen list (e.g. after a standby reset)', async () => {
        const { inst, written } = makeInstance();
        await inst.updateRueckmeldungCounts(null, 'einsatzAktuell');
        expect(written['einsatzAktuell.rueckmeldungen.rollen.ek']).to.equal(0);
        expect(written['einsatzAktuell.rueckmeldungen.funktionen.med']).to.equal(0);
        expect(written['einsatzAktuell.rueckmeldungenGesamt']).to.equal(0);
    });

    it('two slots with different rueckmeldungen never cross-contaminate their counts', async () => {
        const { inst, written } = makeInstance();
        await inst.updateRueckmeldungCounts([{ rmld_role: 'team_member' }], 'dashboard.einsatz1');
        await inst.updateRueckmeldungCounts(
            [{ rmld_role: 'crew_leader' }, { rmld_role: 'crew_leader' }],
            'dashboard.einsatz2',
        );
        expect(written['dashboard.einsatz1.rueckmeldungen.rollen.ek']).to.equal(1);
        expect(written['dashboard.einsatz1.rueckmeldungen.rollen.gf']).to.equal(0);
        expect(written['dashboard.einsatz2.rueckmeldungen.rollen.gf']).to.equal(2);
        expect(written['dashboard.einsatz2.rueckmeldungen.rollen.ek']).to.equal(0);
    });
});

describe('resolveDashboardMapImage', () => {
    const proto = t.WaipWeb.prototype;
    const fsPromises = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');

    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'waip-web-mapimg-'));
    });

    afterEach(async () => {
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
    });

    function makeInstance() {
        const inst = Object.create(proto);
        inst.mapImageDir = tmpDir;
        inst.safeLog = () => {};
        return inst;
    }

    async function touch(filename) {
        await fsPromises.writeFile(path.join(tmpDir, filename), '');
    }

    it('finds the map image matching the uuid fragment (same truncation as generateEinsatzMapImage)', async () => {
        const inst = makeInstance();
        await touch('einsatz_1000_40411df6.png');
        const result = await inst.resolveDashboardMapImage('40411df6-1081-483c-4edb-d1e740bdc943');
        expect(result).to.equal(path.join(tmpDir, 'einsatz_1000_40411df6.png'));
    });

    it('returns null when no file matches the fragment (no map image was ever generated for this incident)', async () => {
        const inst = makeInstance();
        await touch('einsatz_1000_aaaaaaaa.png');
        const result = await inst.resolveDashboardMapImage('40411df6-1081-483c-4edb-d1e740bdc943');
        expect(result).to.be.null;
    });

    it('returns the newest match on a fragment collision (highest timestamp prefix wins)', async () => {
        const inst = makeInstance();
        await touch('einsatz_1000_40411df6.png');
        await touch('einsatz_9999_40411df6.png');
        await touch('einsatz_5000_40411df6.png');
        const result = await inst.resolveDashboardMapImage('40411df6-1081-483c-4edb-d1e740bdc943');
        expect(result).to.equal(path.join(tmpDir, 'einsatz_9999_40411df6.png'));
    });

    it('returns null for an empty/missing uuid without touching the filesystem', async () => {
        const inst = makeInstance();
        expect(await inst.resolveDashboardMapImage('')).to.be.null;
        expect(await inst.resolveDashboardMapImage(null)).to.be.null;
    });

    it('returns null (not a thrown error) when mapImageDir does not exist', async () => {
        const inst = makeInstance();
        inst.mapImageDir = path.join(tmpDir, 'does-not-exist');
        const result = await inst.resolveDashboardMapImage('40411df6-1081-483c-4edb-d1e740bdc943');
        expect(result).to.be.null;
    });

    it('ignores files not matching the einsatz_*.png naming convention', async () => {
        const inst = makeInstance();
        await touch('other_1000_40411df6.png');
        await touch('einsatz_1000_40411df6.txt');
        const result = await inst.resolveDashboardMapImage('40411df6-1081-483c-4edb-d1e740bdc943');
        expect(result).to.be.null;
    });
});

describe('refreshDashboard / _refreshDashboardNow (orchestration, plan document section 4.1/4.3/4.7)', () => {
    const proto = t.WaipWeb.prototype;

    // DE: 3 Slots statt der Default-10 halten die Testfälle übersichtlich - die Logik
    // skaliert nicht mit der Slot-Anzahl.
    // EN: 3 slots instead of the default 10 keep the test cases manageable - the logic
    // doesn't scale with slot count.
    const SLOT_COUNT = 3;

    function makeInstance(overrides = {}) {
        const written = {};
        const dashboardStateDefs = t.buildDashboardStateDefs(SLOT_COUNT);
        const inst = Object.create(proto);
        Object.assign(
            inst,
            {
                dashboardEnabled: true,
                dashboardSlotCount: SLOT_COUNT,
                dashboardStateDefs,
                dashboardJsonArrayStateIds: t.deriveDashboardJsonArrayStateIds(dashboardStateDefs),
                dashboardNullableNumberStateIds: t.deriveDashboardNullableNumberStateIds(dashboardStateDefs),
                monitorID: '0',
                mapImageDir: '/does/not/exist/on/this/machine',
                stichwortMapping: [],
                rdKeywordDecodingEnabled: false,
                log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
                _recurringFailureKeys: new Set(),
                _warnCache: new Map(),
                _monitorAuditQueue: Promise.resolve(),
                _monitorAuditCache: null,
                _dashboardRefreshQueue: Promise.resolve(),
                _dashboardRefreshFirstCycleDone: false,
                getStateAsync: async () => null,
                setStateAsync: async (id, val) => {
                    written[id] = val;
                },
                fetchDbrdList: async () => [],
                fetchDbrdDetail: async () => null,
            },
            overrides,
        );
        return { inst, written };
    }

    function sampleListingEntry(uuid, overrides = {}) {
        return { uuid, einsatzart: 'Hilfeleistungseinsatz', stichwort: 'H:VU-mit-P', ort: 'Burg', ortsteil: null, l: '4', a: '71', b: '7105', c: '710512,710506,710503', ...overrides };
    }

    function sampleDetail(overrides = {}) {
        return {
            einsatz: { id: 1607178, uuid: 'fbacf1ff-uuid', einsatzart: 'Hilfeleistungseinsatz', stichwort: 'H:VU-mit-P', ort: 'Burg', ortsteil: null, sondersignal: 1, einsatzmittel: [], wachen: [] },
            routes: [],
            rueckmeldungen: [],
            ...overrides,
        };
    }

    it('fills matching slots and clears the remaining ones (fewer incidents than slots)', async () => {
        const entry1 = sampleListingEntry('11111111-1111-1111-1111-111111111111');
        const { inst, written } = makeInstance({
            fetchDbrdList: async () => [entry1],
            fetchDbrdDetail: async uuid =>
                uuid === entry1.uuid ? sampleDetail({ einsatz: { ...sampleDetail().einsatz, uuid } }) : null,
        });
        await inst.refreshDashboard();
        expect(written['dashboard.einsatz1.alarmAktiv']).to.equal(true);
        expect(written['dashboard.einsatz1.uuid']).to.equal(entry1.uuid);
        // DE: unbelegte Slots 2/3 tragen die Leerwerte statt der Slot-1-Daten.
        // EN: unoccupied slots 2/3 carry the empty values instead of slot 1's data.
        expect(written['dashboard.einsatz2.alarmAktiv']).to.equal(false);
        expect(written['dashboard.einsatz2.uuid']).to.be.null;
        expect(written['dashboard.einsatz3.alarmAktiv']).to.equal(false);
    });

    it('maps filtered incidents onto slots 1..N positionally, respecting server order', async () => {
        const entry1 = sampleListingEntry('11111111-1111-1111-1111-111111111111');
        const entry2 = sampleListingEntry('22222222-2222-2222-2222-222222222222', { ort: 'Elsterwerda' });
        const { inst, written } = makeInstance({
            fetchDbrdList: async () => [entry1, entry2],
            fetchDbrdDetail: async uuid =>
                sampleDetail({
                    einsatz: {
                        ...sampleDetail().einsatz,
                        uuid,
                        ort: uuid === entry1.uuid ? entry1.ort : entry2.ort,
                    },
                }),
        });
        await inst.refreshDashboard();
        expect(written['dashboard.einsatz1.uuid']).to.equal(entry1.uuid);
        expect(written['dashboard.einsatz1.ort']).to.equal('Burg');
        expect(written['dashboard.einsatz2.uuid']).to.equal(entry2.uuid);
        expect(written['dashboard.einsatz2.ort']).to.equal('Elsterwerda');
        expect(written['dashboard.einsatz3.alarmAktiv']).to.equal(false);
    });

    it('excludes incidents that do not match the configured monitorID before connecting', async () => {
        const matching = sampleListingEntry('11111111-1111-1111-1111-111111111111', { l: '4', a: '71', b: '7105', c: '710503' });
        const nonMatching = sampleListingEntry('99999999-9999-9999-9999-999999999999', { l: '9', a: '99', b: '9999', c: '999999' });
        let detailCalls = 0;
        const { inst, written } = makeInstance({
            monitorID: '71',
            fetchDbrdList: async () => [nonMatching, matching],
            fetchDbrdDetail: async uuid => {
                detailCalls++;
                return sampleDetail({ einsatz: { ...sampleDetail().einsatz, uuid } });
            },
        });
        await inst.refreshDashboard();
        // DE: nur EIN fetchDbrdDetail-Aufruf - der nicht-passende Eintrag wurde bereits vor
        // dem Verbindungsaufbau ausgefiltert (Plandokument Frage 9).
        // EN: only ONE fetchDbrdDetail call - the non-matching entry was already filtered
        // out before the connection attempt (plan document question 9).
        expect(detailCalls).to.equal(1);
        expect(written['dashboard.einsatz1.uuid']).to.equal(matching.uuid);
    });

    it('clamps to dashboardSlotCount when more matching incidents exist than slots', async () => {
        const entries = [
            sampleListingEntry('11111111-1111-1111-1111-111111111111'),
            sampleListingEntry('22222222-2222-2222-2222-222222222222'),
            sampleListingEntry('33333333-3333-3333-3333-333333333333'),
            sampleListingEntry('44444444-4444-4444-4444-444444444444'),
        ];
        let detailCalls = 0;
        const { inst, written } = makeInstance({
            fetchDbrdList: async () => entries,
            fetchDbrdDetail: async uuid => {
                detailCalls++;
                return sampleDetail({ einsatz: { ...sampleDetail().einsatz, uuid } });
            },
        });
        await inst.refreshDashboard();
        expect(detailCalls).to.equal(SLOT_COUNT);
        expect(written['dashboard.einsatz3.uuid']).to.equal(entries[2].uuid);
    });

    it('treats a slot returning null (io.error/io.deleted race) as empty, without aborting the cycle', async () => {
        const gone = sampleListingEntry('11111111-1111-1111-1111-111111111111');
        const ok = sampleListingEntry('22222222-2222-2222-2222-222222222222');
        const { inst, written } = makeInstance({
            fetchDbrdList: async () => [gone, ok],
            fetchDbrdDetail: async uuid =>
                uuid === gone.uuid ? null : sampleDetail({ einsatz: { ...sampleDetail().einsatz, uuid } }),
        });
        await inst.refreshDashboard();
        expect(written['dashboard.einsatz1.alarmAktiv']).to.equal(false);
        expect(written['dashboard.einsatz2.uuid']).to.equal(ok.uuid);
    });

    it('normalizes route entries before writing them (regression: raw geometry/coords must not leak through)', async () => {
        // DE: Regressionstest für den Bugfix - vor der Korrektur wurde normalizeData() auf
        // Routen im Dashboard-Pfad gar nicht aufgerufen, sodass ein kompletter LineString
        // (viele Koordinatenpaare) oder das rohe coords-Fallback-Feld unverändert im
        // geschriebenen JSON landeten, statt zu flachen lat/lon-Feldern aufgelöst zu werden.
        // EN: Regression test for the bug fix - before the correction, normalizeData() was
        // never called on routes in the dashboard path, so a complete LineString (many
        // coordinate pairs) or the raw coords fallback field ended up unchanged in the
        // written JSON, instead of being resolved into flat lat/lon fields.
        const entry1 = sampleListingEntry('11111111-1111-1111-1111-111111111111');
        const { inst, written } = makeInstance({
            fetchDbrdList: async () => [entry1],
            fetchDbrdDetail: async uuid =>
                sampleDetail({
                    einsatz: { ...sampleDetail().einsatz, uuid },
                    routes: [
                        {
                            nr_wache: 730310,
                            name_wache: 'UM FW Schwedt HAK',
                            color: '#bf360c',
                            geometry: {
                                type: 'LineString',
                                coordinates: [
                                    [14.282139, 53.054951],
                                    [14.303245, 53.072857],
                                ],
                            },
                        },
                        {
                            nr_wache: 610703,
                            name_wache: 'LDS FW Miersdorf',
                            color: '#00838f',
                            coords: [52.34045015968357, 13.610583938139387],
                        },
                    ],
                }),
        });
        await inst.refreshDashboard();
        const routen = JSON.parse(written['dashboard.einsatz1.json.routen']);
        expect(routen).to.have.lengthOf(2);
        // DE: Erster Eintrag: geometry ist weg, lat/lon entsprechen dem ersten Linienpunkt.
        // EN: First entry: geometry is gone, lat/lon match the first line point.
        expect(routen[0]).to.not.have.property('geometry');
        expect(routen[0].lat).to.equal(53.054951);
        expect(routen[0].lon).to.equal(14.282139);
        // DE: Zweiter Eintrag: coords ist weg, lat/lon entsprechen dem coords-Fallback-Wert.
        // EN: Second entry: coords is gone, lat/lon match the coords fallback value.
        expect(routen[1]).to.not.have.property('coords');
        expect(routen[1].lat).to.equal(52.34045015968357);
        expect(routen[1].lon).to.equal(13.610583938139387);
    });

    it('treats a slot timeout as empty and logs a recurring warning', async () => {
        const timedOut = sampleListingEntry('11111111-1111-1111-1111-111111111111');
        const warnings = [];
        const { inst, written } = makeInstance({
            fetchDbrdList: async () => [timedOut],
            fetchDbrdDetail: async () => 'timeout',
            log: { info: () => {}, debug: () => {}, warn: msg => warnings.push(msg), error: () => {} },
        });
        await inst.refreshDashboard();
        expect(written['dashboard.einsatz1.alarmAktiv']).to.equal(false);
        expect(warnings.some(w => /timed out/.test(w))).to.be.true;
    });

    it('logs the first successful cycle to the monitor audit log exactly once', async () => {
        const entry1 = sampleListingEntry('11111111-1111-1111-1111-111111111111');
        const { inst, written } = makeInstance({
            fetchDbrdList: async () => [entry1],
            fetchDbrdDetail: async uuid => sampleDetail({ einsatz: { ...sampleDetail().einsatz, uuid } }),
        });
        await inst.refreshDashboard();
        await inst.refreshDashboard();
        const audit = JSON.parse(written['debug.monitorAudit']);
        const refreshEntries = audit.filter(e => e.event === 'dashboard_refresh');
        expect(refreshEntries).to.have.lengthOf(1);
        expect(refreshEntries[0].slotsFilled).to.equal(1);
        expect(refreshEntries[0].slotsTotal).to.equal(SLOT_COUNT);
    });

    it('a listing fetch failure is caught, logged, and does not throw', async () => {
        const { inst } = makeInstance({
            fetchDbrdList: async () => {
                throw new Error('ECONNREFUSED');
            },
        });
        await inst.refreshDashboard();
        // DE: kein Wurf bis hierher = Erfolg. Der Zyklus bricht früh ab, ohne Slots zu berühren.
        // EN: no throw up to this point = success. The cycle aborts early, without touching slots.
    });

    it('is a no-op when dashboardEnabled is off', async () => {
        const { inst, written } = makeInstance({ dashboardEnabled: false, fetchDbrdList: async () => [sampleListingEntry('x')] });
        await inst.refreshDashboard();
        expect(Object.keys(written)).to.be.empty;
    });

    it('serializes two concurrent refreshDashboard() calls instead of running them in parallel', async () => {
        const entry1 = sampleListingEntry('11111111-1111-1111-1111-111111111111');
        let concurrent = 0;
        let maxConcurrent = 0;
        const { inst } = makeInstance({
            fetchDbrdList: async () => [entry1],
            fetchDbrdDetail: async uuid => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise(r => setTimeout(r, 5));
                concurrent--;
                return sampleDetail({ einsatz: { ...sampleDetail().einsatz, uuid } });
            },
        });
        await Promise.all([inst.refreshDashboard(), inst.refreshDashboard()]);
        expect(maxConcurrent).to.equal(1);
    });
});

describe('onStateChange (dashboard.refreshNow button, plan document section 3.5)', () => {
    const proto = t.WaipWeb.prototype;

    function makeInstance() {
        const written = {};
        let refreshCalls = 0;
        const inst = Object.create(proto);
        inst.namespace = 'waip-web.0';
        inst.safeWarn = () => {};
        inst.refreshDashboard = async () => {
            refreshCalls++;
        };
        inst.setStateAsync = async (id, val, ack) => {
            written[id] = { val, ack };
        };
        return { inst, written, getRefreshCalls: () => refreshCalls };
    }

    it('triggers refreshDashboard() on a real user write (ack:false) and resets the button afterwards', async () => {
        const { inst, written, getRefreshCalls } = makeInstance();
        inst.onStateChange('waip-web.0.dashboard.refreshNow', { val: true, ack: false });
        // DE: onStateChange() ist bewusst synchron (spiegelt den echten ioBroker-Callback) -
        // die Promise-Kette läuft im Hintergrund weiter, daher hier auf den Abschluss warten.
        // EN: onStateChange() is deliberately synchronous (mirrors the real ioBroker
        // callback) - the promise chain keeps running in the background, so wait for it
        // to finish here.
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(getRefreshCalls()).to.equal(1);
        expect(written['dashboard.refreshNow']).to.deep.equal({ val: false, ack: true });
    });

    it('does NOT trigger a refresh on the ack:true write it just performed itself (no infinite loop)', async () => {
        const { inst, getRefreshCalls } = makeInstance();
        inst.onStateChange('waip-web.0.dashboard.refreshNow', { val: false, ack: true });
        await new Promise(r => setTimeout(r, 0));
        expect(getRefreshCalls()).to.equal(0);
    });

    it('ignores state changes for other IDs', async () => {
        const { inst, getRefreshCalls } = makeInstance();
        inst.onStateChange('waip-web.0.dashboard.einsatz1.alarmAktiv', { val: true, ack: false });
        await new Promise(r => setTimeout(r, 0));
        expect(getRefreshCalls()).to.equal(0);
    });

    it('ignores a null state (object deletion notification)', async () => {
        const { inst, getRefreshCalls } = makeInstance();
        inst.onStateChange('waip-web.0.dashboard.refreshNow', null);
        await new Promise(r => setTimeout(r, 0));
        expect(getRefreshCalls()).to.equal(0);
    });

    it('still resets the button state even if refreshDashboard() rejects', async () => {
        const { inst, written } = makeInstance();
        inst.refreshDashboard = async () => {
            throw new Error('boom');
        };
        inst.onStateChange('waip-web.0.dashboard.refreshNow', { val: true, ack: false });
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(written['dashboard.refreshNow']).to.deep.equal({ val: false, ack: true });
    });
});

describe('trimHistoryIfNeeded (startup trim after lowering historySize)', () => {
    const proto = t.WaipWeb.prototype;

    function makeInstance(historyValue, historySize) {
        const written = {};
        const inst = Object.create(proto);
        inst.historySize = historySize;
        inst.getStateAsync = async id => {
            if (id === 'einsatzAktuell.json.history' && historyValue !== undefined) {
                return { val: historyValue };
            }
            return null;
        };
        inst.setStateAsync = async (id, val) => {
            written[id] = val;
        };
        inst.safeWarn = () => {};
        return { inst, written };
    }

    it('trims an existing history down to the current historySize', async () => {
        const entries = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }, { uuid: 'd' }];
        const { inst, written } = makeInstance(JSON.stringify(entries), 2);
        await inst.trimHistoryIfNeeded();
        expect(JSON.parse(written['einsatzAktuell.json.history'])).to.deep.equal([{ uuid: 'a' }, { uuid: 'b' }]);
    });

    it('does nothing when the history is already within the limit', async () => {
        const entries = [{ uuid: 'a' }, { uuid: 'b' }];
        const { inst, written } = makeInstance(JSON.stringify(entries), 10);
        await inst.trimHistoryIfNeeded();
        expect(written['einsatzAktuell.json.history']).to.be.undefined;
    });

    it('does nothing when no history state exists yet (fresh install)', async () => {
        const { inst, written } = makeInstance(undefined, 10);
        await inst.trimHistoryIfNeeded();
        expect(written['einsatzAktuell.json.history']).to.be.undefined;
    });

    it('does nothing and does not throw on malformed JSON', async () => {
        const { inst, written } = makeInstance('not json', 5);
        await inst.trimHistoryIfNeeded();
        expect(written['einsatzAktuell.json.history']).to.be.undefined;
    });
});
