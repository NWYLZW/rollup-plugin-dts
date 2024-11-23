import nodeResolve from '@rollup/plugin-node-resolve'
import dts from 'rollup-plugin-dts'

export default /** @type {import('rollup').RollupOptions} */ ({
  input: 'pkg-a/index.ts',
  output: {
    dir: 'dist',
    format: 'esm',
  },
  external: ['pkg-b'],
  plugins: [
    nodeResolve(),
    dts({ tsconfig: 'tsconfig.json' })
  ]
})
