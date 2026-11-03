const toast = document.querySelector('#toast');
let toastTimeout;

function notify(message) {
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3200);
}

async function copyCommand(button) {
  const command = button.dataset.copy;
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    // Clipboard API is unavailable for file:// previews and some browser contexts.
    const input = document.createElement('textarea');
    input.value = command;
    input.setAttribute('readonly', '');
    input.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      input.remove();
      button.focus({ preventScroll: true });
    }
    if (!copied) {
      notify('Select the command text to copy it.');
      return;
    }
  }
  notify('Command copied. See you in the terminal.');
}

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => {
    copyCommand(button).catch(() => notify('Select the command text to copy it.'));
  });
});

const agents = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };
const options = [...document.querySelectorAll('[data-agent]')];
const command = document.querySelector('#demo-command');
const result = document.querySelector('#demo-result');
const runButton = document.querySelector('#run-demo');
const output = document.querySelector('#demo-output');
const steps = [...output.querySelectorAll('.terminal-step'), output.querySelector('.terminal-result')];
let selectedAgent = 'codex';
let playback = 0;

function selectAgent(agent) {
  playback += 1;
  selectedAgent = agent;
  options.forEach((option) => {
    const selected = option.dataset.agent === agent;
    option.classList.toggle('active', selected);
    option.setAttribute('aria-pressed', String(selected));
  });
  const source = agent === 'claude' ? 'codex' : 'claude';
  command.textContent = `relayvora handoff --from ${source} --to ${agent} --verify auto --confirm`;
  result.textContent = `${agents[agent]} is ready. Same mission, fresh context.`;
  steps.forEach((step) => step.classList.remove('is-pending'));
  output.removeAttribute('aria-busy');
  runButton.disabled = false;
}

options.forEach((option) => option.addEventListener('click', () => selectAgent(option.dataset.agent)));

runButton.addEventListener('click', async () => {
  const currentPlayback = ++playback;
  runButton.disabled = true;
  output.setAttribute('aria-busy', 'true');
  steps.forEach((step) => step.classList.add('is-pending'));
  const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550;
  for (const step of steps) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (currentPlayback !== playback) return;
    step.classList.remove('is-pending');
  }
  output.removeAttribute('aria-busy');
  runButton.disabled = false;
  notify(`Illustration complete. ${agents[selectedAgent]} has the brief.`);
});
