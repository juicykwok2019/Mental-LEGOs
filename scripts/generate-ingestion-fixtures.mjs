// Generates the Suite 6 ingestion-regression fixture library
// (tests/fixtures/ingestion). See docs/evaluation-plan.md, Suite 6.
//
// Every fixture is fully synthetic and deterministic: running this script
// twice produces byte-identical files, so the committed binaries can always
// be audited against this source. The script self-checks the trickier
// fixtures (GB18030 bytes, undecodable bytes) before writing.
//
// Usage: node scripts/generate-ingestion-fixtures.mjs

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const outDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'tests', 'fixtures', 'ingestion',
);
mkdirSync(outDirectory, { recursive: true });

const written = [];
function emit(name, bytes) {
  writeFileSync(path.join(outDirectory, name), bytes);
  written.push(name);
}

// ---------------------------------------------------------------- ZIP / DOCX

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function docxDocument(xmlBody) {
  return Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${xmlBody}</w:body></w:document>`,
    'utf8',
  );
}

const contentTypes = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'utf8',
);

emit('mixed-language.docx', buildZip([
  { name: '[Content_Types].xml', data: contentTypes },
  {
    name: 'word/document.xml',
    data: docxDocument(
      '<w:p><w:r><w:t>候选人 Profile：产品经理（AI 方向）</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Requirement: ship a local-first Electron app within Q3.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>面试重点：追问 metrics 与 trade-off。</w:t></w:r></w:p>',
    ),
  },
]));

emit('stored-entry.docx', buildZip([
  { name: '[Content_Types].xml', data: contentTypes, method: 0 },
  {
    name: 'word/document.xml',
    data: docxDocument('<w:p><w:r><w:t>存储方式条目，未压缩。</w:t></w:r></w:p>'),
    method: 0,
  },
]));

emit('entities-and-breaks.docx', buildZip([
  { name: '[Content_Types].xml', data: contentTypes },
  {
    name: 'word/document.xml',
    data: docxDocument(
      '<w:p><w:r><w:t>第一段 &amp; 引用 &lt;标签&gt;</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>列</w:t><w:tab/><w:t>值</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t xml:space="preserve">上半</w:t><w:br/><w:t>下半</w:t></w:r></w:p>',
    ),
  },
]));

emit('missing-body.docx', buildZip([
  { name: '[Content_Types].xml', data: contentTypes },
  { name: 'word/styles.xml', data: Buffer.from('<w:styles/>', 'utf8') },
]));

emit('declared-bomb.docx', buildZip([
  {
    name: 'word/document.xml',
    data: Buffer.from('tiny body', 'utf8'),
    declaredUncompressedSize: 100 * 1024 * 1024,
  },
]));

emit('not-a-zip.docx', Buffer.from('This is not a zip container at all, only plain bytes.', 'utf8'));

emit('legacy.doc', Buffer.concat([
  // OLE2 compound-file magic, as real legacy .doc files start with.
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(120, 0),
]));

// ----------------------------------------------------------------------- PDF

function buildSimplePdf(pageTexts) {
  const objects = [];
  const pageCount = pageTexts.length;
  const kidNumbers = pageTexts.map((_, index) => 3 + index * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kidNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  const fontNumber = 3 + pageCount * 2;
  for (const [index, text] of pageTexts.entries()) {
    const contentNumber = 3 + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R `
      + `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push({ dict: `<< /Length ${stream.length} >>`, stream });
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return assemblePdf(objects, { root: 1 });
}

function assemblePdf(objects, { root, encrypt, id }) {
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    const number = index + 1;
    if (typeof object === 'string') {
      body += `${number} 0 obj\n${object}\nendobj\n`;
    } else {
      body += `${number} 0 obj\n${object.dict}\nstream\n${object.stream}\nendstream\nendobj\n`;
    }
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const objectOffset of offsets) {
    body += `${String(objectOffset).padStart(10, '0')} 00000 n \n`;
  }
  const trailerParts = [`/Size ${objects.length + 1}`, `/Root ${root} 0 R`];
  if (encrypt) trailerParts.push(`/Encrypt ${encrypt} 0 R`);
  if (id) trailerParts.push(`/ID [<${id}> <${id}>]`);
  body += `trailer\n<< ${trailerParts.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

emit('english-single-page.pdf', buildSimplePdf([
  'Mental LEGOs ingestion regression: plain English single page.',
]));

emit('english-multi-page.pdf', buildSimplePdf([
  'Page one: opening statement for the mock interview.',
  'Page two: evidence and metrics behind the claim.',
  'Page three: closing reassembly of the argument.',
]));

// A scanned document has pages but no text operators at all.
emit('scanned-no-text.pdf', assemblePdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
  { dict: '<< /Length 26 >>', stream: '0 0 612 792 re f\n72 72 m h' },
], { root: 1 }));

emit('corrupt-truncated.pdf', Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\nGARBAGE'
  + 'x'.repeat(64),
  'latin1',
));

