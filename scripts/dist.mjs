// Runs electron-builder with release defaults:
//  - macOS builds are ad-hoc signed (no hardened runtime) unless a Developer ID certificate is
//    configured through CSC_LINK / CSC_NAME, in which case electron-builder signs normally and
//    notarizes when APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are set.
//  - Nothing is published unless --publish is passed explicitly.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

const explicitPlatforms = ['--mac', '-m', '--win', '-w', '--linux', '-l'].filter((a) => args.includes(a));
const buildsMac = args.includes('--mac') || args.includes('-m') || (!explicitPlatforms.length && process.platform === 'darwin');
const hasCertificate = !!(process.env.CSC_LINK || process.env.CSC_NAME);

if (buildsMac && !hasCertificate) {
  console.log('No signing certificate configured — macOS app will be ad-hoc signed.');
  args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
}
if (!args.some((a) => a === '--publish' || a === '-p' || a.startsWith('--publish='))) {
  args.push('--publish', 'never');
}

const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
