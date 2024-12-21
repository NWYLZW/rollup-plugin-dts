import * as fs from "node:fs";
import type { RollupWatchOptions } from "rollup";

import dts from "./src/index.js";

const pkg = JSON.parse(fs.readFileSync("./package.json", { encoding: "utf-8" }));
const external = [
  /^node:/,
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
];

export default [
  {
    input: "./.build/src/index.js",
    output: [
      { file: pkg.exports.import, format: "es" },
      { file: pkg.exports.require, format: "commonjs", exports: "named" },
    ],
    external,
  },
  {
    input: "./.build/src/index.d.ts",
    output: [
      { file: pkg.exports.import.replace(/\.mjs$/, ".d.mts") },
      { file: pkg.exports.require.replace(/\.cjs$/, ".d.cts") },
    ],
    plugins: [dts({
      tsconfig: "./tsconfig.build.json",
    })],
    external,
  },
] satisfies Array<RollupWatchOptions>;
