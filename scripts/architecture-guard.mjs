import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = process.cwd();
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
);

const forbiddenDependencies = [
  'langchain',
  '@langchain/core',
  '@langchain/langgraph',
  'langgraph',
  'dify-client',
  'openai',
  '@anthropic-ai/sdk',
];

const allDependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};

const violations = [];

for (const dependency of forbiddenDependencies) {
  if (dependency in allDependencies) {
    violations.push(`Forbidden architecture dependency: ${dependency}`);
  }
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(entryPath));
    } else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

const forbiddenSourcePatterns = [
  { pattern: /\/v1\/messages/gu, reason: 'direct Anthropic Messages API' },
  { pattern: /\/chat\/completions/gu, reason: 'OpenAI Chat Completions API' },
  { pattern: /\/v1\/responses/gu, reason: 'OpenAI Responses API' },
  { pattern: /from\s+['"]openai['"]/gu, reason: 'OpenAI client import' },
  { pattern: /from\s+['"]@anthropic-ai\/sdk['"]/gu, reason: 'Anthropic client SDK import' },
];

for (const file of await listSourceFiles(path.join(repositoryRoot, 'src'))) {
  const content = await readFile(file, 'utf8');
  for (const { pattern, reason } of forbiddenSourcePatterns) {
    if (pattern.test(content)) {
      violations.push(`${path.relative(repositoryRoot, file)}: ${reason}`);
    }
    pattern.lastIndex = 0;
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Architecture guard passed.');
}
