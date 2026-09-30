#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const EXCLUDED_SEGMENTS = new Set(['.git']);

function usage() {
  console.error('Usage: node scripts/import-authorized-paper.mjs <source-dir> [destination-dir] [--revision <revision>] [--force]');
}

function parseArgs(argv) {
  const positional = [];
  let revision = null;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--revision') {
      revision = argv[i + 1];
      if (!revision) throw new Error('--revision requires a value');
      i += 1;
    } else if (arg === '--force') {
      force = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 1 || positional.length > 2) {
    usage();
    process.exitCode = 2;
    return null;
  }

  return {
    source: path.resolve(positional[0]),
    destination: path.resolve(positional[1] ?? 'imports/paper/source'),
    revision,
    force,
  };
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function isNonEmptyDirectory(target) {
  if (!(await exists(target))) return false;
  const info = await stat(target);
  if (!info.isDirectory()) return true;
  return (await readdir(target)).length > 0;
}

async function collectFiles(root, current = root, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, absolute, output);
    } else if (entry.isFile()) {
      output.push({
        absolute,
        relative: path.relative(root, absolute).split(path.sep).join('/'),
      });
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link during immutable intake: ${path.relative(root, absolute)}`);
    }
  }

  return output;
}

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;

  const sourceInfo = await stat(args.source).catch(() => null);
  if (!sourceInfo?.isDirectory()) {
    throw new Error(`Source directory does not exist or is not a directory: ${args.source}`);
  }

  if (args.destination === args.source || args.destination.startsWith(`${args.source}${path.sep}`)) {
    throw new Error('Destination must not be the source directory or a child of it.');
  }

  if (await isNonEmptyDirectory(args.destination)) {
    if (!args.force) {
      throw new Error(`Destination is not empty: ${args.destination}. Use --force only for an intentional re-intake.`);
    }
    await rm(args.destination, { recursive: true, force: true });
  }

  await mkdir(args.destination, { recursive: true });
  const files = await collectFiles(args.source);
  const manifest = [];

  for (const file of files) {
    const target = path.join(args.destination, ...file.relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file.absolute, target);
    manifest.push({ path: file.relative, sha256: await sha256(target) });
  }

  const importRoot = path.dirname(args.destination);
  const manifestPath = path.join(importRoot, 'MANIFEST.sha256');
  const importPath = path.join(importRoot, 'IMPORT.json');

  const manifestText = manifest.map((item) => `${item.sha256}  ${item.path}`).join('\n') + (manifest.length ? '\n' : '');
  await writeFile(manifestPath, manifestText, 'utf8');

  const metadata = {
    schemaVersion: 1,
    donor: 'Paper.design',
    sourceRootName: path.basename(args.source),
    revision: args.revision,
    fileCount: manifest.length,
    manifest: path.relative(process.cwd(), manifestPath).split(path.sep).join('/'),
    destination: path.relative(process.cwd(), args.destination).split(path.sep).join('/'),
    generatedAt: new Date().toISOString(),
    note: 'Immutable authorized-source intake. No source rewriting is performed by this tool.',
  };

  await writeFile(importPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(`Imported ${manifest.length} files from Paper.design authorized source.`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Metadata: ${importPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
