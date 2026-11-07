import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { parseSkillMd, parseSkillSource } from '../src/main/skills/parse.ts'
import { unzip } from '../src/main/skills/unzip.ts'
import { imageRefs, isNewer, pickAsset, postId } from '../src/main/feed/pure.ts'
import { isRunnerCrash } from '../src/main/engines/errors.ts'
import { CONNECTOR_PRESETS, connectorToolName, splitCommand } from '../src/shared/connectorPresets.ts'

// ------------------------------------------------------------------ skills

test('SKILL.md front matter: name, description (also folded), and the instructions', () => {
  const s = parseSkillMd('---\nname: pdf-tools\ndescription: "Fill in and merge PDF files. Use when a PDF is involved."\nlicense: MIT\n---\n\n# PDF tools\n\nStep 1…\n')
  assert.equal(s.name, 'pdf-tools')
  assert.equal(s.description, 'Fill in and merge PDF files. Use when a PDF is involved.')
  assert.match(s.body, /^# PDF tools/)
  const folded = parseSkillMd('---\r\nname: brand\r\ndescription: >\r\n  Our colours and\r\n  tone of voice.\r\n---\r\nBody')
  assert.equal(folded.description, 'Our colours and tone of voice.')
  assert.equal(folded.body, 'Body')
  const plain = parseSkillMd('# Release notes\n\nWrite release notes the way we like them.\n\nMore.')
  assert.equal(plain.name, 'Release notes')
  assert.equal(plain.description, 'Write release notes the way we like them.')
})

test('skill sources: GitHub links (repository, folder, SKILL.md), shorthand, other git and folders', () => {
  const repo = parseSkillSource('https://github.com/anthropics/skills')
  assert.equal(repo.cloneUrl, 'https://github.com/anthropics/skills.git')
  assert.equal(repo.zipUrl, 'https://github.com/anthropics/skills/archive/HEAD.zip')
  assert.equal(repo.subpath, undefined)
  const folder = parseSkillSource('https://github.com/anthropics/skills/tree/main/skills/pdf')
  assert.equal(folder.ref, 'main')
  assert.equal(folder.subpath, 'skills/pdf')
  assert.equal(folder.zipUrl, 'https://github.com/anthropics/skills/archive/main.zip')
  assert.equal(parseSkillSource('https://github.com/a/b/blob/main/x/SKILL.md').subpath, 'x')
  assert.equal(parseSkillSource('owner/repo').cloneUrl, 'https://github.com/owner/repo.git')
  const gitlab = parseSkillSource('https://gitlab.com/team/skills.git')
  assert.equal(gitlab.cloneUrl, 'https://gitlab.com/team/skills.git')
  assert.equal(gitlab.zipUrl, undefined)
  assert.equal(parseSkillSource('C:\\Users\\me\\my-skills').kind, 'folder')
  assert.equal(parseSkillSource('/home/me/my-skills').slug, 'my-skills')
  assert.throws(() => parseSkillSource('not a link'))
})

/** A small zip archive (one deflated and one stored entry, inside a top folder like GitHub's). */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  let i = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const deflate = i++ % 2 === 0
    const body = deflate ? deflateRawSync(data) : data
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

test('unzip: GitHub-style archives unpack without their top folder, and nothing escapes the target', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maris-unzip-'))
  try {
    const zip = makeZip({
      'skills-main/pdf/SKILL.md': '---\nname: pdf\ndescription: d\n---\nUse it.',
      'skills-main/pdf/scripts/fill.py': 'print("hi")\n',
      'skills-main/../../evil.txt': 'nope'
    })
    const n = unzip(zip, dir, { stripFirst: true })
    assert.equal(n, 2)
    assert.equal(readFileSync(path.join(dir, 'pdf', 'SKILL.md'), 'utf8'), '---\nname: pdf\ndescription: d\n---\nUse it.')
    assert.equal(readFileSync(path.join(dir, 'pdf', 'scripts', 'fill.py'), 'utf8'), 'print("hi")\n')
    assert.ok(!existsSync(path.join(dir, '..', 'evil.txt')))
    assert.throws(() => unzip(Buffer.from('not a zip'), dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ updates and news

test('versions: newer, older, pre-releases', () => {
  assert.equal(isNewer('0.2.0', '0.1.0'), true)
  assert.equal(isNewer('v0.1.1', '0.1.0'), true)
  assert.equal(isNewer('0.1.0', '0.1.0'), false)
  assert.equal(isNewer('0.1.0', '0.2.0'), false)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  assert.equal(isNewer('0.2.0-beta.1', '0.2.0'), false)
  assert.equal(isNewer('0.2.0', '0.2.0-beta.1'), true)
})

test('the installer that fits each computer is picked from a release', () => {
  const assets = [
    'Maris-Setup-0.2.0.exe',
    'Maris-Setup-0.2.0.exe.blockmap',
    'Maris-0.2.0-arm64.dmg',
    'Maris-0.2.0-x64.dmg',
    'Maris-0.2.0-x86_64.AppImage',
    'Maris-0.2.0-arm64.AppImage',
    'maris_0.2.0_amd64.deb'
  ].map((name) => ({ name, browser_download_url: `https://example.com/${name}`, size: 1 }))
  assert.equal(pickAsset(assets, 'win32', 'x64')?.name, 'Maris-Setup-0.2.0.exe')
  assert.equal(pickAsset(assets, 'darwin', 'arm64')?.name, 'Maris-0.2.0-arm64.dmg')
  assert.equal(pickAsset(assets, 'darwin', 'x64')?.name, 'Maris-0.2.0-x64.dmg')
  assert.equal(pickAsset(assets, 'linux', 'x64')?.name, 'Maris-0.2.0-x86_64.AppImage')
  assert.equal(pickAsset(assets, 'linux', 'arm64')?.name, 'Maris-0.2.0-arm64.AppImage')
  assert.equal(pickAsset([], 'win32', 'x64'), undefined)
})

test('post ids and picture references', () => {
  assert.equal(postId('Skills & connectors are here!', new Date('2026-11-06T12:00:00Z')), '2026-11-06-skills-connectors-are-here')
  assert.equal(postId('???', new Date('2026-11-06T12:00:00Z')), '2026-11-06-post')
  assert.deepEqual(imageRefs('Hi ![a](images/x/a.png "A") and ![b](<images/x/b c.jpg>) <img src="images/x/c.webp">'), ['images/x/a.png', 'images/x/b c.jpg', 'images/x/c.webp'])
})

test('Ollama model-process crashes are recognised (and ordinary errors are not)', () => {
  assert.equal(isRunnerCrash('read tcp 127.0.0.1:65014->127.0.0.1:61528: wsarecv: An existing connection was forcibly closed by the remote host.'), true)
  assert.equal(isRunnerCrash('llama runner process has terminated: exit status 0xc0000409'), true)
  assert.equal(isRunnerCrash('socket hang up'), true)
  assert.equal(isRunnerCrash('model "x" not found, try pulling it first'), false)
  assert.equal(isRunnerCrash('requested context window is too large'), false)
})

// ------------------------------------------------------------------ connectors

test('connector presets are complete and their tool names are safe for models', () => {
  const ids = CONNECTOR_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const p of CONNECTOR_PRESETS) {
    if (p.transport === 'http') assert.ok(p.url, `${p.id} has an address`)
    else assert.ok(p.command || p.fields.some((f) => 'command' in f.target), `${p.id} has a command`)
    for (const f of p.fields) assert.ok(f.label && f.key, `${p.id}.${f.key}`)
    if (p.url?.includes('{url}')) assert.ok(p.fields.some((f) => 'url' in f.target), `${p.id} asks for its address`)
  }
  const name = connectorToolName('github-ab12cd', 'create_pull_request.v2')
  assert.match(name, /^mcp_[A-Za-z0-9_]+$/)
  assert.ok(name.length <= 64)
  assert.deepEqual(splitCommand('npx -y "@scope/my server" --flag'), ['npx', '-y', '@scope/my server', '--flag'])
})
