import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitPaths } from '../src/renderer/src/lib/paths.ts'

const paths = (t: string): string[] => splitPaths(t).flatMap((p) => (p.path ? [p.path] : []))

test('Windows paths in answers become links, without the full stop after them', () => {
  assert.deepEqual(paths('I created it at H:\\Projects\\Personal\\test.'), ['H:\\Projects\\Personal\\test'])
  assert.deepEqual(paths('Saved to C:\\Program Files\\Maris\\Maris.exe and done'), ['C:\\Program Files\\Maris\\Maris.exe'])
  assert.deepEqual(paths('see C:\\Users\\me and D:\\x\\y'), ['C:\\Users\\me', 'D:\\x\\y'])
  assert.deepEqual(paths('The project root is H:\\Projects\\Personal\\test (your folder)'), ['H:\\Projects\\Personal\\test'])
})

test('macOS and Linux paths', () => {
  assert.deepEqual(paths('Open ~/projects/game/main.py to start.'), ['~/projects/game/main.py'])
  assert.deepEqual(paths('It is in /Users/sam/Downloads/report.pdf, I think'), ['/Users/sam/Downloads/report.pdf'])
})

test('things that only look a bit like paths stay text', () => {
  assert.deepEqual(paths('ABC:\\nope and and/or https://example.com/a/b'), [])
  assert.deepEqual(paths('ratio 3:4 and time 10:30'), [])
})

test('the pieces put back together are the original text', () => {
  const t = 'Files are in C:\\data\\out and ~/backup/out, see there.'
  assert.equal(
    splitPaths(t)
      .map((p) => p.text)
      .join(''),
    t
  )
})
