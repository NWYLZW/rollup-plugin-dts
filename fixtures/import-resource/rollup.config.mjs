import dts from "rollup-plugin-dts";

export default /** @type {import('rollup').RollupOptions} */ ({
  input: "src/index.ts",
  output: {
    dir: "dist",
    format: "esm",
    importAttributesKey: "with",
  },
  plugins: [
    dts({ tsconfig: "tsconfig.json" }),
  ],
});
