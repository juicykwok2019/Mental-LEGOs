// 评测语料完整性校验（docs/evaluation-plan.md Suite 1/2 语料）。
// 语料是判分的地基：人设覆盖、题型覆盖、噪声版与干净版的一致性
// 都在这里锁住，语料被误改时 CI 立刻红。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { normalizeForMatch, scoreShellFidelity } from '../eval/scoring';

const fixturesDirectory = path.resolve(__dirname, '..', 'fixtures', 'eval');

interface Persona { id: string; label: string; direction: string }
interface Suite1Case {
  id: string; personaId: string; questionType: string;
  kind: 'typed' | 'ladder'; question: string; answer: string;
}
interface Suite2Case {
  id: string; personaId: string; question: string;
  firstAttempt: string; secondAttempt: string; noisySecondAttempt: string;
}

const QUESTION_TYPES = [
  'viewpoint', 'mechanism', 'decision', 'case-recall', 'challenge', 'pressure-probe',
] as const;

let personas: Persona[];
let suite1: Suite1Case[];
let suite2: Suite2Case[];

async function loadJson<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDirectory, fileName), 'utf8')) as T;
}

beforeAll(async () => {
  personas = (await loadJson<{ personas: Persona[] }>('personas.json')).personas;
  suite1 = (await loadJson<{ cases: Suite1Case[] }>('suite1-discipline.json')).cases;
  suite2 = (await loadJson<{ cases: Suite2Case[] }>('suite2-extraction.json')).cases;
});

describe('personas corpus', () => {
  it('defines the eight synthetic personas with unique ids', () => {
    expect(personas).toHaveLength(8);
    expect(new Set(personas.map((persona) => persona.id)).size).toBe(8);
  });
});

describe('suite 1 discipline corpus', () => {
  it('has around sixty cases with unique ids', () => {
    expect(suite1.length).toBeGreaterThanOrEqual(60);
    expect(new Set(suite1.map((entry) => entry.id)).size).toBe(suite1.length);
  });

  it('covers every persona × question-type combination in the typed set', () => {
    const covered = new Set(
      suite1
        .filter((entry) => entry.kind === 'typed')
        .map((entry) => `${entry.personaId}:${entry.questionType}`),
    );
    for (const persona of personas) {
      for (const questionType of QUESTION_TYPES) {
        expect(covered.has(`${persona.id}:${questionType}`), `${persona.id} 缺 ${questionType}`).toBe(true);
      }
    }
  });

  it('includes ladder scenarios for the hint-ladder eval', () => {
    expect(suite1.filter((entry) => entry.kind === 'ladder').length).toBeGreaterThanOrEqual(10);
  });

  it('keeps every case well-formed and persona-linked', () => {
    const personaIds = new Set(personas.map((persona) => persona.id));
    for (const entry of suite1) {
      expect(personaIds.has(entry.personaId), entry.id).toBe(true);
      expect(QUESTION_TYPES).toContain(entry.questionType);
      expect([...entry.question].length, entry.id).toBeGreaterThanOrEqual(8);
      expect([...entry.answer].length, entry.id).toBeGreaterThanOrEqual(20);
    }
  });
});

describe('suite 2 extraction corpus', () => {
  it('has at least thirty triples with unique ids', () => {
    expect(suite2.length).toBeGreaterThanOrEqual(30);
    expect(new Set(suite2.map((entry) => entry.id)).size).toBe(suite2.length);
  });

  it('links every triple to a persona and keeps attempts distinct', () => {
    const personaIds = new Set(personas.map((persona) => persona.id));
    for (const entry of suite2) {
      expect(personaIds.has(entry.personaId), entry.id).toBe(true);
      expect(entry.firstAttempt, entry.id).not.toBe(entry.secondAttempt);
      expect([...entry.secondAttempt].length, entry.id).toBeGreaterThanOrEqual(40);
    }
  });

  it('keeps the ASR-noisy variant faithful to the clean second attempt', () => {
    for (const entry of suite2) {
      // 噪声版只允许丢标点、换同音字、插语气词——语义内容必须还在。
      const fidelity = scoreShellFidelity(entry.secondAttempt, entry.noisySecondAttempt);
      expect(fidelity, `${entry.id} noisy fidelity ${fidelity.toFixed(2)}`).toBeGreaterThanOrEqual(0.8);
      // 且不能干净到没有噪声——归一化前后不应完全一致。
      expect(entry.noisySecondAttempt, entry.id).not.toBe(entry.secondAttempt);
    }
  });

  it('noisy variants stay in the same normalized ballpark (no content swap)', () => {
    for (const entry of suite2) {
      const clean = normalizeForMatch(entry.secondAttempt).length;
      const noisy = normalizeForMatch(entry.noisySecondAttempt).length;
      expect(Math.abs(clean - noisy) / clean, entry.id).toBeLessThan(0.15);
    }
  });
});
