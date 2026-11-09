import { z } from 'zod';

const occurrence = z.object({
  id: z.string().min(1),
  url: z.string(),
  navigationVersion: z.number().int().min(0),
});
const project = z.object({
  name: z.string().min(1).max(80),
  purpose: z.string().max(500),
  areaName: z.string().min(1).max(80).nullable(),
  categories: z
    .array(z.object({ name: z.string().min(1).max(80), description: z.string().max(300) }))
    .max(1000),
});
const assignment = z.object({
  recordId: z.string().min(1),
  url: z.string(),
  navigationVersion: z.number().int().min(0),
  projectName: z.string().max(80),
  categoryName: z.string().max(80),
  reason: z.string().max(300),
  confidence: z.number().min(0).max(1),
  suggestedTags: z.array(z.string().trim().min(1).max(80)).optional(),
});
export const collectionAnalysisSchema = z.object({
  tagCommit: z
    .object({
      proposalId: z.string(),
      processed: z.number().int().min(0),
      tagged: z.number().int().min(0),
      needsReview: z.number().int().min(0),
      skipped: z.number().int().min(0),
    })
    .optional(),
  tagTarget: z
    .object({
      kind: z.literal('workspace').optional(),
      proposalId: z.string().min(1),
      proposalFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      skippedCount: z.number().int().min(0).max(1000).optional(),
    })
    .optional(),
  taggingRequested: z.boolean().optional(),
  skippedTagRecordIds: z.array(z.string().min(1)).max(1000).optional(),
  skippedRecordIds: z.array(z.string().min(1)).max(1000).optional(),
  decisionContract: z.string().max(80).optional(),
  projectChecks: z
    .array(
      z.object({
        recordId: z.string(),
        url: z.string(),
        navigationVersion: z.number().int().min(0),
        projectName: z.string().nullable(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(1000)
    .optional(),
  sourceAnalysisId: z.string().max(200).optional(),
  legacyCategoriesRetained: z.boolean().optional(),
  taxonomyProgress: z
    .object({
      cursor: z.number().int().min(0),
      sources: z.array(project).max(1000),
      projects: z.array(project).max(1000),
    })
    .optional(),
  unresolvedTagSuggestions: z
    .array(
      z.object({
        recordId: z.string().min(1),
        url: z.string(),
        navigationVersion: z.number().int().min(0),
        suggestedTags: z.array(z.string().trim().min(1).max(80)),
      }),
    )
    .max(1000)
    .optional(),
  id: z.string().min(1).max(200),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  revision: z.number().int().min(1),
  purpose: z.enum(['proposal', 'scoped', 'reclassify', 'project']),
  instruction: z.string().max(1000),
  reuseAcceptedTaxonomyOnly: z.boolean(),
  scope: z.array(occurrence).min(1).max(1000),
  discoveredIds: z.array(z.string()).max(1000),
  classifiedIds: z.array(z.string()).max(1000),
  projects: z.array(project).max(1000),
  tagVocabulary: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
  tagChecks: z
    .array(
      z.object({
        recordId: z.string().min(1),
        tag: z.string().min(1).max(80),
        selected: z.boolean(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(1000000)
    .optional(),
  projectSuggestion: z
    .object({ name: z.string().min(1).max(80), purpose: z.string().max(500) })
    .optional(),
  summaries: z.array(z.string().max(2000)).max(1000),
  assignments: z.array(assignment).max(1000),
  unresolvedRecordIds: z.array(z.string()).max(1000),
  failedBatch: z
    .object({
      stage: z.enum(['discovery', 'classification', 'tagging']),
      recordIds: z.array(z.string().min(1)).min(1).max(1000),
      attempts: z.number().int().min(1).max(10),
      error: z.string().max(1000),
      failedAt: z.number().int().min(0),
    })
    .optional(),
});

/** Explicit owner skip retains the scope and failure evidence; no assignment is invented. */
export function skipFailedCollectionBatch(input: z.infer<typeof collectionAnalysisSchema>) {
  const failure = input.failedBatch;
  if (!failure) throw new Error('No failed saved batch is available to skip.');
  return collectionAnalysisSchema.parse({
    ...input,
    skippedTagRecordIds:
      failure.stage === 'tagging'
        ? [...new Set([...(input.skippedTagRecordIds || []), ...failure.recordIds])]
        : input.skippedTagRecordIds,
    skippedRecordIds:
      failure.stage !== 'tagging'
        ? [...new Set([...(input.skippedRecordIds || []), ...failure.recordIds])]
        : input.skippedRecordIds,
    discoveredIds:
      failure.stage === 'discovery'
        ? [...new Set([...input.discoveredIds, ...failure.recordIds])]
        : input.discoveredIds,
    summaries: [
      ...input.summaries,
      `Explicitly skipped ${failure.stage} batch (${failure.recordIds.length} tabs): ${failure.error}`,
    ],
    failedBatch: undefined,
    revision: input.revision + 1,
    updatedAt: Date.now(),
  });
}
