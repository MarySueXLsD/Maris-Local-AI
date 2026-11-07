// Manual check (network): node tests/install-info.manual.ts "winget install --id MartinStorsjo.LLVM-MinGW.UCRT -e"
import { installInfo } from '../src/main/tools/installInfo.ts'

const command = process.argv.slice(2).join(' ') || 'winget install --id MartinStorsjo.LLVM-MinGW.UCRT -e'
const t = Date.now()
console.log(command)
console.log(await installInfo(command), `${Date.now() - t} ms`)
