import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

// Matches scenarioMaterialInputSchema's content cap in shared/contracts.ts.
export const MATERIAL_TEXT_LIMIT = 500_000;
const FILE_SIZE_LIMIT = 25 * 1024 * 1024;
// A DOCX body XML larger than this is either corrupt or a decompression bomb.
const DOCX_XML_LIMIT = 64 * 1024 * 1024;

export interface ParsedMaterialFileResult {
  fileName: string;
  kind: 'pdf' | 'docx' | 'text';
  text: string;
  warnings: string[];
  truncated: boolean;
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

function findZipEntry(archive: Buffer, entryName: string): Buffer | null {
  const scanFloor = Math.max(0, archive.length - 65_557);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= scanFloor; offset -= 1) {
    if (archive.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('这个文件不是有效的 ZIP 容器。');

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let cursor = archive.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('ZIP 中央目录损坏。');
    }
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name !== entryName) continue;
    if (uncompressedSize > DOCX_XML_LIMIT) {
      throw new Error('文档内容异常庞大，已拒绝解析。');
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error('ZIP 本地文件头损坏。');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) return Buffer.from(data);
    if (compressionMethod === 8) {
      return inflateRawSync(data, { maxOutputLength: DOCX_XML_LIMIT });
    }
    throw new Error(`不支持的 ZIP 压缩方式（${compressionMethod}）。`);
  }

  return null;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/gu, (whole, code: string) => {
    switch (code) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const numeric = code.startsWith('#x') || code.startsWith('#X')
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
        return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
          ? String.fromCodePoint(numeric)
          : whole;
      }
    }
  });
}

export function docxXmlToText(xml: string): string {
  const runPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/gu;
  const lines: string[] = [];
  for (const paragraph of xml.split(/<\/w:p>/u)) {
    let text = '';
    for (const match of paragraph.matchAll(runPattern)) {
      if (match[1] !== undefined) text += decodeXmlEntities(match[1]);
      else if (match[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    lines.push(text.trimEnd());
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

export function extractDocxText(fileBytes: Buffer): string {
  const body = findZipEntry(fileBytes, 'word/document.xml');
  if (!body) {
    throw new Error('这不是一个有效的 Word 文档（缺少正文）。旧版 .doc 请先另存为 .docx。');
  }
  return docxXmlToText(body.toString('utf8'));
}

function countReplacementCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === '�') count += 1;
  }
  return count;
}

export function decodeTextBuffer(bytes: Buffer): { text: string; warnings: string[] } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), warnings: [] };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), warnings: [] };
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes).replace(/^FEFF/u, '');
  const utf8Damage = countReplacementCharacters(utf8);
  if (utf8Damage === 0) return { text: utf8, warnings: [] };

  const gb18030 = new TextDecoder('gb18030').decode(bytes);
  if (countReplacementCharacters(gb18030) < utf8Damage) {
    return { text: gb18030, warnings: ['文件不是 UTF-8 编码，已按 GB18030 解码，请核对内容。'] };
  }
  return { text: utf8, warnings: ['文件包含无法解码的字符，请核对内容。'] };
}

async function extractPdfText(fileBytes: Buffer, warnings: string[]): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    // pdfjs mutates/transfers its input, so hand it a private copy.
    data: new Uint8Array(fileBytes),
    disableFontFace: true,
    useSystemFonts: false,
  });

  try {
    let document;
    try {
      document = await loadingTask.promise;
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'PasswordException') {
        throw new Error('这个 PDF 有密码保护。请先解除密码，或复制内容后粘贴。', { cause: reason });
      }
      throw new Error('无法解析这个 PDF 文件。可以复制内容后直接粘贴。', { cause: reason });
    }
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if ('str' in item) {
          pageText += item.str;
          if (item.hasEOL) pageText += '\n';
        }
      }
      pages.push(pageText.trim());
      page.cleanup();
    }
    const text = pages.filter((page) => page.length > 0).join('\n\n');
    if (text.length === 0) {
      warnings.push('这个 PDF 里没有可提取的文本（可能是扫描件）。可以复制内容后直接粘贴。');
    }
    return text;
  } finally {
    await loadingTask.destroy();
  }
}

export async function parseMaterialFile(filePath: string): Promise<ParsedMaterialFileResult> {
  const fileName = path.basename(filePath);
  const fileStat = await stat(filePath);
  if (fileStat.size > FILE_SIZE_LIMIT) {
    throw new Error('文件超过 25MB。请拆分或复制需要的部分粘贴。');
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.doc') {
    throw new Error('旧版 .doc 格式暂不支持。请先在 Word 中另存为 .docx。');
  }

  const fileBytes = await readFile(filePath);
  const warnings: string[] = [];
  let kind: ParsedMaterialFileResult['kind'];
  let text: string;

  if (extension === '.pdf') {
    kind = 'pdf';
    text = await extractPdfText(fileBytes, warnings);
  } else if (extension === '.docx') {
    kind = 'docx';
    text = extractDocxText(fileBytes);
  } else {
    kind = 'text';
    const decoded = decodeTextBuffer(fileBytes);
    text = decoded.text;
    warnings.push(...decoded.warnings);
  }

  text = text.replace(/\r\n?/gu, '\n').trim();
  let truncated = false;
  if (text.length > MATERIAL_TEXT_LIMIT) {
    text = text.slice(0, MATERIAL_TEXT_LIMIT);
    truncated = true;
    warnings.push('文本超过 50 万字符，已截断到上限。');
  }

  return { fileName, kind, text, warnings, truncated };
}
