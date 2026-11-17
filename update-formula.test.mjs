import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateHomebrewFormula } from './update-formula.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const oldDigest = 'a'.repeat(64);
const archive = Buffer.from('published Vitra archive bytes');
const artifact = 'vitra-darwin-arm64.tar.gz';
const base = 'https://github.com/dglassow/Vitra/releases/download/v18.5.1/';
const fixture = `class Vitra < Formula\n  url "https://github.com/dglassow/Vitra/releases/download/v18.5.0/${artifact}"\n  version "18.5.0"\n  sha256 "${oldDigest}"\nend\n`;
const asset = (name, bytes) => ({
  name, state: 'uploaded', size: bytes.length, digest: `sha256:${digest(bytes)}`,
  browser_download_url: base + name,
});

function fakeFetch({ publishedHash = digest(archive), digestOverride = digest(archive), releaseOverride = {} } = {}) {
  const sumsText = Buffer.from(`${publishedHash}  ${artifact}\n`);
  const release = {
    tag_name: 'v18.5.1', draft: false, prerelease: false, published_at: '2026-11-17T00:00:00Z',
    assets: [{ ...asset(artifact, archive), digest: `sha256:${digestOverride}` }, asset('SHA256SUMS', Buffer.from(`${digest(archive)}  ${artifact}\n`))],
    ...releaseOverride,
  };
  return async url => {
    if (url === 'https://api.github.com/repos/dglassow/Vitra/releases/tags/v18.5.1') return new Response(JSON.stringify(release));
    if (url === base + 'SHA256SUMS') return new Response(sumsText);
    if (url === base + artifact) return new Response(archive);
    throw new Error(`unexpected network request: ${url}`);
  };
}

test('a verified published release stages the version, the digest, and the download path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vitra-formula-'));
  const recipe = join(directory, 'vitra.rb');
  try {
    await writeFile(recipe, fixture);
    const result = await updateHomebrewFormula('18.5.1', { recipe, fetchImpl: fakeFetch() });
    assert.deepEqual(result, { version: '18.5.1', digest: digest(archive), changed: true });
    const staged = await readFile(recipe, 'utf8');
    assert.equal(staged, fixture
      .replace('version "18.5.0"', 'version "18.5.1"')
      .replace(oldDigest, digest(archive))
      .replace('/download/v18.5.0/', '/download/v18.5.1/'));
    assert.deepEqual(await readdir(directory), ['vitra.rb']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('mismatched published metadata and downgrade leave the formula byte-for-byte unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vitra-formula-'));
  const recipe = join(directory, 'vitra.rb');
  try {
    for (const [version, fetchImpl, expected, original = fixture] of [
      ['18.5.1', fakeFetch({ digestOverride: 'b'.repeat(64) }), /disagree/],
      ['18.5.1', fakeFetch({ publishedHash: 'c'.repeat(64) }), /SHA256SUMS does not match/],
      ['18.5.1', fakeFetch({ releaseOverride: { prerelease: true } }), /published stable release/],
      ['18.4.9', fakeFetch(), /downgrade/],
      ['18.5.1', fakeFetch(), /refusing asset replacement/, fixture.replaceAll('18.5.0', '18.5.1')],
      ['18.5.1', fakeFetch(), /formula must contain exactly one valid version field/, fixture.replace('  version "18.5.0"\n', '')],
    ]) {
      await writeFile(recipe, original);
      await assert.rejects(updateHomebrewFormula(version, { recipe, fetchImpl }), expected);
      assert.equal(await readFile(recipe, 'utf8'), original);
      assert.deepEqual(await readdir(directory), ['vitra.rb']);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
