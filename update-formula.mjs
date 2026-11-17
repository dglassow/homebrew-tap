#!/usr/bin/env node
// Stage metadata for an already-published, stable Vitra release. No release or tap is published here.
// Same checks as the Glass cask (update-cask.mjs): the release must be stable and non-draft, and the
// downloaded artifact, SHA256SUMS, and GitHub asset metadata must all agree before the formula changes.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateHomebrewRecipe } from './update-cask.mjs';

const formulaPath = fileURLToPath(new URL('Formula/vitra.rb', import.meta.url));
/** The public repository carries release artifacts, the license, and notices only. */
export const vitraTarget = {
  repo: 'dglassow/Vitra',
  artifact: 'vitra-darwin-arm64.tar.gz',
  kind: 'formula',
  recipe: formulaPath,
  temporaryPrefix: '.vitra.rb',
  pinnedDownloadPath: true,
};

export function updateHomebrewFormula(version, options) {
  return updateHomebrewRecipe(version, vitraTarget, options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) {
    console.error('usage: node distribution/homebrew/update-formula.mjs <published-stable-version>');
    process.exitCode = 1;
  } else {
    try {
      const result = await updateHomebrewFormula(process.argv[2]);
      console.log(`${result.changed ? 'Staged' : 'Verified'} Vitra v${result.version}: sha256 ${result.digest}`);
    } catch (error) {
      console.error(`Homebrew metadata: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
