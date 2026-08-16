import { z } from 'zod';

import type { CandidateKind, DataScope as GovernanceScope } from '../agent/governance';
import {
  knowledgeKindSchema,
  legoCategorySchema,
  legoVersionPayloadSchema,
  type DataScope as ProductScope,
} from './contracts';
import type { ProductDatabase } from './product-database';

// Bridges governance-confirmed formal assets into the formal product database
// (WP-P1-02). Runs after commitConfirmed and is idempotent: the materialized
// entity id equals the formal asset id, so a crash between the staging commit
// and this sync is repaired by re-running sync.

export interface FormalAssetRecord {
  id: string;
  kind: CandidateKind;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  scope: GovernanceScope;
}

const legoMaterialSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: legoCategorySchema,
  triggers: z.array(z.string().min(1).max(200)).max(20).default([]),
  semantic_kernel: z.string().min(1),
  logic_skeleton: z.array(z.string().min(1)).min(1).max(8),
  language_shells: z.array(z.string().min(1)).min(1),
  anchor_phrase: z.string().default(''),
  slots: z.array(z.object({ name: z.string().min(1), description: z.string().default('') }))
    .default([]),
  purpose: z.string().default(''),
  boundaries: z.string().default(''),
});

const profileMaterialSchema = z.object({
  statement: z.string().min(1),
  tier: z.enum(['evidenced-observation', 'pending-hypothesis'])
    .default('evidenced-observation'),
});

const knowledgeMaterialSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().min(1),
  knowledge_kind: knowledgeKindSchema.default('viewpoint'),
});

function productScope(scope: GovernanceScope): ProductScope {
  if (scope === 'personal') return 'global';
  if (scope === 'scenario') return 'scenario';
  throw new Error('Session-scoped candidates cannot become formal assets.');
}

export function validateCandidatePayload(kind: CandidateKind, payload: unknown): void {
  if (kind === 'language_module') {
    legoMaterialSchema.parse(payload);
  } else if (kind === 'profile_observation') {
    profileMaterialSchema.parse(payload);
  } else {
    knowledgeMaterialSchema.parse(payload);
  }
}

export interface MaterializationResult {
  materialized: Array<{ assetId: string; entity: 'lego-module' | 'profile-assertion' | 'knowledge-item' }>;
  skippedExisting: string[];
  failed: Array<{ assetId: string; reason: string }>;
}

export class FormalMaterializer {
  readonly #product: ProductDatabase;
  readonly #scenarioId: string | null;

  constructor(product: ProductDatabase, options: { scenarioId?: string } = {}) {
    this.#product = product;
    this.#scenarioId = options.scenarioId ?? null;
  }

  sync(assets: FormalAssetRecord[], now = new Date().toISOString()): MaterializationResult {
    const result: MaterializationResult = { materialized: [], skippedExisting: [], failed: [] };
    for (const asset of assets) {
      try {
        const entity = this.#materialize(asset, now);
        if (entity === null) result.skippedExisting.push(asset.id);
        else result.materialized.push({ assetId: asset.id, entity });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown materialization error.';
        result.failed.push({ assetId: asset.id, reason });
        this.#product.recordAuditEvent({
          id: asset.id,
          category: 'error',
          code: 'formal-materialization-failed',
          detail: `${asset.kind}: ${reason}`,
          now,
        });
      }
    }
    return result;
  }

  #materialize(
    asset: FormalAssetRecord,
    now: string,
  ): 'lego-module' | 'profile-assertion' | 'knowledge-item' | null {
    const scope = productScope(asset.scope);
    const scenarioId = scope === 'scenario' ? this.#requireScenarioId() : null;
    const evidence = this.#evidenceSegmentIds(asset.provenance);

    if (asset.kind === 'language_module') {
      if (this.#product.getLegoModule(asset.id)) return null;
      const material = legoMaterialSchema.parse(asset.payload);
      this.#product.createLegoCandidate({
        id: asset.id,
        scope,
        scenarioId,
        category: material.category,
        title: material.title,
        triggers: material.triggers,
        payload: legoVersionPayloadSchema.parse({
          semanticKernel: material.semantic_kernel,
          logicSkeleton: material.logic_skeleton,
          languageShells: material.language_shells,
          anchorPhrase: material.anchor_phrase,
          slots: material.slots,
          purpose: material.purpose,
          boundaries: material.boundaries,
        }),
        authorship: 'co-extracted',
        evidenceSegmentIds: evidence,
        now,
      });
      this.#product.confirmLegoVersion(asset.id, 1, now);
      return 'lego-module';
    }

    if (asset.kind === 'profile_observation') {
      const material = profileMaterialSchema.parse(asset.payload);
      try {
        this.#product.createProfileAssertion({
          id: asset.id,
          tier: material.tier,
          statement: material.statement,
          evidenceSegmentIds: evidence,
          now,
        });
      } catch (error) {
        if (error instanceof Error && /UNIQUE|PRIMARY/iu.test(error.message)) return null;
        throw error;
      }
      this.#product.resolveProfileAssertion(asset.id, 'confirmed', now);
      return 'profile-assertion';
    }

    if (this.#product.getKnowledgeItem(asset.id)) return null;
    const material = knowledgeMaterialSchema.parse(asset.payload);
    this.#product.createKnowledgeCandidate({
      id: asset.id,
      scope,
      scenarioId,
      kind: material.knowledge_kind,
      title: material.title,
      content: material.content,
      sourceSegmentIds: evidence,
      now,
    });
    this.#product.confirmKnowledgeItem(asset.id, now);
    return 'knowledge-item';
  }

  #requireScenarioId(): string {
    if (!this.#scenarioId) {
      throw new Error('Scenario-scoped assets require a bound scenario.');
    }
    return this.#scenarioId;
  }

  #evidenceSegmentIds(provenance: Record<string, unknown>): string[] {
    const refs = z.object({ source_refs: z.array(z.string()).default([]) })
      .catch({ source_refs: [] })
      .parse(provenance).source_refs;
    return refs
      .map((ref) => /^segment:([a-f0-9-]{36})$/u.exec(ref)?.[1])
      .filter((id): id is string => id !== undefined)
      .filter((id) => this.#product.getSourceSegment(id) !== null);
  }
}
