// Builds the Android app (debug APK): the phone bundle, Capacitor sync, then Gradle.
// Usage: npm run mobile:apk   → mobile/android/app/build/outputs/apk/debug/app-debug.apk
// Needs a JDK (17 or newer) in JAVA_HOME and the Android SDK (ANDROID_HOME, or local.properties).
const { execSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', env: process.env })

run('npm run mobile:build', root)
run('npx cap sync android', path.join(root, 'mobile'))
const android = path.join(root, 'mobile', 'android')
// The full path: Windows may be set not to run programs from the current folder by name.
run(`"${path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}" assembleDebug`, android)
console.log(`\nAPK: ${path.join(root, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')}`)
