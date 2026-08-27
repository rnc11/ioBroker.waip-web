'use strict';

/*
 * DE: Wrapper um @iobroker/repochecker. Setzt automatisch OWN_GITHUB_TOKEN (sonst greift
 * GitHubs 60-Requests/h-Limit für unauthentifizierte Zugriffe und der Checker bricht mit
 * E0000/403 ab) und filtert die für dieses Repo bekannten, erwarteten Meldungen heraus.
 * Damit bedeutet eine leere Ausgabe wirklich "sauber", statt bei jedem Lauf 20+ Zeilen
 * manuell gegen eine Ausnahmeliste abgleichen zu müssen.
 *
 * Aufruf:
 *   node scripts/repocheck.js          -> --local (Arbeitsbaum, Pre-Commit-Gate)
 *   node scripts/repocheck.js --remote -> ohne --local (gepushter/live Zustand auf GitHub+npm)
 *   node scripts/repocheck.js --all    -> nichts filtern, Rohausgabe zeigen
 *
 * Exit-Code 1, sobald ein nicht-ignorierter Fund übrig bleibt.
 *
 * EN: Wrapper around @iobroker/repochecker. Automatically sets OWN_GITHUB_TOKEN (otherwise
 * GitHub's 60-requests/h limit for unauthenticated access kicks in and the checker aborts
 * with E0000/403) and filters out the findings known to be expected for this repo. That
 * way an empty output really means "clean", instead of having to manually diff 20+ lines
 * against an exception list on every run.
 *
 * Usage:
 *   node scripts/repocheck.js          -> --local (working tree, pre-commit gate)
 *   node scripts/repocheck.js --remote -> without --local (pushed/live state on GitHub+npm)
 *   node scripts/repocheck.js --all    -> don't filter anything, show raw output
 *
 * Exit code 1 as soon as a non-ignored finding remains.
 */

const { execFileSync, execSync } = require('node:child_process');

const REPO_URL = 'https://github.com/rnc11/ioBroker.waip-web';

/*
 * DE: Bekannte, erwartete Meldungen. Jede braucht eine Begründung - eine Ausnahme ohne
 * nachvollziehbaren Grund ist ein übersehener Fehler, kein Rauschen.
 * EN: Known, expected findings. Each needs a justification - an exception without a
 * traceable reason is an overlooked bug, not noise.
 */
const IGNORED = [
    {
        // DE: Per Definition erwartet, solange der PR zur Aufnahme ins offizielle
        // Repository noch offen ist (ioBroker/ioBroker.repositories#6487).
        // EN: Expected by definition while the PR to get listed in the official
        // repository is still open (ioBroker/ioBroker.repositories#6487).
        re: /^\[W4001\]/,
        reason: 'waip-web is not in the official repository yet (PR #6487 pending)',
    },
    {
        // DE: Der Checker kann das GitHub-Actions-Job-Log nicht abrufen - Rauschen seiner
        // eigenen Log-Abfrage, nichts in diesem Repo zu beheben.
        // EN: The checker cannot retrieve the GitHub Actions job log - noise from its own
        // log fetching, nothing in this repo to fix.
        re: /^\[W3(050|052)\]/,
        reason: 'checker could not fetch the GH Actions job log (its own infrastructure)',
    },
    {
        // DE: Erwartet in der Lücke zwischen Versionsbump und Tag-Push. Löst sich auf,
        // sobald der Tag gepusht ist und CI nach npm published hat.
        // ACHTUNG: Nicht zu verwechseln mit einem verwaisten news-Eintrag für eine
        // Version, die NIE getaggt wurde - der muss tatsächlich gelöscht werden. Seit
        // der Umstellung auf release-script (Bump+Tag in einem Zug) kann dieser Fall
        // nicht mehr entstehen.
        // EN: Expected in the gap between version bump and tag push. Resolves once the
        // tag is pushed and CI has published to npm.
        // NOTE: Not to be confused with an orphaned news entry for a version that was
        // NEVER tagged - that one genuinely has to be deleted. Since switching to
        // release-script (bump+tag in one go) this case can no longer occur.
        re: /^\[(E2004|E3032|W2002)\]/,
        reason: 'version bumped but not yet tagged/published (resolves with the tag push)',
    },
];

/*
 * DE: W9008 ("tracked but covered by .gitignore") ist im --local-Modus ein bekannter
 * False Positive: der Checker sieht die Datei im Dateisystem und schließt fälschlich auf
 * "getrackt". Statt den Code pauschal zu ignorieren, wird hier pro gemeldeter Datei per
 * `git ls-files` geprüft, ob sie WIRKLICH getrackt ist - nur dann bleibt der Fund stehen.
 * EN: W9008 ("tracked but covered by .gitignore") is a known false positive in --local
 * mode: the checker sees the file on disk and wrongly concludes it is "tracked". Instead
 * of blanket-ignoring the code, each reported file is verified with `git ls-files` to see
 * whether it REALLY is tracked - only then does the finding stand.
 */
