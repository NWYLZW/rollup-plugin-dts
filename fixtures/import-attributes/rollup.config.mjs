import dts from "rollup-plugin-dts";

export default /** @type {import('rollup').RollupOptions} */ ({
  input: `src/${process.env.ROLLUP_DTS_SUB_ENTRY ?? "index"}.ts`,
  output: {
    dir: `dist/${process.env.ROLLUP_DTS_SUB_ENTRY ?? "index"}`,
    format: "esm",
    importAttributesKey: "with",
  },
  plugins: [
    dts({ tsconfig: "tsconfig.json" }),
    {
      name: "import-attributes-external",
      resolveId(id, __, { attributes }) {
        if (attributes.external === "true") {
          return { id, external: true };
        }
      },
    },
  ],
  external: ["foo"],
});
