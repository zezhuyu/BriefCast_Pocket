const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function clearLinkerSignedFlag(dirPath) {
  const result = spawnSync('find', [dirPath, '-type', 'f', '-perm', '+111'], { encoding: 'utf8' });
  const files = result.stdout.trim().split('\n').filter(Boolean);
  let count = 0;
  for (const file of files) {
    // Re-sign with --no-strict to remove the linker-signed flag added by Electron's build
    const r = spawnSync('codesign', ['--sign', '-', '--force', '--no-strict', file], { encoding: 'utf8' });
    if (r.status === 0) {
      count++;
    } else {
      // Not all executables are Mach-O (e.g. shell scripts) — skip failures silently
    }
  }
  console.log(`afterPack: cleared linker-signed flag on ${count} executables`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  console.log(`afterPack: processing ${appPath}`);
  clearLinkerSignedFlag(appPath);
};
