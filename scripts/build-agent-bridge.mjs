import { build } from 'esbuild'

// Bundles the bridge into the one file the npm package ships (decision 0012).
const { metafile } = await build({
  entryPoints: ['dev/agentBridge.ts'],
  outfile: 'packages/agent-bridge/dist/rami-agent-bridge.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
})

const inputs = Object.keys(metafile.inputs)
const packages = inputs.filter((input) => input.includes('node_modules/'))
if (packages.length) {
  console.error(`The bridge must not bundle npm packages:\n${packages.join('\n')}`)
  process.exitCode = 1
} else console.log(`Bundled the agent bridge from ${inputs.length} modules`)
