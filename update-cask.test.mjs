import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateHomebrewCask } from './update-cask.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const oldDigest = 'a'.repeat(64);
const dm = Buffer.from('published DMG bytes');
const sums = Buffer.from(`${digest(dm)}  Glass.dmg\n`);
const base = 'https://github.com/dglassow/Glass/releases/download/v0.3.4/';
const fixture = `cask "glass" do\n  version "0.3.3"\n  sha256 "${oldDigest}"\n  url "https://github.com/dglassow/Glass/releases/download/v#{version}/Glass.dmg"\nend\n`;
const asset = (name, bytes) => ({
  name, state: 'uploaded', size: bytes.length, digest: `sha256:${digest(bytes)}`,
  browser_download_url: base + name,
});

function fakeFetch({ publishedHash = digest(dm), digestOverride = digest(dm), releaseOverride = {} } = {}) {
  const release = {
    tag_name: 'v0.3.4', draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z',
    assets: [{ ...asset('Glass.dmg', dm), digest: `sha256:${digestOverride}` }, asset('SHA256SUMS', sums)],
    ...releaseOverride,
  };
  const sumsText = Buffer.from(`${publishedHash}  Glass.dmg\n`);
  return async url => {
    if (url.endsWith('/tags/v0.3.4')) return new Response(JSON.stringify(release));
    if (url === base + 'SHA256SUMS') return new Response(sumsText);
    if (url === base + 'Glass.dmg') return new Response(dm);
    throw new Error(`unexpected network request: ${url}`);
  };
}

test('mismatched published metadata and downgrade leave cask byte-for-byte unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'glass-cask-'));
  const recipe = join(directory, 'glass.rb');
  try {
    for (const [version, fetchImpl, expected, original = fixture] of [
      ['0.3.4', fakeFetch({ digestOverride: 'b'.repeat(64) }), /disagree/],
      ['0.3.4', fakeFetch({ publishedHash: 'c'.repeat(64) }), /SHA256SUMS does not match/],
      ['0.3.4', fakeFetch({ releaseOverride: { prerelease: true } }), /published stable release/],
      ['0.3.2', fakeFetch(), /downgrade/],
      ['0.3.4', fakeFetch(), /refusing asset replacement/, fixture.replace('version "0.3.3"', 'version "0.3.4"')],
    ]) {
      await writeFile(recipe, original);
      await assert.rejects(updateHomebrewCask(version, { recipe, fetchImpl }), expected);
      assert.equal(await readFile(recipe, 'utf8'), original);
      assert.deepEqual(await readdir(directory), ['glass.rb']);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
