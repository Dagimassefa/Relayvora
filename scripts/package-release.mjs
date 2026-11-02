import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { RELAYVORA_VERSION, runCommand } from '../packages/core/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'release');
fs.mkdirSync(out, { recursive: true });
const stage = fs.mkdtempSync(path.join(out, 'package-'));
const cli = JSON.parse(fs.readFileSync(path.join(root, 'apps/cli/package.json'), 'utf8'));
if (cli.version !== RELAYVORA_VERSION) throw new Error('CLI manifest and core version disagree');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${cli.version}`) throw new Error('Release tag must match the CLI version');

await build({
  entryPoints: [path.join(root, 'apps/cli/src/bin.ts')],
  // Splitting keeps bin.ts's dynamic import as its own chunk: in a single file, the hoisted node:sqlite
  // import would load before bin.ts installs its ExperimentalWarning filter. Chunks sit next to bin.js,
  // which hooks-install locates relative to its own module.
  outdir: path.join(stage, 'dist'), splitting: true, chunkNames: '[name]-[hash]',
  bundle: true, platform: 'node', format: 'esm', target: 'node22.13',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  sourcemap: false, legalComments: 'linked',
});
fs.chmodSync(path.join(stage, 'dist/bin.js'), 0o755);
const manifest = {
  name: 'relayvora', version: cli.version, description: cli.description, type: 'module',
  repository: { type: 'git', url: 'git+https://github.com/Dagimassefa/Relayvora.git' },
  homepage: 'https://github.com/Dagimassefa/Relayvora#readme',
  bin: cli.bin, engines: cli.engines, license: 'MIT',
  files: ['dist', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  publishConfig: { access: 'public' },
};
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) fs.copyFileSync(path.join(root, file), path.join(stage, file));
const notices = ['# Bundled dependency licenses', ''];
for (const pkg of ['commander', 'zod']) {
  const file = path.join(root, 'apps/cli/node_modules', pkg, 'LICENSE');
  notices.push(`## ${pkg}`, '', fs.readFileSync(file, 'utf8'), '');
}
fs.writeFileSync(path.join(stage, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
const packed = await runCommand('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', out, '--cache', path.join(out, 'npm-cache')], { cwd: stage, timeoutMs: 120_000 });
if (packed.exitCode !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
const [info] = JSON.parse(packed.stdout);
const artifact = path.join(out, info.filename);
const sha256 = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
fs.writeFileSync(`${artifact}.sha256`, `${sha256}  ${info.filename}\n`);
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify({ version: cli.version, artifact: info.filename, sha256 }, null, 2)}\n`);
process.stdout.write(`Packaged ${artifact}\nSHA-256 ${sha256}\n`);
