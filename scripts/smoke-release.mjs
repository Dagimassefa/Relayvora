import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runCommand } from '../packages/core/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = path.join(root, 'release');
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'manifest.json'), 'utf8'));
const artifact = path.join(release, manifest.artifact);
if (createHash('sha256').update(fs.readFileSync(artifact)).digest('hex') !== manifest.sha256) throw new Error('Release checksum mismatch');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relayvora release ')));
const install = path.join(tmp, 'install');
const project = path.join(tmp, 'project with spaces');
fs.mkdirSync(project);
const env = { ...process.env, RELAYVORA_HOME: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex') };
async function run(file, args, cwd = project) {
  const r = await runCommand(file, args, { cwd, env, timeoutMs: 120_000 });
  if (r.exitCode !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
}
await run('npm', ['install', '--prefix', install, '--cache', path.join(tmp, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', '--offline', artifact], tmp);
const bin = path.join(install, 'node_modules', 'relayvora', 'dist', 'bin.js');
const cli = (...args) => run(process.execPath, [bin, ...args]);
if ((await cli('--version')).trim() !== manifest.version) throw new Error('Installed version mismatch');
await run('git', ['init', '-q']);
await cli('init');
const cp = JSON.parse(await cli('--json', 'checkpoint', 'create', '--goal', 'Release smoke task', '--no-transcript'));
if (!(await cli('checkpoint', 'show', cp.id)).includes('Release smoke task')) throw new Error('Handoff lost its goal');
await cli('--json', 'checkpoint', 'prune', '--dry-run');
const hooks = JSON.parse(await cli('--json', 'hooks', 'install', '--dry-run'));
for (const plan of hooks.plans) if (plan.warnings.length) throw new Error(`Unexpected hook warning: ${plan.warnings}`);
// The bundled hook must point to the installed bin, not the source tree.
await cli('--json', 'hooks', 'install', '--agent', 'claude');
const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
if (settings.hooks.Stop[0].hooks[0].args[0] !== fs.realpathSync(bin)) throw new Error('Bundled hook has the wrong entry point');
await cli('hooks', 'uninstall', '--agent', 'claude');
await cli('checkpoint', 'delete', cp.id, '--yes');
const list = JSON.parse(await cli('--json', 'checkpoint', 'list'));
if (!Array.isArray(list.checkpoints) || list.checkpoints.length !== 0) throw new Error('Checkpoint was not deleted');
process.stdout.write(`Release ${manifest.version}: offline install, version, init, checkpoint, hooks and cleanup passed.\n`);
