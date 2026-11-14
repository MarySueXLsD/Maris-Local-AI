import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findGitDir, readOnlyGitEnv, repoProgramRisk, settingsNameProgram, usesGit } from '../src/main/tools/gitSafety.ts'

test('repository settings that name a program are found', () => {
  const cloned = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/x.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n'
  assert.equal(settingsNameProgram(cloned), false)
  // git's own file monitor is not a program from the repository.
  assert.equal(settingsNameProgram('[core]\n\tfsmonitor = true\n'), false)
  assert.equal(settingsNameProgram('[core]\n\tfsmonitor = /tmp/monitor.sh\n'), true)
  assert.equal(settingsNameProgram('[diff "pdf"]\n\ttextconv = pdftotext\n'), true)
  // A setting on the same line as its section header.
  assert.equal(settingsNameProgram('[diff "pdf"] textconv = pdftotext\n'), true)
  assert.equal(settingsNameProgram('[filter "x"]\n\tclean = tool %f\n'), true)
  assert.equal(settingsNameProgram('[core]\n\tsshCommand = ssh -i key\n'), true)
  assert.equal(settingsNameProgram('[includeIf "gitdir:~/"]\n\tpath = other.cfg\n'), true)
  assert.equal(settingsNameProgram('# textconv = x\n; pager = y\n'), false)
})

test('the repository git uses is found from any folder inside it, worktrees included', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maris-git-'))
  try {
    const repoDir = path.join(root, 'repo')
    mkdirSync(path.join(repoDir, '.git'), { recursive: true })
    mkdirSync(path.join(repoDir, 'src', 'deep'), { recursive: true })
    writeFileSync(path.join(repoDir, '.git', 'config'), '[core]\n\tbare = false\n')
    assert.equal(findGitDir(path.join(repoDir, 'src', 'deep')), path.join(repoDir, '.git'))
    assert.equal(repoProgramRisk(path.join(repoDir, 'src')), undefined)
    writeFileSync(path.join(repoDir, '.git', 'config'), '[core]\n\tfsmonitor = ./monitor.sh\n')
    assert.match(repoProgramRisk(path.join(repoDir, 'src')) ?? '', /can make git start a program/)
    // A worktree: its .git is a file naming its folder in the repository, whose settings are shared.
    const wt = path.join(root, 'wt')
    const wtGit = path.join(repoDir, '.git', 'worktrees', 'wt')
    mkdirSync(wt, { recursive: true })
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`)
    writeFileSync(path.join(wtGit, 'commondir'), '../..\n')
    assert.equal(findGitDir(wt), wtGit)
    assert.match(repoProgramRisk(wt) ?? '', /can make git start a program/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('read-only commands get git without optional index writes and without a file monitor', () => {
  assert.equal(usesGit('git status'), true)
  assert.equal(usesGit('git.exe log -n 3'), true)
  assert.equal(usesGit('Get-Content .gitignore | Select-String node'), false)
  assert.deepEqual(readOnlyGitEnv({}), { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' })
  // Settings the person's own environment passes the same way are kept.
  assert.equal(readOnlyGitEnv({ GIT_CONFIG_COUNT: '2' }).GIT_CONFIG_KEY_2, 'core.fsmonitor')
})

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test("with readOnlyGitEnv, git status starts neither the repository's monitor nor its hook", { skip: !hasGit && 'git is not installed' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maris-git-'))
  const dir = path.join(root, 'repo')
  const marker = path.join(root, 'marker.txt')
  const fwd = (p: string): string => p.replace(/\\/g, '/')
  // The person's own git settings (a hooks folder of their own, say) stay out of this test.
  const globalCfg = path.join(root, 'global.gitconfig')
  writeFileSync(globalCfg, '')
  const git = (args: string[], env: Record<string, string> = {}): void => {
    try {
      execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', ...env } })
    } catch {
      /* the stand-in monitor answers nothing useful: only what it starts matters */
    }
  }
  try {
    mkdirSync(dir)
    git(['init', '-q'])
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n')
    git(['add', 'a.txt'])
    git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'one'])
    // What a folder unpacked from an archive can bring: a "file monitor" and a hook that runs when the index is written.
    const monitor = path.join(root, 'monitor.sh')
    writeFileSync(monitor, `#!/bin/sh\necho monitor >> '${fwd(marker)}'\n`, { mode: 0o755 })
    git(['config', 'core.fsmonitor', fwd(monitor)])
    writeFileSync(path.join(dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho hook >> '${fwd(marker)}'\n`, { mode: 0o755 })
    const status = (env?: Record<string, string>): string => {
      rmSync(marker, { force: true })
      // A newer time stamp makes git look at the file again and (normally) write the index.
      const t = new Date(Date.now() + 5000)
      utimesSync(path.join(dir, 'a.txt'), t, t)
      git(['status', '--short'], env)
      return existsSync(marker) ? readFileSync(marker, 'utf8') : ''
    }
    assert.match(status(), /monitor|hook/, 'without the guard, plain git status starts what the repository names')
    assert.equal(status(readOnlyGitEnv()), '')
  } finally {
    // git's object files are read-only, which the synchronous rmSync of Electron's Node refuses (EPERM).
    await rm(root, { recursive: true, force: true })
  }
})
