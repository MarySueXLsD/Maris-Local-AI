import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serverEnv } from '../src/main/engines/serverEnv.ts'

test('the Ollama server Maris starts gets one request at a time, flash attention and a compact context window', () => {
  assert.deepEqual(serverEnv({ flashAttention: true, kvCache: 'q8_0' }, {}), { OLLAMA_NUM_PARALLEL: '1', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' })
  assert.deepEqual(serverEnv({ flashAttention: true, kvCache: 'f16' }, {}), { OLLAMA_NUM_PARALLEL: '1', OLLAMA_FLASH_ATTENTION: '1' })
  // A compact context window needs flash attention: without it, none is asked for.
  assert.deepEqual(serverEnv({ flashAttention: false, kvCache: 'q4_0' }, {}), { OLLAMA_NUM_PARALLEL: '1' })
  // What the person set themselves stays.
  assert.deepEqual(serverEnv({ flashAttention: true, kvCache: 'q8_0' }, { OLLAMA_KV_CACHE_TYPE: 'f16', OLLAMA_NUM_PARALLEL: '4' }), { OLLAMA_FLASH_ATTENTION: '1' })
})
