// Runs electron-builder with release defaults:
//  - macOS builds are ad-hoc signed (no hardened runtime) unless a Developer ID certificate is
//    configured through CSC_LINK / CSC_NAME, in which case electron-builder signs normally and
//    notarizes when APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are set.
//  - Windows builds are signed only through WIN_CSC_LINK (electron-builder would otherwise fall
//    back to the macOS certificate in CSC_LINK).
//  - Nothing is published unless --publish is passed explicitly.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

// CI passes unset secrets as empty strings. electron-builder treats an empty CSC_LINK as a
// certificate (and fails), so drop empty signing variables. WIN_CSC_LINK is set to '' below on purpose.
for (const k of ['CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
  if (process.env[k] === '') delete process.env[k];
}

const explicitPlatforms = ['--mac', '-m', '--win', '-w', '--linux', '-l'].filter((a) => args.includes(a));
const buildsMac = args.includes('--mac') || args.includes('-m') || (!explicitPlatforms.length && process.platform === 'darwin');
const hasCertificate = !!(process.env.CSC_LINK || process.env.CSC_NAME);

if (buildsMac && !hasCertificate) {
  console.log('No signing certificate configured — macOS app will be ad-hoc signed.');
  args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
}
// An empty WIN_CSC_LINK means "don't sign"; unset, electron-builder would use CSC_LINK instead.
process.env.WIN_CSC_LINK ??= '';
if (!args.some((a) => a === '--publish' || a === '-p' || a.startsWith('--publish='))) {
  args.push('--publish', 'never');
}

const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
