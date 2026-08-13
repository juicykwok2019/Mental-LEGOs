import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { query } from '@anthropic-ai/claude-agent-sdk';

const repositoryRoot = process.cwd();
const probeRoot = path.join(repositoryRoot, '.private', 'sdk-offline-probe');
const bundleRoot = path.join(repositoryRoot, 'resources', 'capability-bundle');
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

await rm(probeRoot, { recursive: true, force: true });
await mkdir(path.join(probeRoot, '.agent-config'), { recursive: true });
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
    settingSources: ['project'],
    strictMcpConfig: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill'],
    disallowedTools: ['Agent', 'Task', 'WebSearch', 'WebFetch'],
    allowedTools: [],
    skills: expectedSkills,
    permissionMode: 'dontAsk',
    env: environment,
    maxTurns: 1,
  },
});

let foundInit = false;
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
    process.stdout.write(`${JSON.stringify({
      claude_code_version: message.claude_code_version,
      product_skills: expectedSkills,
      sdk_utility_skills: sdkUtilitySkills,
      tools: message.tools,
      permission_mode: message.permissionMode,
      config_isolated: message.cwd === probeRoot,
    }, null, 2)}\n`);
    break;
  }
} finally {
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(probeRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

if (!foundInit) {
  throw new Error('Claude Agent SDK did not emit an init message during the offline probe.');
}
