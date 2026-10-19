import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const FABRICATE_SOURCE_SHA = '5bf36ddf950619317e41737acd3bfa1305591a26';

// Read committed stock sources, even if an old experiment left this checkout dirty.
// Never patch or build the third-party module. Generated probes live in our cache.
export function stockSources(path = '.reference/fabricate') {
  const upstream = resolve(path);
  const git = args => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (git(['rev-parse', 'HEAD']).trim() !== FABRICATE_SOURCE_SHA) throw Error('Requires Fabricate 1.9.10 source SHA');
  return { upstream, read: path => git(['show', `${FABRICATE_SOURCE_SHA}:${path}`]) };
}
