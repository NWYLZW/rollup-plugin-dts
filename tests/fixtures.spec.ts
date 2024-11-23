import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { expect, test, describe } from "vitest";
import fs from "node:fs";

function build(path: string) {
  const resolveByPkg = (...paths: string[]) => resolve(process.cwd(), `./fixtures/${path}`, ...paths);
  if (fs.existsSync(resolveByPkg('node_modules')))
    fs.rmdirSync(resolveByPkg('node_modules'), { recursive: true });

  execSync('npm i', {
    cwd: resolveByPkg(),
    stdio: 'inherit'
  });
  execSync('npm run build', {
    cwd: resolveByPkg(),
    stdio: 'inherit'
  });

  fs.rmdirSync(resolveByPkg('./node_modules'), { recursive: true });
  const files = fs.readdirSync(resolveByPkg('./dist'), { recursive: true });
  expect(files).toMatchSnapshot();
  files.forEach(file => {
    if (typeof file !== 'string') return;
    if (fs.statSync(resolveByPkg('./dist', file)).isDirectory()) return;

    expect(fs.readFileSync(resolveByPkg('./dist', file), 'utf-8')).toMatchSnapshot();
  });
  fs.rmdirSync(resolveByPkg('./dist'), { recursive: true });
}

describe('fixtures', () => {
  test('project with references', build.bind(null, 'project-with-references'));
})
