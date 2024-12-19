import { execSync } from "node:child_process";
import { resolve } from "node:path";

import fs from "node:fs";
import { type TestContext, afterAll, beforeAll, describe, test } from "vitest";

function genBuild(path: string) {
  const resolveByPkg = (...paths: string[]) => resolve(process.cwd(), `./fixtures/${path}`, ...paths);

  function before() {
    if (fs.existsSync(resolveByPkg("node_modules"))) {
      fs.rmdirSync(resolveByPkg("node_modules"), { recursive: true });
    }

    execSync("npm i --silent", {
      cwd: resolveByPkg(),
      stdio: "inherit",
    });
  }
  function after() {
    const resolveByPkg = (...paths: string[]) => resolve(process.cwd(), `./fixtures/${path}`, ...paths);

    fs.rmdirSync(resolveByPkg("./node_modules"), { recursive: true });
    fs.rmdirSync(resolveByPkg("./dist"), { recursive: true });
  }
  const runWithoutHook = (entry: string | undefined, { expect }: TestContext) => {
    execSync("npm run build", {
      cwd: resolveByPkg(),
      stdio: "inherit",
      env: {
        ...process.env,
        ROLLUP_DTS_SUB_ENTRY: entry,
      },
    });

    let entryOutputPath = resolveByPkg(
      entry ? `./dist/${entry}` : "./dist/index",
    );
    if (entryOutputPath.endsWith("/dist/index") && !fs.existsSync(entryOutputPath)) {
      entryOutputPath = resolveByPkg("./dist");
    }
    const resolveByOutput = (...paths: string[]) => resolve(entryOutputPath, ...paths);

    const files = fs.readdirSync(resolveByOutput(), { recursive: true });
    expect(files).toMatchSnapshot();
    files.forEach(file => {
      if (typeof file !== "string") return;
      if (fs.statSync(resolveByOutput(file)).isDirectory()) return;

      expect(fs.readFileSync(resolveByOutput(file), "utf-8")).toMatchSnapshot();
    });
  };
  const run = (ctx: TestContext) => {
    before();
    try {
      runWithoutHook(undefined, ctx);
    } finally {
      after();
    }
  };
  return {
    after,
    before,
    run,
    runWithoutHook,
  };
}

describe("fixtures", () => {
  test.concurrent("project with references", genBuild("project-with-references").run);
  test.concurrent("monorepo", genBuild("monorepo").run);
  test.concurrent("import attributes", genBuild("import-attributes").run);
  describe("sourcemap", () => {
    const sourcemapBuild = genBuild("sourcemap");
    beforeAll(sourcemapBuild.before);
    afterAll(sourcemapBuild.after);
    test.concurrent("default", sourcemapBuild.runWithoutHook.bind(null, undefined));
    test.concurrent("overload default export", sourcemapBuild.runWithoutHook.bind(null, "overload-default-export"));
    test.concurrent("named", sourcemapBuild.runWithoutHook.bind(null, "named"));
    test.concurrent("bundled", sourcemapBuild.runWithoutHook.bind(null, "bundled"));
    test.concurrent("clazz", sourcemapBuild.runWithoutHook.bind(null, "clazz"));
    test.concurrent.skip("export star as", sourcemapBuild.runWithoutHook.bind(null, "export-star-as/index"));
  });
});
