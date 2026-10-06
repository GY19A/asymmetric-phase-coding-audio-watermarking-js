// The JavaScript sample of the page's "Use the library" section, run as written: only the
// input file name is replaced. It imports 'apcaw-js', which resolves to this package through
// its own "exports" (Node package self-reference), as it would for an installed copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SNIPPETS } from '../src/ui/snippets.js';
import { ROOT, MEDIA, CLIPS } from './helpers.js';

const js = SNIPPETS.find((s) => s.id === 'js');

test("the 'apcaw-js' specifier resolves to src/lib/index.js", () => {
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('apcaw-js'))"], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(fileURLToPath(p.stdout.trim()), path.join(ROOT, 'src', 'lib', 'index.js'));
});

test('the JavaScript sample runs and prints the message', () => {
  assert.equal((js.code.match(/'in\.wav'/g) ?? []).length, 1);
  const code = js.code.replace("'in.wav'", JSON.stringify(path.join(MEDIA, CLIPS[0])));
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, 'hello\n');
  assert.equal(p.stderr, '');
});
