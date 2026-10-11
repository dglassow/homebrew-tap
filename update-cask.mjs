#!/usr/bin/env node
// Stage metadata for an already-published, stable Glass release. No release or tap is published here.
import { createHash } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const caskPath = fileURLToPath(new URL('Casks/glass.rb', import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^[a-f0-9]{64}$/;

function parts(version) {
  const match = versionPattern.exec(version);
  if (!match) throw new Error(`expected stable semver X.Y.Z, got ${version}`);
  return match.slice(1).map(BigInt);
}

function compareVersions(a, b) {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

async function response(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'glass-homebrew-maintenance' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function sha256(res) {
  if (!res.body) throw new Error('published artifact has no response body');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  if (!size) throw new Error('published artifact is empty');
  return { digest: hash.digest('hex'), size };
}

function asset(release, name, version) {
  const found = release.assets?.filter(item => item.name === name);
  if (found?.length !== 1) throw new Error(`release v${version} must contain exactly one ${name}`);
  const item = found[0];
  const expectedUrl = `https://github.com/dglassow/Glass/releases/download/v${version}/${name}`;
  if (item.state !== 'uploaded' || item.browser_download_url !== expectedUrl ||
      !digestPattern.test(item.digest?.replace(/^sha256:/, '') ?? '') ||
      !item.digest?.startsWith('sha256:') || !Number.isSafeInteger(item.size) || item.size <= 0) {
    throw new Error(`release v${version} has invalid ${name} metadata`);
  }
  return item;
}

function field(source, name, valuePattern) {
  const matches = [...source.matchAll(new RegExp(`^([ \\t]*${name}[ \\t]+")(${valuePattern})("[ \\t]*)$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`cask must contain exactly one valid ${name} field`);
  return matches[0];
}

export async function updateHomebrewCask(version, { fetchImpl = fetch, recipe = caskPath } = {}) {
  parts(version);
  const original = await readFile(recipe, 'utf8');
  const current = field(original, 'version', '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)')[2];
  const oldHash = field(original, 'sha256', '[a-f0-9]{64}')[2];
  if (compareVersions(version, current) < 0) throw new Error(`refusing downgrade from ${current} to ${version}`);

  const releaseUrl = `https://api.github.com/repos/dglassow/Glass/releases/tags/v${version}`;
  const release = await (await response(releaseUrl, fetchImpl)).json();
  if (release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false || !release.published_at) {
    throw new Error(`v${version} is not a published stable release with matching tag`);
  }
  const dmg = asset(release, 'Glass.dmg', version);
  const sums = asset(release, 'SHA256SUMS', version);
  const sumsResponse = await response(sums.browser_download_url, fetchImpl);
  // SHA256SUMS is small text metadata; limit before parsing to prevent accidental large downloads.
  const sumsBytes = [];
  let sumsSize = 0;
  if (!sumsResponse.body) throw new Error('SHA256SUMS has no response body');
  for await (const chunk of sumsResponse.body) {
    sumsSize += chunk.byteLength;
    if (sumsSize > 64 * 1024) throw new Error('SHA256SUMS exceeds 64 KiB');
    sumsBytes.push(chunk);
  }
  const sumsBuffer = Buffer.concat(sumsBytes);
  if (sumsSize !== sums.size || createHash('sha256').update(sumsBuffer).digest('hex') !== sums.digest.slice(7)) {
    throw new Error('SHA256SUMS does not match published asset metadata');
  }
  const entries = sumsBuffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    .map(line => /^([a-f0-9]{64}) [ *](.+)$/.exec(line));
  if (entries.some(entry => !entry)) throw new Error('invalid SHA256SUMS format');
  const dmgEntries = entries.filter(entry => entry[2].replace(/^\.\//, '') === 'Glass.dmg');
  if (dmgEntries.length !== 1) throw new Error('SHA256SUMS must contain exactly one Glass.dmg');

  const downloaded = await sha256(await response(dmg.browser_download_url, fetchImpl));
  if (downloaded.size !== dmg.size || downloaded.digest !== dmg.digest.slice(7) || downloaded.digest !== dmgEntries[0][1]) {
    throw new Error('Glass.dmg download, SHA256SUMS and GitHub asset metadata disagree');
  }
  if (version === current && downloaded.digest !== oldHash) {
    throw new Error(`v${version} differs from the existing pinned digest; refusing asset replacement`);
  }
  const versionField = field(original, 'version', '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)');
  const hashField = field(original, 'sha256', '[a-f0-9]{64}');
  const updated = original
    .replace(versionField[0], `${versionField[1]}${version}${versionField[3]}`)
    .replace(hashField[0], `${hashField[1]}${downloaded.digest}${hashField[3]}`);
  if (updated !== original) {
    // Validate everything before writing, and rename a sibling file atomically on the same volume.
    if (await readFile(recipe, 'utf8') !== original) throw new Error('cask changed during metadata verification');
    const temporary = join(dirname(recipe), `.glass.rb.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temporary, updated, { flag: 'wx', mode: (await stat(recipe)).mode });
      if (await readFile(recipe, 'utf8') !== original) throw new Error('cask changed during metadata staging');
      await rename(temporary, recipe);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { version, digest: downloaded.digest, changed: updated !== original };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) {
    console.error('usage: node distribution/homebrew/update-cask.mjs <published-stable-version>');
    process.exitCode = 1;
  } else {
    try {
      const result = await updateHomebrewCask(process.argv[2]);
      console.log(`${result.changed ? 'Staged' : 'Verified'} Glass v${result.version}: sha256 ${result.digest}`);
    } catch (error) {
      console.error(`Homebrew metadata: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
