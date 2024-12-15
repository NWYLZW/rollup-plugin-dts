import dts from "rollup-plugin-dts";

export default /** @type {import('rollup').RollupOptions} */ ({
  input: `src/${process.env.ROLLUP_DTS_SUB_ENTRY ?? "index"}.ts`,
  output: {
    dir: `dist/${process.env.ROLLUP_DTS_SUB_ENTRY ?? "index"}`,
    format: "esm",
    importAttributesKey: "with",
    sourcemap: "inline",
  },
  plugins: [
    dts({ tsconfig: "tsconfig.json" }),
  ],
  external: ["foo"],
});