// CID-keyed Chinese PDF: Type0 font, Identity-H, ToUnicode CMap, no embedded
// font program — the exact shape that broke real-world Chinese PDFs before
// the CMap/standard-font fixes (git log of src/main/material-file.ts).
function buildCidChinesePdf() {
  const text = '面试追问';
  const codePoints = [...text].map((ch) => ch.codePointAt(0));
  const cidHex = codePoints.map((_, index) => String(index + 1).padStart(4, '0')).join('');
  const bfchars = codePoints
    .map((cp, index) => `<${String(index + 1).padStart(4, '0')}> <${cp.toString(16).toUpperCase().padStart(4, '0')}>`)
    .join('\n');
  const cmap = '/CIDInit /ProcSet findresource begin\n'
    + '12 dict begin\nbegincmap\n'
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
    + '/CMapName /SyntheticUnicode def\n/CMapType 2 def\n'
    + '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
    + `${codePoints.length} beginbfchar\n${bfchars}\nendbfchar\n`
    + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  const content = `BT /F1 16 Tf 72 700 Td <${cidHex}> Tj ET`;
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>',
    { dict: `<< /Length ${content.length} >>`, stream: content },
    '<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticCJK /Encoding /Identity-H '
      + '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticCJK '
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> '
      + '/FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>',
    { dict: `<< /Length ${cmap.length} >>`, stream: cmap },
    '<< /Type /FontDescriptor /FontName /SyntheticCJK /Flags 4 /FontBBox [0 0 1000 1000] '
      + '/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ], { root: 1 });
}
emit('cid-chinese.pdf', buildCidChinesePdf());

// Password-protected PDF (standard security handler, V1/R2, RC4-40).
function rc4(key, data) {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const output = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let index = 0; index < data.length; index += 1) {
    a = (a + 1) & 0xff;
    b = (b + state[a]) & 0xff;
    [state[a], state[b]] = [state[b], state[a]];
    output[index] = data[index] ^ state[(state[a] + state[b]) & 0xff];
  }
  return output;
}

const PDF_PASSWORD_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword(password) {
  return Buffer.concat([Buffer.from(password, 'latin1'), PDF_PASSWORD_PAD]).subarray(0, 32);
}

function buildEncryptedPdf() {
  const userPassword = 'synthetic-fixture';
  const permissions = -4; // all bits except reserved cleared per R2 convention
  const fileId = Buffer.from('4d656e74616c4c45474f73206669780a'.padEnd(32, '0').slice(0, 32), 'hex');

  const ownerKey = createHash('md5').update(padPassword(userPassword)).digest().subarray(0, 5);
  const ownerValue = rc4(ownerKey, padPassword(userPassword));

  const permissionBytes = Buffer.alloc(4);
  permissionBytes.writeInt32LE(permissions, 0);
  const encryptionKey = createHash('md5')
    .update(padPassword(userPassword))
    .update(ownerValue)
    .update(permissionBytes)
    .update(fileId)
    .digest()
    .subarray(0, 5);
  const userValue = rc4(encryptionKey, PDF_PASSWORD_PAD);

  const stream = 'BT /F1 12 Tf 72 720 Td (locked) Tj ET';
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    { dict: `<< /Length ${stream.length} >>`, stream },
    `<< /Filter /Standard /V 1 /R 2 /O <${ownerValue.toString('hex')}> `
      + `/U <${userValue.toString('hex')}> /P ${permissions} >>`,
  ], { root: 1, encrypt: 5, id: fileId.toString('hex') });
}
emit('encrypted.pdf', buildEncryptedPdf());

// ---------------------------------------------------------------- plain text

function utf16be(text) {
  const littleEndian = Buffer.from(text, 'utf16le');
  return Buffer.from(littleEndian).swap16();
}

emit('utf8-bom.txt', Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('带 BOM 的 UTF-8 材料内容。', 'utf8'),
]));

emit('utf16le-bom.txt', Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('UTF-16LE 编码的材料内容。', 'utf16le'),
]));

emit('utf16be-bom.txt', Buffer.concat([
  Buffer.from([0xfe, 0xff]),
  utf16be('UTF-16BE 编码的材料内容。'),
]));

// "中文材料测试" in GBK/GB18030 bytes; self-checked below.
const gbBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xc4, 0xc1, 0xcf, 0xb2, 0xe2, 0xca, 0xd4]);
{
  const decoded = new TextDecoder('gb18030').decode(gbBytes);
  if (decoded !== '中文材料测试') {
    throw new Error(`GB18030 fixture self-check failed: got ${decoded}`);
  }
}
emit('gb18030.txt', gbBytes);

// Damaged in UTF-8 and no better under GB18030; self-checked.
const undecodable = Buffer.from([0xff, 0x41, 0xff, 0x42, 0xff, 0x43]);
{
  const countBad = (value) => [...value].filter((ch) => ch === '�').length;
  const utf8Damage = countBad(new TextDecoder('utf-8').decode(undecodable));
  const gbDamage = countBad(new TextDecoder('gb18030').decode(undecodable));
  if (utf8Damage === 0 || gbDamage < utf8Damage) {
    throw new Error(`undecodable fixture self-check failed: utf8=${utf8Damage} gb=${gbDamage}`);
  }
}
emit('undecodable.txt', undecodable);

emit('empty.txt', Buffer.alloc(0));

emit('mixed-language.md', Buffer.from(
  '# 场景材料 / Scenario material\n\n'
  + '- 目标 target：在 20 分钟内讲清 roadmap。\n'
  + '- 风险 risk：被追问 unit economics 时卡壳。\n',
  'utf8',
));

console.log(`generated ${written.length} fixtures in ${outDirectory}`);
for (const name of written.sort()) console.log(`  ${name}`);
