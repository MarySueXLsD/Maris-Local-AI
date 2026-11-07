import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, getPath, leafPaths, patchFor, deepMerge } from '../src/shared/defaults.ts'
import { NOT_EDITABLE, SECTIONS, SETTINGS_SCHEMA } from '../src/renderer/src/views/settings/schema.ts'

test('every setting can be changed in the Settings page', () => {
  const paths = new Set(SETTINGS_SCHEMA.map((d) => d.path))
  const missing = leafPaths(DEFAULT_SETTINGS).filter((p) => !paths.has(p) && !NOT_EDITABLE.includes(p))
  assert.deepEqual(missing, [], `not editable anywhere: ${missing.join(', ')}`)
})

test('schema entries are unique, point at real sections and valid conditions', () => {
  const seen = new Set<string>()
  const sections = new Set(SECTIONS.map((s) => s.id))
  for (const d of SETTINGS_SCHEMA) {
    assert.ok(!seen.has(d.path), `duplicate ${d.path}`)
    seen.add(d.path)
    assert.ok(sections.has(d.section), `${d.path} has unknown section ${d.section}`)
    if (d.when) assert.ok(seen.has(d.when.path) || SETTINGS_SCHEMA.some((x) => x.path === d.when!.path), `${d.path} depends on unknown ${d.when.path}`)
    if ((d.type === 'select' || d.type === 'segmented') && getPath(DEFAULT_SETTINGS, d.path) !== undefined) {
      const v = getPath(DEFAULT_SETTINGS, d.path)
      assert.ok(d.options?.some((o) => o.value === v), `default of ${d.path} (${String(v)}) is not one of its options`)
    }
    if (d.type === 'number' || d.type === 'slider') {
      const v = getPath(DEFAULT_SETTINGS, d.path)
      if (typeof v === 'number') {
        assert.ok(d.min === undefined || v >= d.min, `${d.path} default below min`)
        assert.ok(d.max === undefined || v <= d.max, `${d.path} default above max`)
      }
    }
  }
})

test('patches built from a path merge into settings', () => {
  const next = deepMerge(DEFAULT_SETTINGS, patchFor('routing.contextByTier.max', 32768))
  assert.equal(next.routing.contextByTier.max, 32768)
  assert.equal(next.routing.contextByTier.fast, DEFAULT_SETTINGS.routing.contextByTier.fast)
  const cleared = deepMerge(deepMerge(DEFAULT_SETTINGS, patchFor('generation.max.temperature', 0.7)), patchFor('generation.max.temperature', undefined))
  assert.equal(cleared.generation.max.temperature, undefined)
  assert.equal(cleared.generation.max.placement, 'auto')
})
