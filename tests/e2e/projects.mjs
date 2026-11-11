// Code mode's projects from start to finish: a new project, files written and changed in it (with
// approval, undo and auto-approve), a command, a second task, the same folder under another spelling,
// renaming and removing.
// Usage: npm run build && node tests/e2e/projects.mjs <shotsDir>   (MARIS_EXE as in the other tests)
// The model is fixtures/mock-llm.mjs, so this needs no downloads and no graphics card.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checker, driver, launch, makeProfile, removeProfile } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const parent = path.join(os.tmpdir(), `maris-e2e-projects-${Date.now()}`)
mkdirSync(parent, { recursive: true })
const t = checker()

const MODEL = 'mock-coder:7b'
const mock = await startMockLlm()
mock.addLocalModel(MODEL, { sizeGB: 4.5, caps: ['completion', 'tools'] })
const profile = makeProfile('projects', { ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy`, tiers: { tiny: MODEL, fast: MODEL, balanced: MODEL, max: MODEL } })
const { app, win, logs } = await launch(profile)
const d = driver(win, shots)
const approve = async () => {
  const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
  await panel.waitFor({ timeout: 30000 })
  await panel.getByRole('button', { name: 'Approve' }).click()
}
const panelTab = (name) => win.locator('aside[aria-label="Project"]').getByRole('radio', { name })
const tree = () => win.getByRole('tree', { name: 'Projects and their tasks' })
const projects = () => win.evaluate(() => window.maris.project.list())

try {
  // ---- a new project, the way the New project dialog makes one
  await win.getByRole('radio', { name: 'Code' }).click()
  await win.getByRole('heading', { name: 'Open a project' }).waitFor()
  await d.shot('proj-01-no-project')
  await win.getByRole('button', { name: 'New project' }).click()
  const dialog = win.getByRole('dialog', { name: 'New project' })
  await dialog.waitFor()
  t.check((await dialog.getByText(/New folder:/).count()) === 0, 'nothing is promised before a name is typed')
  await d.shot('proj-02-new-dialog')
  await win.keyboard.press('Escape')
  // The folder picker is the system's own dialog, so the test makes the project in a scratch folder directly.
  const created = await win.evaluate(([p]) => window.maris.project.create(p, 'demo: app?', 'A demo project. Keep it tiny.'), [parent])
  const dir = created.path
  t.check(path.basename(dir) === 'demo app' && existsSync(dir), `characters a folder cannot have are left out of its name (${path.basename(dir)})`)
  const reserved = await win.evaluate(([p]) => window.maris.project.create(p, 'con').then(() => 'made', (e) => String(e.message)), [parent])
  if (process.platform === 'win32') t.check(/Windows keeps the name/.test(reserved), 'a name Windows keeps for itself is refused with the reason')
  await win.evaluate((p) => window.__marisStore.getState().openProject(p), dir)
  await win.getByRole('heading', { name: /What should we build in demo app/ }).waitFor()
  t.check((await tree().getByText('demo app').count()) === 1, 'the project is in the sidebar')
  await d.shot('proj-03-empty-project')

  // ---- write a file: relative to the project, after approval
  await d.send('Create a text file at notes/hello.txt containing exactly this text: Hello project')
  const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
  await panel.waitFor({ timeout: 30000 })
  const file = path.join(dir, 'notes', 'hello.txt')
  t.check(!existsSync(file) && (await panel.innerText()).includes('hello.txt'), 'the change waits for approval and says which file')
  await d.shot('proj-04-approval')
  await panel.getByRole('button', { name: 'Approve' }).click()
  await d.waitDone()
  t.check(existsSync(file) && readFileSync(file, 'utf8').trim() === 'Hello project', 'a path without a drive lands inside the project folder')
  const twice = await win.evaluate(([p]) => window.maris.project.create(p, 'demo app').then(() => 'made', (e) => String(e.message)), [parent])
  t.check(/already a folder/i.test(twice), `"New project" does not take over a folder that already holds files: ${twice.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '').slice(0, 100)}`)
  const first = mock.of(MODEL).find((r) => r.body.tools)
  const sys = first?.body.messages[0].content ?? ''
  t.check(sys.includes(dir) && /A demo project\. Keep it tiny\./.test(sys), 'the model is told the project folder and what the project is about')
  t.check(first.body.tools.some((x) => x.function.name === 'multi_edit') && first.body.tools.some((x) => x.function.name === 'project_tree'), 'Code mode brings its own tools')

  // ---- the file tree follows the folder by itself
  await win.locator('aside[aria-label="Project"]').getByRole('button', { name: 'notes' }).waitFor({ timeout: 10000 })
  await win.locator('aside[aria-label="Project"]').getByRole('button', { name: 'notes' }).click()
  await win.locator('aside[aria-label="Project"]').getByRole('button', { name: 'hello.txt' }).waitFor({ timeout: 5000 })
  t.check(true, 'the new folder and file show up in the file tree without a refresh')
  await d.shot('proj-05-tree')

  // ---- change it, look at the change, undo it
  await d.send('In the file notes/hello.txt replace "Hello" with "Goodbye"')
  await approve()
  await d.waitDone()
  t.check(readFileSync(file, 'utf8').trim() === 'Goodbye project', 'an edit is applied after approval')
  await panelTab(/^Changes/).click()
  const changes = win.locator('aside[aria-label="Project"]')
  await changes.getByText('1 changed').waitFor()
  t.check((await changes.getByText('1 added').count()) === 1 && (await changes.getByText('+ Goodbye project').count()) >= 1, 'the Changes tab lists what was added and what was changed, with the lines')
  await d.shot('proj-06-changes')
  await changes.getByRole('button', { name: /See the change/ }).first().click()
  await win.getByText('Green lines were added, red lines removed.').waitFor({ state: 'attached' })
  await d.shot('proj-07-diff')
  await win.keyboard.press('Escape')
  await win.getByText('Green lines were added, red lines removed.').waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined)
  t.check((await win.getByText('Green lines were added, red lines removed.').count()) === 0, 'one press of Escape closes the change view')
  await changes.getByRole('button', { name: 'Undo' }).first().click()
  await changes.getByText('Undone').waitFor()
  t.check(readFileSync(file, 'utf8').trim() === 'Hello project', 'Undo puts the file back as it was')

  // ---- auto-approve edits: files in the project change without asking, nothing else does
  await win.getByRole('switch', { name: 'Auto-approve file edits in this project' }).click()
  await d.send('In the file notes/hello.txt replace "Hello" with "Hi"')
  await d.waitDone()
  t.check(readFileSync(file, 'utf8').trim() === 'Hi project', 'with auto-approve edits on, a file in the project is changed without asking')
  const outside = path.join(parent, 'outside.txt')
  await d.send(`Create a text file at ${outside} containing exactly this text: not in the project`)
  await panel.waitFor({ timeout: 30000 })
  t.check(!existsSync(outside), 'a file outside the project still waits for approval')
  await panel.getByRole('button', { name: 'Deny' }).click()
  await d.waitDone()
  t.check(!existsSync(outside) && /did not approve/.test(await d.lastAnswer()), 'denying leaves nothing behind and the model is told')

  // ---- a command runs in the project folder
  await d.send('Run this command: Get-Location')
  await d.waitDone()
  if (process.platform === 'win32') t.check((await d.lastAnswer()).toLowerCase().includes(path.basename(dir).toLowerCase()), `read-only commands run in the project folder without asking: ${(await d.lastAnswer()).slice(0, 110)}`)

  // ---- a second task in the same project
  await win.getByRole('button', { name: 'New task in demo app' }).click({ force: true })
  await win.waitForTimeout(400)
  await d.send(`List the files in this folder: .`)
  await d.waitDone()
  t.check(/notes/.test(await d.lastAnswer()), '"." means the project folder in a new task')
  const convs = await win.evaluate(() => window.maris.conv.list())
  const mine = convs.filter((c) => c.mode === 'code')
  t.check(mine.length === 2 && mine.every((c) => c.projectDir === dir), `both tasks belong to the project (${mine.map((c) => c.projectDir).join(' | ')})`)
  await d.shot('proj-08-two-tasks')

  // ---- the same folder under another spelling is the same project
  const other = process.platform === 'win32' ? `${dir.toUpperCase()}\\` : `${dir}/`
  await win.evaluate((p) => window.maris.project.open(p), other)
  const list1 = await projects()
  t.check(list1.length === 1, `opening the folder with another spelling adds no second project (${list1.length})`)
  const missing = await win.evaluate((p) => window.maris.project.open(p).then(() => 'opened', (e) => String(e.message)), path.join(parent, 'no-such-folder'))
  t.check(/does not exist|not found|no such|not a folder/i.test(missing), `a folder that is not there is refused: ${missing.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '').slice(0, 90)}`)

  // ---- rename, describe, remove
  await win.evaluate(([p]) => window.maris.project.update(p, { name: 'Demo renamed', description: 'Now described differently.' }), [dir])
  await win.evaluate(() => window.__marisStore.getState().loadProjects())
  await tree().getByText('Demo renamed').waitFor()
  await tree().getByRole('button', { name: 'Options for Demo renamed' }).click({ force: true })
  await win.getByRole('menuitem', { name: /Remove from Maris/ }).click()
  const remove = win.getByRole('dialog', { name: /Remove Demo renamed from Maris/ })
  await remove.waitFor()
  t.check(/2 tasks/.test(await remove.innerText()) && /stay as they are/.test(await remove.innerText()), 'removing says what goes (its tasks) and what stays (the folder)')
  await d.shot('proj-09-remove')
  await remove.getByRole('button', { name: /^Remove/ }).click()
  await remove.waitFor({ state: 'detached', timeout: 10000 })
  const left = await win.evaluate(() => window.maris.conv.list())
  t.check((await projects()).length === 0 && !left.some((c) => c.mode === 'code'), 'the project and its tasks are gone from Maris')
  t.check(existsSync(file), 'its folder and files are untouched')
  await win.getByRole('heading', { name: 'Open a project' }).waitFor()
  await d.shot('proj-10-removed')
} catch (e) {
  t.check(false, `stopped: ${e.message}`)
  await d.shot('proj-99-error').catch(() => undefined)
} finally {
  const errs = logs.filter((l) => /\berror\b|exception|unhandled|pageerror/i.test(l) && !/DevTools|GPU process|Autofill|project:create|project:open/i.test(l)).slice(-20)
  if (errs.length) console.log(`--- app log (errors) ---\n${errs.join('\n')}`)
  await app.close().catch(() => undefined)
  await mock.close()
  try {
    removeProfile(profile)
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* still held for a moment by the closing app */
  }
  console.log(t.failures ? `${t.failures} check(s) failed` : 'all checks passed')
  process.exit(t.failures ? 1 : 0)
}
