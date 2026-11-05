'use strict';
/** Offline editing environments cannot re-resolve the npm lockfile. Run this
 * on a workstation with registry access, inspect the result, commit both
 * package.json AND package-lock.json, and re-run CI. Never use --force here.
 */
const { spawnSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');
const root = resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;
function invoke(args, capture=false) {
  // npm supplies npm_execpath when a script is invoked through `npm run`.
  const exe = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const argv = npmCli ? [npmCli,...args] : args;
  const result = spawnSync(exe, argv, { cwd:root, encoding:'utf8', windowsHide:true, stdio:capture?'pipe':'inherit', shell:!npmCli && process.platform==='win32' });
  if (result.error) throw result.error;
  return result;
}
function main() {
  if (!existsSync(resolve(root,'package-lock.json'))) throw new Error('Missing package-lock.json: do not regenerate it from an unreviewed manifest');
  console.log('Refreshing known affected direct dependency Morgan within its major release, then applying non-breaking audit fixes.');
  console.log('This will modify package.json and package-lock.json. Review and commit both after testing.');
  const patched = invoke(['install','--save','morgan@^1.12.1','--no-fund','--ignore-scripts']);
  if (patched.status !== 0) throw new Error('Package download failed. Verify network/registry configuration; files may be partially changed.');
  const fixed = invoke(['audit','fix','--no-fund','--ignore-scripts']);
  if (fixed.status !== 0) console.warn('Some dependency advisories may require manual upgrades. Avoid `npm audit fix --force`.');
  console.log('=== Final dependency audit ===');
  const report = invoke(['audit','--json'],true);
  let stats;
  try { stats = JSON.parse(report.stdout).metadata?.vulnerabilities; } catch { /* include registry diagnostics below */ }
  if (!stats) {
    console.error('Could not verify audit totals:',(report.stderr || report.stdout || '').slice(0,1000));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(stats,null,2));
  if (stats.critical || stats.high || stats.moderate || stats.low) {
    console.warn('Security gate NOT PASSED. Run `npm audit` to see affected package names, recommended fixed versions and breaking-change tradeoffs.');
    process.exitCode = 1;
    return;
  }
  console.log('npm security advisory gate passed for the updated installed dependency tree. Run `npm ci && npm test && npm run check` and review package-lock.json.');
}
try { main(); } catch(error) { console.error('Dependency repair:',error.message); process.exitCode=1; }
