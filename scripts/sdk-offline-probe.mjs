import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';

const repositoryRoot = process.cwd();
const probeRoot = path.join(repositoryRoot, '.private', 'sdk-offline-probe');
const bundleRoot = path.join(repositoryRoot, 'resources', 'capability-bundle');
const sandboxLauncher = path.join(
  repositoryRoot,
  'resources',
  'windows-sandbox',
  'MentalLegos.SandboxLauncher.exe',
);
const sandboxProfile = `MentalLEGOs.SDKProbe.${process.pid}.${Date.now()}`;
const expectedSkills = [
  'deep-research',
  'first-attempt-coach',
  'lego-extraction',
  'post-event-review',
  'privacy-provenance',
  'professional-speaking',
  'profile-evidence',
  'response-diagnosis',
  'scenario-preparation',
  'transfer-question-design',
];
const governanceServerNames = [
  'context', 'artifact', 'commit', 'practice', 'media', 'lifecycle',
];
const mcpServers = Object.fromEntries(governanceServerNames.map((name) => [
  name,
  createSdkMcpServer({
    name,
    version: '1.0.0-probe',
    tools: [tool(
      'phase_zero_probe',
      'Prove that the pinned SDK can initialize an in-process governance server.',
      {},
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    )],
  }),
]));

await rm(probeRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(path.join(probeRoot, '.agent-config'), { recursive: true }),
  mkdir(path.join(probeRoot, 'input'), { recursive: true }),
  mkdir(path.join(probeRoot, 'scratch'), { recursive: true }),
  mkdir(path.join(probeRoot, 'output'), { recursive: true }),
  mkdir(path.join(probeRoot, 'tmp'), { recursive: true }),
]);
await cp(path.join(bundleRoot, '.claude'), path.join(probeRoot, '.claude'), {
  recursive: true,
});
await cp(path.join(bundleRoot, 'CLAUDE.md'), path.join(probeRoot, 'CLAUDE.md'));

const environment = {};
for (const key of [
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA',
]) {
  if (process.env[key]) environment[key] = process.env[key];
}
Object.assign(environment, {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  ANTHROPIC_API_KEY: 'phase-zero-offline-probe',
  CLAUDE_CONFIG_DIR: path.join(probeRoot, '.agent-config'),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'mental-legos-phase-zero-probe/0.1.0',
});

const stream = query({
  prompt: 'Initialize the runtime. Do not call tools.',
  options: {
    cwd: probeRoot,
    pathToClaudeCodeExecutable: path.join(
      repositoryRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-win32-x64',
      'claude.exe',
    ),
    spawnClaudeCodeProcess: (options) => spawn(sandboxLauncher, [
      'run',
      '--profile', sandboxProfile,
      '--workspace', probeRoot,
      '--target', options.command,
      '--writable', path.join(probeRoot, '.agent-config'),
      '--writable', path.join(probeRoot, 'scratch'),
      '--writable', path.join(probeRoot, 'output'),
      '--writable', path.join(probeRoot, 'tmp'),
      '--',
      ...options.args,
    ], {
      cwd: probeRoot,
      env: options.env,
      shell: false,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    }),
    settingSources: ['project'],
    strictMcpConfig: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill',
      ...governanceServerNames.map((name) => `mcp__${name}__phase_zero_probe`),
    ],
    disallowedTools: ['Agent', 'Task', 'WebSearch', 'WebFetch'],
    allowedTools: [],
    skills: expectedSkills,
    mcpServers,
    permissionMode: 'dontAsk',
    env: environment,
    maxTurns: 1,
  },
});

let foundInit = false;
let cleanupError;
try {
  for await (const message of stream) {
    if (message.type !== 'system' || message.subtype !== 'init') continue;
    foundInit = true;
    const actualSkills = [...message.skills].sort();
    for (const skillName of expectedSkills) {
      if (actualSkills.filter((value) => value === skillName).length !== 1) {
        throw new Error(`SDK did not discover exactly one project Skill named ${skillName}.`);
      }
    }
    const sdkUtilitySkills = actualSkills.filter((value) => !expectedSkills.includes(value));
    if (JSON.stringify(sdkUtilitySkills) !== JSON.stringify(['doctor'])) {
      throw new Error(`SDK exposed unexpected utility Skills: ${sdkUtilitySkills.join(', ')}`);
    }
    if (message.tools.includes('Agent') || message.tools.includes('Task')) {
      throw new Error('SDK exposed a subagent tool in ordinary mode.');
    }
    const connectedServers = message.mcp_servers
      .filter((server) => server.status === 'connected')
      .map((server) => server.name)
      .sort();
    if (JSON.stringify(connectedServers) !== JSON.stringify(governanceServerNames.slice().sort())) {
      throw new Error(`SDK MCP initialization mismatch: ${JSON.stringify(message.mcp_servers)}`);
    }
    process.stdout.write(`${JSON.stringify({
      claude_code_version: message.claude_code_version,
      product_skills: expectedSkills,
      sdk_utility_skills: sdkUtilitySkills,
      tools: message.tools,
      permission_mode: message.permissionMode,
      config_isolated: message.cwd === probeRoot,
      connected_mcp_servers: connectedServers,
    }, null, 2)}\n`);
    break;
  }
} finally {
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const deleteResult = await new Promise((resolve, reject) => {
      const child = spawn(sandboxLauncher, [
        'delete-profile',
        sandboxProfile,
        path.dirname(path.join(
          repositoryRoot,
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk-win32-x64',
          'claude.exe',
        )),
        path.join(
          repositoryRoot,
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk-win32-x64',
          'claude.exe',
        ),
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stderr }));
    });
    if (deleteResult.code !== 0) {
      cleanupError = new Error(
        deleteResult.stderr || 'Could not delete the SDK probe AppContainer profile.',
      );
    }
  } catch (reason) {
    cleanupError = reason instanceof Error ? reason : new Error('Sandbox cleanup failed.');
  }
  await rm(probeRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

if (cleanupError) throw cleanupError;
if (!foundInit) {
  throw new Error('Claude Agent SDK did not emit an init message during the offline probe.');
}
