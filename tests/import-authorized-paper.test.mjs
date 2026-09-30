import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('scripts/import-authorized-paper.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lilac-import-'));
  const source = path.join(root, 'paper-source');
  const destination = path.join(root, 'imports', 'paper', 'source');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  await mkdir(path.join(source, '.git'), { recursive: true });
  await writeFile(path.join(source, 'a.txt'), 'alpha\n');
  await writeFile(path.join(source, 'nested', 'b.txt'), 'beta\n');
  await writeFile(path.join(source, '.git', 'config'), 'must-not-copy\n');
  return { root, source, destination };
}

test('copies source deterministically, excludes .git, and records manifest metadata', async () => {
  const { root, source, destination } = await fixture();
  const run = spawnSync(process.execPath, [script, source, destination, '--revision', 'paper-test-rev'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(path.join(destination, 'a.txt'), 'utf8'), 'alpha\n');
  assert.equal(await readFile(path.join(destination, 'nested', 'b.txt'), 'utf8'), 'beta\n');

  const manifest = await readFile(path.join(root, 'imports', 'paper', 'MANIFEST.sha256'), 'utf8');
  assert.match(manifest, /  a\.txt\n/);
  assert.match(manifest, /  nested\/b\.txt\n/);
  assert.doesNotMatch(manifest, /\.git/);

  const metadata = JSON.parse(await readFile(path.join(root, 'imports', 'paper', 'IMPORT.json'), 'utf8'));
  assert.equal(metadata.donor, 'Paper.design');
  assert.equal(metadata.revision, 'paper-test-rev');
  assert.equal(metadata.fileCount, 2);
});

test('refuses to overwrite a non-empty destination without --force', async () => {
  const { source, destination } = await fixture();
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'existing.txt'), 'keep me');

  const run = spawnSync(process.execPath, [script, source, destination], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /Destination is not empty/);
});
