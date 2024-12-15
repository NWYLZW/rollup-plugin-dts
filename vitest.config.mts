import { exec } from 'node:child_process';
import { defineConfig } from 'vitest/config';

if (process.env.ROLLUP_DTS_TEST_AUTOBUILD !== 'false') {
  const process = exec('npm run build');
  await new Promise<void>((resolve, reject) => {
    const log: string[] = [];
    process.stdout?.on('data', data => log.push(data));
    process.stderr?.on('data', data => log.push(data));
    process.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(log.join('')));
      }
    });
  });
}

export default defineConfig({
  test: {},
});
