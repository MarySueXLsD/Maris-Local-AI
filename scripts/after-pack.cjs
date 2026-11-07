// electron-builder afterPack hook. macOS on Apple chips refuses to run code without a signature, and
// changing the app bundle breaks Electron's own one, so without a Developer ID we sign it "ad hoc".
// People who download the app then open it once with right-click → Open (see the README).
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // `mac.identity: null` in electron-builder.yml means "no certificate". Remove that line (and set
  // CSC_LINK / CSC_KEY_PASSWORD) to sign with a Developer ID; electron-builder then signs the app itself.
  if (context.packager.platformSpecificBuildOptions.identity !== null) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`  • ad-hoc signing ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
