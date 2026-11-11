import { test } from 'node:test'
import assert from 'node:assert/strict'
import { API_CONTEXT_SIZES, contextLabel, LOCAL_CONTEXT_SIZES, RING_CONTEXT_SIZES, sizesFor, usableWindow } from '../src/shared/context.ts'
import { contextOverflow } from '../src/main/engines/errors.ts'
import { SETTINGS_SCHEMA } from '../src/renderer/src/views/settings/schema.ts'

test('sizes are written the way people say them', () => {
  assert.equal(contextLabel(4096), '4K')
  assert.equal(contextLabel(32768), '32K')
  assert.equal(contextLabel(200000), '200K')
  assert.equal(contextLabel(262144), '256K')
  assert.equal(contextLabel(1000000), '1M')
  assert.equal(contextLabel(1048576), '1M')
  assert.equal(contextLabel(2097152), '2M')
  assert.equal(contextLabel(1500000), '1.5M')
  assert.equal(contextLabel(40960), '40K')
})

test('windows go up to millions of tokens, on this computer and at a service', () => {
  assert.equal(Math.max(...LOCAL_CONTEXT_SIZES), 2097152)
  assert.equal(Math.max(...API_CONTEXT_SIZES), 2000000)
  assert.ok(API_CONTEXT_SIZES.includes(1000000) && LOCAL_CONTEXT_SIZES.includes(1048576))
  for (const list of [LOCAL_CONTEXT_SIZES, API_CONTEXT_SIZES, RING_CONTEXT_SIZES]) assert.deepEqual([...list].sort((a, b) => a - b), list, 'smallest first')
})

test('Settings offers the same sizes, under the same names', () => {
  const options = (path: string): { value: number; label: string }[] => (SETTINGS_SCHEMA.find((d) => d.path === path)!.options ?? []) as { value: number; label: string }[]
  for (const path of ['routing.contextByTier.fast', 'routing.contextByTier.balanced', 'routing.contextByTier.max', 'routing.contextByTier.tiny', 'routing.codeContext']) {
    assert.deepEqual(options(path).map((o) => o.value), LOCAL_CONTEXT_SIZES, path)
    assert.deepEqual(options(path).map((o) => o.label), LOCAL_CONTEXT_SIZES.map(contextLabel), path)
  }
  assert.deepEqual(options('routing.apiContext').map((o) => o.value), API_CONTEXT_SIZES)
  assert.deepEqual(options('routing.apiContext').map((o) => o.label), API_CONTEXT_SIZES.map(contextLabel))
})

test('a model is offered what it can take, its own limit last, and the size in use', () => {
  // A 1M model at a service: everything up to its limit, and the limit itself.
  assert.deepEqual(sizesFor(API_CONTEXT_SIZES, 65536, 1000000), [16384, 32768, 65536, 131072, 200000, 400000, 1000000])
  assert.deepEqual(sizesFor(API_CONTEXT_SIZES, 65536, 1048576).slice(-2), [1000000, 1048576])
  // A 200K model never shows a million.
  assert.deepEqual(sizesFor(API_CONTEXT_SIZES, 65536, 200000), [16384, 32768, 65536, 131072, 200000])
  // A service that does not say how much its models take: every size, up to 2M.
  assert.equal(sizesFor(API_CONTEXT_SIZES, 65536).at(-1), 2000000)
  // A local model with a 40K window, set to an in-between size.
  assert.deepEqual(sizesFor(RING_CONTEXT_SIZES, 12288, 40960), [4096, 8192, 12288, 16384, 32768, 40960])
  // A setting bigger than this model takes is not offered for it.
  assert.ok(!sizesFor(API_CONTEXT_SIZES, 2000000, 200000).includes(2000000))
})

test('the conversation fills four fifths of what a model takes, the rest is for the answer', () => {
  assert.ok(usableWindow(200000) > 150000 && usableWindow(200000) < 160000)
  assert.ok(usableWindow(1000000) > 780000 && usableWindow(1000000) < 800000)
  assert.ok(usableWindow(2000000) > 1500000, 'a 2M model really gets more than a million and a half')
  assert.equal(usableWindow(1000), 4096, 'never less than a workable minimum')
})

test('"too long" is recognised in the words services use, with the real limit when they give it', () => {
  assert.deepEqual(contextOverflow('Claude (Anthropic) did not accept the request: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}'), { limit: 200000 })
  assert.deepEqual(contextOverflow("The conversation is too long for this model: This model's maximum context length is 128000 tokens. However, your messages resulted in 130112 tokens."), { limit: 128000 })
  assert.deepEqual(contextOverflow('OpenRouter error 400: This endpoint\'s maximum context length is 32768 tokens.'), { limit: 32768 })
  assert.deepEqual(contextOverflow('Claude (Anthropic) did not accept the request: input length and `max_tokens` exceed context limit: 180000 + 64000 > 200000, decrease input length or `max_tokens` and try again'), { limit: 200000 })
  assert.deepEqual(contextOverflow('Request too large for the model: reduce the length of the messages.'), { limit: undefined })
  assert.equal(contextOverflow('Claude (Anthropic) refused the key: it is wrong, expired or was revoked.'), undefined)
  assert.equal(contextOverflow('The answer reached the length limit and was cut off.'), undefined)
  assert.equal(contextOverflow('Groq is limiting requests right now (too many, or too fast).'), undefined)
})
