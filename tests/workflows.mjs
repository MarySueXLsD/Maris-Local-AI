// Validates every Studio workflow against a running ComfyUI's /object_info (node classes and input names).
// Usage: node tests/workflows.mjs [http://127.0.0.1:8188]
import { buildWorkflow, PACKS } from '../src/main/media/catalog.ts'

const base = process.argv[2] ?? 'http://127.0.0.1:8188'
const info = await (await fetch(`${base}/object_info`)).json()
let problems = 0
for (const pack of PACKS) {
  const params = { kind: pack.kind, prompt: 'test', seconds: 2 }
  const wf = buildWorkflow(pack.id, params, pack.supportsImageInput ? 'example.png' : undefined)
  for (const [id, node] of Object.entries(wf.workflow)) {
    const def = info[node.class_type]
    if (!def) {
      console.log(`✗ ${pack.id}: node ${id} uses unknown class ${node.class_type}`)
      problems++
      continue
    }
    const required = def.input?.required ?? {}
    const optional = def.input?.optional ?? {}
    for (const name of Object.keys(required)) {
      if (!(name in node.inputs)) {
        console.log(`✗ ${pack.id}: ${node.class_type} is missing required input "${name}"`)
        problems++
      }
    }
    for (const name of Object.keys(node.inputs)) {
      if (!(name in required) && !(name in optional)) {
        console.log(`✗ ${pack.id}: ${node.class_type} has unknown input "${name}"`)
        problems++
      }
    }
    // Enum values (sampler names, schedulers, CLIP types…)
    for (const [name, spec] of Object.entries({ ...required, ...optional })) {
      const v = node.inputs[name]
      if (Array.isArray(spec?.[0]) && typeof v === 'string' && !/\.(safetensors|gguf|png|jpg)$/.test(v) && !spec[0].includes(v)) {
        console.log(`✗ ${pack.id}: ${node.class_type}.${name} = "${v}" is not one of the allowed values`)
        problems++
      }
      if (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options) && typeof v === 'string' && !/\.(safetensors|gguf|png|jpg)$/.test(v) && !spec[1].options.includes(v)) {
        console.log(`✗ ${pack.id}: ${node.class_type}.${name} = "${v}" is not one of the allowed values`)
        problems++
      }
    }
  }
  console.log(`${problems ? '…' : '✓'} ${pack.id}: ${Object.keys(wf.workflow).length} nodes checked`)
}
console.log(problems ? `${problems} problem(s)` : 'all workflows match this ComfyUI')
process.exit(problems ? 1 : 0)
