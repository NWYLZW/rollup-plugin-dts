import dts from 'rollup-plugin-dts'

export default /** @type {import('rollup').RollupOptions} */ ({
  input: 'src/index.ts',
  output: {
    dir: 'dist',
    format: 'esm'
  },
  plugins: [
    dts({ tsconfig: 'tsconfig.json' })
  ],
  external: ['foo']
})
