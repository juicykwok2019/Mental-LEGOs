import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MATERIAL_TEXT_LIMIT,
  decodeTextBuffer,
  docxXmlToText,
  extractDocxText,
  parseMaterialFile,
} from '../../src/main/material-file';

interface ZipEntrySpec {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  declaredUncompressedSize?: number;
}

function buildZip(entries: ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
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

function docxBody(xmlBody: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xmlBody}</w:body></w:document>`;
}

function buildMinimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const parts = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const part of parts) {
    offsets.push(body.length);
    body += part;
  }
  const xrefOffset = body.length;
  body += 'xref\n0 6\n0000000000 65535 f \n';
  for (const objectOffset of offsets) {
    body += `${String(objectOffset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

let workDirectory: string;

beforeAll(async () => {
  workDirectory = await mkdtemp(path.join(tmpdir(), 'mental-legos-material-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

describe('docx text extraction', () => {
  it('turns paragraphs, tabs, breaks, and entities into plain text', () => {
    const xml = docxBody(
      '<w:p><w:r><w:t>第一段 &amp; 引用 &lt;标签&gt;</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>列</w:t><w:tab/><w:t>值</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t xml:space="preserve">上半</w:t><w:br/><w:t>下半</w:t></w:r></w:p>',
    );
    expect(docxXmlToText(xml)).toBe('第一段 & 引用 <标签>\n列\t值\n上半\n下半');
  });

  it('reads a stored-zip docx', () => {
    const archive = buildZip([{
      name: 'word/document.xml',
      data: Buffer.from(docxBody('<w:p><w:r><w:t>存储条目内容</w:t></w:r></w:p>'), 'utf8'),
    }]);
    expect(extractDocxText(archive)).toBe('存储条目内容');
  });

  it('reads a deflated-zip docx', () => {
    const archive = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8'), method: 8 },
      {
        name: 'word/document.xml',
        data: Buffer.from(docxBody('<w:p><w:r><w:t>压缩条目内容</w:t></w:r></w:p>'), 'utf8'),
        method: 8,
      },
    ]);
    expect(extractDocxText(archive)).toBe('压缩条目内容');
  });

  it('rejects a zip without a document body', () => {
    const archive = buildZip([{ name: 'other.xml', data: Buffer.from('<x/>', 'utf8') }]);
    expect(() => extractDocxText(archive)).toThrow(/Word 文档/u);
  });

  it('rejects a declared decompression bomb before inflating', () => {
    const archive = buildZip([{
      name: 'word/document.xml',
      data: Buffer.from('tiny', 'utf8'),
      declaredUncompressedSize: 100 * 1024 * 1024,
    }]);
    expect(() => extractDocxText(archive)).toThrow(/庞大/u);
  });
});

describe('plain text decoding', () => {
  it('strips a UTF-8 BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('内容', 'utf8')]);
    expect(decodeTextBuffer(bytes)).toEqual({ text: '内容', warnings: [] });
  });

  it('falls back to GB18030 when UTF-8 decoding is damaged', () => {
    // "中文" encoded as GBK bytes.
    const decoded = decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    expect(decoded.text).toBe('中文');
    expect(decoded.warnings).toHaveLength(1);
  });

  it('decodes UTF-16LE with a BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('文本', 'utf16le')]);
    expect(decodeTextBuffer(bytes).text).toBe('文本');
  });
});

describe('parseMaterialFile', () => {
  it('extracts text from a PDF', async () => {
    const filePath = path.join(workDirectory, 'sample.pdf');
    await writeFile(filePath, buildMinimalPdf('Hello Mental LEGOs material parsing'));
    const parsed = await parseMaterialFile(filePath);
    expect(parsed.kind).toBe('pdf');
    expect(parsed.text).toContain('Hello Mental LEGOs material parsing');
    expect(parsed.truncated).toBe(false);
  });

  it('truncates oversized text files and reports it', async () => {
    const filePath = path.join(workDirectory, 'huge.txt');
    await writeFile(filePath, 'a'.repeat(MATERIAL_TEXT_LIMIT + 100), 'utf8');
    const parsed = await parseMaterialFile(filePath);
    expect(parsed.kind).toBe('text');
    expect(parsed.text).toHaveLength(MATERIAL_TEXT_LIMIT);
    expect(parsed.truncated).toBe(true);
  });

  it('refuses legacy .doc files with guidance', async () => {
    const filePath = path.join(workDirectory, 'legacy.doc');
    await writeFile(filePath, 'not really a doc', 'utf8');
    await expect(parseMaterialFile(filePath)).rejects.toThrow(/docx/u);
  });
});
