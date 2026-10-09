import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRelayError, ExitCode, findExecutable, runCommand } from '@agentrelay/core';

/**
 * Copies text to the system clipboard. On Windows the text goes through a UTF-8 temp file, because
 * clip.exe and PowerShell's stdin both mangle non-ASCII characters.
 */
export async function copyToClipboard(text: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === 'win32') {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrelay-clip-')), 'handoff.txt');
    fs.writeFileSync(file, text, 'utf8');
    try {
      const r = await runCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath $env:AGENTRELAY_CLIP_FILE)'],
        { env: { ...env, AGENTRELAY_CLIP_FILE: file }, timeoutMs: 15_000 },
      );
      if (r.exitCode !== 0) throw new AgentRelayError(`Could not copy to clipboard: ${r.stderr.trim()}`, ExitCode.Failure);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
    return;
  }

  const tools: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];
  const tool = tools.find(([name]) => findExecutable(name, env));
  if (!tool) {
    throw new AgentRelayError(
      `No clipboard tool found (tried ${tools.map(([n]) => n).join(', ')}). Open the handoff file instead.`,
      ExitCode.Unsupported,
    );
  }
  const r = await runCommand(tool[0], tool[1], { env: { ...env, LANG: env.LANG ?? 'en_US.UTF-8' }, input: text, timeoutMs: 15_000 });
  if (r.exitCode !== 0) throw new AgentRelayError(`Could not copy to clipboard: ${r.stderr.trim()}`, ExitCode.Failure);
}