function isFalsePositiveW9008(line) {
    // DE: Der Checker meldet sowohl "file X" als auch "directory X" - beide Varianten
    // abdecken, sonst rutscht ein Verzeichnis-False-Positive durch.
    // EN: The checker reports both "file X" and "directory X" - cover both variants,
    // otherwise a directory false positive slips through.
    const m = /^\[W9008\] (?:file|directory) (.+?) is tracked but covered by \.gitignore/.exec(line);
    if (!m) {
        return false;
    }
    try {
        // DE: Ohne --error-unmatch, damit auch ein Verzeichnispfad funktioniert (git
        // ls-files listet dann alle getrackten Dateien darunter auf; leere Ausgabe =
        // nichts getrackt = False Positive).
        // EN: Without --error-unmatch so a directory path works too (git ls-files then
        // lists all tracked files below it; empty output = nothing tracked = false
        // positive).
        const tracked = execFileSync('git', ['ls-files', '--', m[1]], {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
        return tracked === '';
    } catch {
        // DE: git-Aufruf selbst fehlgeschlagen -> nicht stillschweigend ignorieren.
        // EN: The git call itself failed -> don't ignore silently.
        return false;
    }
}

function shouldIgnore(line) {
    if (isFalsePositiveW9008(line)) {
        return 'not actually tracked by git (verified with git ls-files)';
    }
    const hit = IGNORED.find(entry => entry.re.test(line));
    return hit ? hit.reason : null;
}

function main() {
    const args = process.argv.slice(2);
    const remote = args.includes('--remote');
    const showAll = args.includes('--all');

    let token = '';
    try {
        token = execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        console.warn(
            'WARNING: could not read a GitHub token via `gh auth token`. Without OWN_GITHUB_TOKEN\n' +
                "         the checker hits GitHub's unauthenticated 60 req/h rate limit and may fail\n" +
                '         outright with E0000/E9999 403. Run `gh auth login` first.\n',
        );
    }

    const checkerArgs = ['@iobroker/repochecker', REPO_URL];
    if (!remote) {
        checkerArgs.push('--local');
    }

    console.log(`Running repochecker (${remote ? 'remote/live' : 'local working tree'})...\n`);

    let output = '';
    try {
        output = execSync(`npx ${checkerArgs.join(' ')}`, {
            env: { ...process.env, ...(token ? { OWN_GITHUB_TOKEN: token } : {}) },
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        });
    } catch (e) {
        // DE: repochecker beendet sich bei Funden ggf. mit != 0 - die Ausgabe ist trotzdem
        // auswertbar und wird unten gefiltert.
        // EN: repochecker may exit != 0 when it has findings - the output is still usable
        // and gets filtered below.
        output = `${e.stdout || ''}${e.stderr || ''}`;
        if (!output) {
            console.error(e.message);
            process.exit(2);
        }
    }

    if (showAll) {
        console.log(output);
        return;
    }

    const finalStatus = /FINAL status '(\w+)'/.exec(output);
    const findings = output.split(/\r?\n/).filter(l => /^\[[EWS]\d{4}\]/.test(l.trim()));

    const remaining = [];
    const ignored = [];
    for (const raw of findings) {
        const line = raw.trim();
        const reason = shouldIgnore(line);
        if (reason) {
            ignored.push({ line, reason });
        } else {
            remaining.push(line);
        }
    }

    if (ignored.length) {
        console.log(`Ignored ${ignored.length} known/expected finding(s):`);
        // DE: Nach Fehlercode gruppieren, damit 20 identische W9008-Zeilen nicht 20 Zeilen
        // Ausgabe erzeugen - das war ja gerade der Grund für diesen Wrapper.
        // EN: Grouped by error code so 20 identical W9008 lines don't produce 20 lines of
        // output - which was the whole point of this wrapper.
        const byCode = new Map();
        for (const { line, reason } of ignored) {
            const code = /^\[(\w+)\]/.exec(line)[1];
            if (!byCode.has(code)) {
                byCode.set(code, { count: 0, reason });
            }
            byCode.get(code).count++;
        }
        for (const [code, { count, reason }] of byCode) {
            console.log(`  - ${code}${count > 1 ? ` (${count}x)` : ''}: ${reason}`);
        }
        console.log('');
    }

    if (remaining.length) {
        console.error(`${remaining.length} finding(s) need attention:\n`);
        for (const line of remaining) {
            console.error(`  ${line}`);
        }
        console.error('\nFix these before committing (see CLAUDE.md, "Stop-the-line").');
        process.exit(1);
    }

    console.log(
        `No findings beyond the known exceptions.${finalStatus ? ` repochecker FINAL status: ${finalStatus[1]}` : ''}`,
    );
}

main();
