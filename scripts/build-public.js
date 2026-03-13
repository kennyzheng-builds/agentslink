#!/usr/bin/env node
/**
 * build-public.js
 *
 * Strips private code from source files and outputs a public version.
 *
 * Markers:
 *   // #region private  ... // #endregion private   → entire block removed
 *   // #private  (at end of line)                   → that single line removed
 *
 * Usage:
 *   node scripts/build-public.js
 *
 * Output:
 *   dist/public/  — a clean copy of the repo with private code stripped
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'public');

// Files/dirs to always exclude from public output
const EXCLUDE = new Set([
  '.git',
  '.wrangler',
  'dist',
  'node_modules',
  'scripts',
  '.github',
]);

function stripPrivate(source) {
  const lines = source.split('\n');
  const result = [];
  let inPrivateRegion = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '// #region private') {
      inPrivateRegion = true;
      continue;
    }

    if (trimmed === '// #endregion private') {
      inPrivateRegion = false;
      continue;
    }

    if (inPrivateRegion) continue;

    if (trimmed.endsWith('// #private')) continue;

    result.push(line);
  }

  // Clean up excessive blank lines (3+ consecutive → 2)
  let cleaned = result.join('\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(srcPath, 'utf8');
        const stripped = stripPrivate(content);
        fs.writeFileSync(destPath, stripped);
        console.log(`  [stripped] ${path.relative(ROOT, srcPath)}`);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Clean output
if (fs.existsSync(OUT)) {
  fs.rmSync(OUT, { recursive: true });
}

console.log('Building public version...\n');
copyDir(ROOT, OUT);

// Verify no secrets leaked
const publicWorker = path.join(OUT, 'worker', 'index.js');
if (fs.existsSync(publicWorker)) {
  const content = fs.readFileSync(publicWorker, 'utf8');
  const leaks = [];
  if (content.includes('ADMIN_PASSWORD_HASH')) leaks.push('ADMIN_PASSWORD_HASH');
  if (content.includes('SESSION_SECRET')) leaks.push('SESSION_SECRET');
  if (content.includes('trackEvent')) leaks.push('trackEvent');
  if (content.includes('hashIP')) leaks.push('hashIP');
  if (content.includes('renderLoginPage')) leaks.push('renderLoginPage');
  if (content.includes('renderAdminDashboard')) leaks.push('renderAdminDashboard');
  if (content.includes('/admin/')) leaks.push('/admin/ routes');

  if (leaks.length) {
    console.error(`\n ERROR: Private code leaked in public build!`);
    console.error(`  Found: ${leaks.join(', ')}`);
    process.exit(1);
  }

  console.log('\n Verification passed — no private code in public build');
}

console.log(`\nOutput: ${path.relative(ROOT, OUT)}/`);
