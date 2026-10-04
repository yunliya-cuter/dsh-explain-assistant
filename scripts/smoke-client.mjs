import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];
const ok = (label) => console.log('ok  ' + label);
const fail = (label, detail) => failures.push(label + (detail ? ': ' + detail : ''));

if (typeof pkg.version !== 'string' || pkg.version.split('.').length < 3) fail('package version', String(pkg.version));
else ok('package version ' + pkg.version);

const hostPath = join(root, 'lib', 'index.js');
if (!existsSync(hostPath)) fail('Host build', 'lib/index.js is missing');
else {
  try {
    const host = await import(hostPath + '?smoke=' + Date.now());
    for (const name of ['apply', 'inject', 'name']) {
      if (!(name in host)) fail('Host named export ' + name, 'missing');
      else ok('Host named export ' + name);
    }
    if (typeof host.apply !== 'function') fail('Host apply export', 'not a function');
    if (!Array.isArray(host.inject)) fail('Host inject export', 'not an array');
    if (host.name !== pkg.name) fail('Host name export', String(host.name));
  } catch (error) { fail('Host module import', error instanceof Error ? error.message : String(error)); }
}

const clientPath = join(root, 'lib', 'client.js');
if (!existsSync(clientPath)) fail('Client build', 'lib/client.js is missing');
else {
  const client = readFileSync(clientPath, 'utf8');
  if (!client.includes('window.__ModuleLoader__.load({id:"dsh-explain-assistant"')) fail('ModuleLoader wrapper', 'expected dsh-explain-assistant wrapper not found');
  else ok('ModuleLoader wrapper');
  if (client.includes('overlay.js')) fail('legacy overlay.js import', 'found in bundled client');
  else ok('no legacy overlay.js import');
}

const entryPath = join(root, 'src', 'client', 'entry.ts');
if (!existsSync(entryPath)) fail('client source entry', 'src/client/entry.ts is missing');
else {
  const entry = readFileSync(entryPath, 'utf8');
  if (!entry.includes('session: () =>') && !entry.includes('session:()=>')) fail('session getter', 'function-valued session getter not found');
  else ok('session getter');
  if (/overlay\\.js/.test(entry)) fail('legacy overlay.js source import', 'found in entry');
  else ok('no legacy overlay.js source import');
}

const tgzName = pkg.name + '-' + pkg.version + '.tgz';
const tgzPath = join(root, tgzName);
if (existsSync(tgzPath)) {
  const tar = spawnSync('tar', ['-xOf', tgzPath, 'package/package.json'], { encoding: 'utf8' });
  if (tar.status !== 0) fail('tarball manifest', tar.stderr.trim() || 'cannot read package/package.json');
  else {
    try {
      const packed = JSON.parse(tar.stdout);
      if (packed.name !== pkg.name || packed.version !== pkg.version) fail('tarball manifest version', (packed.name || '?') + '@' + (packed.version || '?'));
      else ok('tarball version ' + packed.version);
    } catch (error) { fail('tarball manifest JSON', error instanceof Error ? error.message : String(error)); }
  }
} else ok('versioned tarball not yet generated (dry-run path)');

const dry = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: '/tmp/dsh-explain-assistant-npm-cache' } });
if (dry.status !== 0) fail('npm pack dry-run', dry.stderr.trim() || 'failed');
else {
  try { const report = JSON.parse(dry.stdout); if (!Array.isArray(report) || report[0]?.name !== pkg.name || report[0]?.version !== pkg.version) fail('npm pack metadata', 'name/version mismatch'); else ok('npm pack dry-run metadata'); }
  catch (error) { fail('npm pack dry-run JSON', error instanceof Error ? error.message : String(error)); }
}

if (failures.length) { console.error('\\nSmoke checks failed:'); for (const item of failures) console.error('FAIL ' + item); process.exitCode = 1; }
else console.log('\\nAll client/package smoke checks passed.');
