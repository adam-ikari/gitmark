/**
 * The signing key must never reach this repository.
 *
 * This repository is public, and the consequences of a leaked release key are
 * worse here than for an ordinary app: anyone holding it can sign an update that
 * Android accepts as *this* app, and this app keeps the user's notes in local
 * storage. The reverse failure is just as bad — replacing the key means every
 * install has to be removed to install a new version, and removing the app
 * destroys those notes.
 *
 * So the key lives outside the repository (see brain/pages/android-release-signing.md),
 * and these assertions make sure it stays there. A build artifact under `android/`
 * is already ignored; the natural place to drop a keystore is the repository root,
 * which is what the `.gitignore` rule exists for.
 *
 * Cheap as a test, and it guards a failure that is silent until it is not
 * reversible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const IGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8');

/** Extensions a signing key or its password plausibly arrives as. */
const FORBIDDEN = ['*.keystore', '*.jks', '*.p12', '*.p8', '*.key', '*.pass'];

test('.gitignore excludes every signing-key extension', () => {
  for (const pattern of FORBIDDEN) {
    assert.ok(IGNORE.includes(pattern), `${pattern} is not in .gitignore`);
  }
});

test('a keystore in the repository root would be ignored', () => {
  // The specific trap: android/ is already ignored, so the root is where a
  // keystore lands by accident and the one place a rule has to be added by hand.
  const rootRule = IGNORE.split('\n').find((line) => line.trim() === '*.keystore');
  assert.ok(rootRule, 'a bare *.keystore rule must exist, not one scoped to android/');
});

test('no release signing key is sitting in the working tree', () => {
  // Ignored files still exist on disk, and a forgotten key in a home directory
  // copy of this repo is how one eventually gets committed.
  //
  // `android/app/debug.keystore` is excluded on purpose: Expo generates it per
  // project, it is the well-known React Native debug key with the password
  // `android`, it is printed in every RN tutorial, and it protects nothing. It is
  // also the reason the release key must not be the debug key — see
  // brain/pages/android-release-signing.md.
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === 'debug.keystore') continue;
      if (/\.(keystore|jks|p12|p8|pass)$/.test(entry.name)) found.push(full.slice(ROOT.length));
    }
  };
  walk(ROOT);
  assert.deepEqual(found, []);
});

test('the generated native project is ignored', () => {
  // Everything under android/ is produced by expo prebuild, including a debug
  // keystore that Expo generates per project.
  assert.ok(existsSync(join(ROOT, '.gitignore')));
  assert.ok(IGNORE.includes('/android'), 'android/ must stay ignored under CNG');
});

test('build output and env files are ignored', () => {
  for (const pattern of ['dist/', '.env']) {
    assert.ok(IGNORE.includes(pattern), `${pattern} is not in .gitignore`);
  }
});