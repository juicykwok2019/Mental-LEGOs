import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = process.cwd();
const bundleRoot = path.join(repositoryRoot, 'resources', 'capability-bundle');
const skillsRoot = path.join(bundleRoot, '.claude', 'skills');
const manifestPath = path.join(bundleRoot, 'manifest.json');
const writeMode = process.argv.includes('--write');

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

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entryPath !== manifestPath) {
      files.push(entryPath);
    }
  }

  return files;
}

const skillEntries = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (JSON.stringify(skillEntries) !== JSON.stringify(expectedSkills)) {
  throw new Error(`Skill set mismatch: ${skillEntries.join(', ')}`);
}

for (const skillName of skillEntries) {
  const skillRoot = path.join(skillsRoot, skillName);
  const skillDocument = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  if (!skillDocument.startsWith('---\n')
    || !skillDocument.includes(`\nname: ${skillName}\n`)
    || !skillDocument.includes('\ndescription: ')) {
    throw new Error(`${skillName}: invalid SKILL.md frontmatter`);
  }

  const resources = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && ['references', 'scripts', 'examples'].includes(entry.name));
  if (resources.length === 0) {
    throw new Error(`${skillName}: missing references/scripts/examples route`);
  }

  const routedFiles = (await Promise.all(resources.map((entry) => (
    listFiles(path.join(skillRoot, entry.name))
  )))).flat();
  if (routedFiles.length === 0) {
    throw new Error(`${skillName}: resource routes are empty`);
  }
}

const files = await listFiles(bundleRoot);
const records = [];
for (const file of files) {
  const content = await readFile(file);
  records.push({
    path: path.relative(bundleRoot, file).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.byteLength,
  });
}

const bundleDigest = createHash('sha256')
  .update(records.map((record) => `${record.path}\0${record.sha256}\n`).join(''))
  .digest('hex');

const manifest = {
  schema_version: 1,
  bundle_version: '0.1.0',
  skills: expectedSkills,
  files: records,
  bundle_sha256: bundleDigest,
};

if (writeMode) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote Skill bundle manifest ${bundleDigest}.`);
} else {
  const stored = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(manifest)) {
    throw new Error('Skill bundle manifest is stale or bundle content was modified.');
  }
  console.log(`Skill bundle verified: ${skillEntries.length} skills, ${records.length} files, ${bundleDigest}.`);
}
