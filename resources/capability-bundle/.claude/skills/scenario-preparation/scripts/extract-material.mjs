import { readFile } from 'node:fs/promises';
import path from 'node:path';

const filePath = process.argv[2];
if (!filePath) throw new Error('Pass an authorized input file path.');

const extension = path.extname(filePath).toLowerCase();
const raw = await readFile(filePath, 'utf8');
let sections;

if (extension === '.json') {
  const parsed = JSON.parse(raw);
  sections = Object.entries(parsed).map(([heading, value]) => ({ heading, text: String(value) }));
} else {
  sections = raw
    .split(/^#{1,6}\s+/mu)
    .map((text, index) => ({ heading: index === 0 ? 'document' : `section-${index}`, text: text.trim() }))
    .filter((section) => section.text);
}

process.stdout.write(JSON.stringify({ source_name: path.basename(filePath), sections }));
