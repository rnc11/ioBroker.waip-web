'use strict';

/*
 * DE: Prüft, ob alle übersetzbaren Texte in io-package.json und admin/i18n/ in allen 11
 * unterstützten Sprachen vorliegen.
 *
 * Notwendig, weil `npx translate-adapter translate` am Rate-Limit des Legacy-Google-
 * Endpoints scheitern kann und dabei TROTZDEM mit Exit-Code 0 sowie "Successfully
 * updated" abschließt, obwohl es pro Sprache nur "Skipping translation to X due to rate
 * limiting" ausgegeben und nichts geschrieben hat. Der Erfolg des Tools ist also kein
 * verlässlicher Indikator - deshalb hier die inhaltliche Gegenprobe.
 *
 * Aufruf: node scripts/check-i18n.js
 * Exit-Code 1, sobald irgendwo eine Sprache fehlt.
 *
 * EN: Verifies that every translatable text in io-package.json and admin/i18n/ exists in
 * all 11 supported languages.
 *
 * Necessary because `npx translate-adapter translate` can hit the legacy Google endpoint's
 * rate limit and STILL exit 0 with "Successfully updated", even though it only printed
 * "Skipping translation to X due to rate limiting" per language and wrote nothing. The
 * tool's success is therefore not a reliable indicator - hence this content-level
 * cross-check.
 *
 * Usage: node scripts/check-i18n.js
 * Exit code 1 as soon as a language is missing anywhere.
 */

const path = require('node:path');
const fs = require('node:fs');

const LANGS = ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];
const ROOT = path.join(__dirname, '..');

const problems = [];

/* DE: Prüft ein mehrsprachiges Objekt ({en: "...", de: "..."}) auf fehlende Sprachen.
   EN: Checks a multilingual object ({en: "...", de: "..."}) for missing languages. */
function checkMultilingual(obj, label) {
    if (!obj || typeof obj !== 'object') {
        problems.push(`${label}: not a multilingual object`);
        return;
    }
    const missing = LANGS.filter(l => !obj[l] || String(obj[l]).trim() === '');
    if (missing.length) {
        problems.push(`${label}: missing ${missing.join(', ')}`);
    }
}

// ---------------------------------------------------------------- io-package.json
const ioPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'io-package.json'), 'utf8'));
const common = ioPackage.common || {};

checkMultilingual(common.titleLang, 'io-package.json common.titleLang');
checkMultilingual(common.desc, 'io-package.json common.desc');

const news = common.news || {};
const newsVersions = Object.keys(news);
for (const version of newsVersions) {
    checkMultilingual(news[version], `io-package.json common.news["${version}"]`);
}

// DE: Der ioBroker-Repository-Builder cappt common.news hart bei 7 Einträgen (E1032) -
// das lokale Test-Suite-Limit von 20 ist irreführend. Hier mitprüfen, damit das nicht
// erst der repochecker findet.
// EN: The ioBroker repository builder hard-caps common.news at 7 entries (E1032) - the
// local test suite's limit of 20 is misleading. Checked here so the repochecker isn't
// the first to find it.
if (newsVersions.length > 7) {
    problems.push(`io-package.json common.news has ${newsVersions.length} entries, max. 7 allowed (E1032)`);
}

// DE: Version muss zwischen package.json und io-package.json übereinstimmen (wird auch
// von test:package geprüft, hier aber als schneller Vorab-Check mit klarer Meldung).
// EN: Version must match between package.json and io-package.json (also checked by
// test:package, but included here as a fast pre-check with a clear message).
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== common.version) {
    problems.push(`version mismatch: package.json ${pkg.version} vs io-package.json ${common.version}`);
}

// ---------------------------------------------------------------- admin/i18n/*.json
const i18nDir = path.join(ROOT, 'admin', 'i18n');
const translations = {};
for (const lang of LANGS) {
    const file = path.join(i18nDir, `${lang}.json`);
    if (!fs.existsSync(file)) {
        problems.push(`admin/i18n/${lang}.json is missing entirely`);
        continue;
    }
    translations[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
}

if (translations.en) {
    const enKeys = Object.keys(translations.en);
    for (const lang of LANGS) {
        if (lang === 'en' || !translations[lang]) {
            continue;
        }
        const missing = enKeys.filter(k => !translations[lang][k] || String(translations[lang][k]).trim() === '');
        if (missing.length) {
            problems.push(
                `admin/i18n/${lang}.json: ${missing.length} key(s) missing/empty -> ${missing.slice(0, 5).join(', ')}${
                    missing.length > 5 ? ', ...' : ''
                }`,
            );
        }
        // DE: Verwaiste Keys entstehen beim Umbenennen: translate-adapter räumt sie nur
        // bei einem ERFOLGREICHEN Lauf automatisch weg, bei Hand-Edits gar nicht.
        // EN: Orphaned keys appear when renaming: translate-adapter only prunes them
        // automatically on a SUCCESSFUL run, and not at all for hand edits.
        const orphans = Object.keys(translations[lang]).filter(k => !enKeys.includes(k));
        if (orphans.length) {
            problems.push(
                `admin/i18n/${lang}.json: ${orphans.length} orphaned key(s) not in en.json -> ${orphans
                    .slice(0, 5)
                    .join(', ')}${orphans.length > 5 ? ', ...' : ''}`,
            );
        }
    }
}

// ---------------------------------------------------------------- result
if (problems.length) {
    console.error(`i18n check failed with ${problems.length} problem(s):\n`);
    for (const p of problems) {
        console.error(`  - ${p}`);
    }
    console.error(
        '\nRun `npm run translate -- translate` and re-check. If it reports rate limiting,\n' +
            'translate the missing strings by hand (see CLAUDE.md).',
    );
    process.exit(1);
}

console.log(`i18n OK: ${LANGS.length} languages, ${newsVersions.length} news entries, all keys present.`);
