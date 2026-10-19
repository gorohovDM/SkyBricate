// Apply the tracked integration patch to a pinned upstream checkout, then build.
// npm ci must already have been run in that checkout. No network/publishing here.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createZip } from './build.mjs';

export const patchManifestPath = new URL('../patches/fabricate-component-assignments-v1.json', import.meta.url);
export const patchPath = fileURLToPath(new URL('../patches/fabricate-component-assignments-v1.patch', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyFabricatePatch(upstream, { apply = false } = {}) {
  const manifest = JSON.parse(await readFile(patchManifestPath, 'utf8'));
  if (hash(await readFile(patchPath)) !== manifest.patchSha256) throw new Error('Patch hash mismatch');
  const git = args => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', 'HEAD']) !== manifest.base) throw new Error('Wrong Fabricate source SHA');
  const changed = git(['diff', 'HEAD', '--name-only']).split(/\r?\n/).filter(Boolean);
  const extra = git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
  if ([...changed, ...extra].some(path => !Object.hasOwn(manifest.files, path))) throw new Error('Unrelated Fabricate checkout changes');
  let patched = false;
  try { git(['apply', '--reverse', '--check', patchPath]); patched = true; } catch { /* pristine source below */ }
  if (!patched) {
    if (!apply || changed.length || extra.length) throw new Error('Expected pristine or exactly patched Fabricate checkout');
    git(['apply', '--check', patchPath]); git(['apply', patchPath]);
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    // Git's platform checkout newline policy is irrelevant to the source identity.
    const bytes = (await readFile(resolve(upstream, path), 'utf8')).replaceAll('\r\n', '\n');
    if (hash(bytes) !== expected) throw new Error(`Patched source mismatch: ${path}`);
  }
  return manifest;
}

async function main() {
  if (!process.argv[2]) throw new Error('Usage: node tools/build-fabricate.mjs <upstream checkout> [--apply-only]');
  const upstream = resolve(process.argv[2]);
  const manifest = await verifyFabricatePatch(upstream, { apply: true });
  console.log(`Verified ${manifest.id}, base ${manifest.base}, patch SHA256 ${manifest.patchSha256}`);
  if (process.argv.includes('--apply-only')) return;
  execFileSync(process.execPath, [resolve(upstream, 'scripts/release.js'), '--no-zip', '--dist-version', manifest.version],
    { cwd: upstream, stdio: 'inherit' });
  const source = resolve(upstream, 'dist'), entries = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !/\.(?:zip|map)$/.test(entry.name)) entries.push([relative(source, path).replaceAll('\\', '/'), await readFile(path)]);
    }
  }
  await visit(source);
  entries.push(['SKYBRICATE-PATCH.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]);
  const out = fileURLToPath(new URL('../dist/', import.meta.url)); await mkdir(out, { recursive: true });
  const archive = createZip(entries), name = `fabricate-${manifest.version}-skybricate-assignments-v1.zip`;
  await writeFile(resolve(out, name), archive);
  const { assertArchiveChunkCompleteness } = await import(pathToFileURL(resolve(upstream, 'scripts/lib/releaseZipChunks.js')));
  assertArchiveChunkCompleteness({ zipPath: resolve(out, name), manifest: JSON.parse(await readFile(resolve(source, 'module.json'), 'utf8')) });
  await writeFile(resolve(out, `${name}.sha256`), `${hash(archive)}  ${name}\n`);
  console.log(`Built dist/${name}; SHA256 ${hash(archive)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
