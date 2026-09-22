import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const directories = ['.e2e-data-upgrade', '.e2e-data-pending', '.e2e-data-dashboard'].map((name) =>
  path.resolve(name),
);
const clean = () => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
};

clean();
const pnpmCli = process.env.npm_execpath;
if (pnpmCli === undefined) throw new Error('npm_execpath is unavailable');
const result = spawnSync(process.execPath, [pnpmCli, 'exec', 'playwright', 'test'], {
  stdio: 'inherit',
});
clean();
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
