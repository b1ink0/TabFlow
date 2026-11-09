import { tagReviewSchema } from './tag-analysis';
import { z } from 'zod';
import { validateCollectionDraft } from '../model';
import type { CollectionDraft, CollectionProposal, TabRecord, Membership } from '../types';

export const PROPOSAL_PAGE_SIZE = 30;
export function safeProposalTitle(title: string): string {
  return /^https?:\/\//i.test(title) ? safeProposalUrl(title) : title;
}

export function safeProposalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return url.origin;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[unavailable URL]';
  }
}

export function proposalExport(
  proposal: Pick<CollectionProposal, 'id' | 'createdAt'>,
  draft: CollectionDraft,
  records: readonly TabRecord[],
) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const details = (recordId: string) => {
    const record = byId.get(recordId);
    return {
      occurrenceId: recordId,
      title: record ? safeProposalTitle(record.title) : 'Tab unavailable',
      url: safeProposalUrl(record?.url || ''),
      tags: record?.tags || [],
      navigationVersion: record?.navigationVersion,
    };
  };
  return {
    format: 'tabflow-collection-proposal',
    version: 1,
    scope: {
      kind: 'selection',
      label: 'Exported review draft',
      occurrenceCount: draft.assignments.length + draft.unresolvedRecordIds.length,
      occurrenceIds: [
        ...draft.assignments.map((item) => item.recordId),
        ...draft.unresolvedRecordIds,
      ],
    },
    proposalId: proposal.id,
    createdAt: proposal.createdAt,
    exportedAt: new Date().toISOString(),
    urlPolicy: 'URL query, fragment and credentials removed',
    excludedRecordIds: draft.excludedRecordIds,
    summary: draft.summary,
    name: draft.name,
    decisionContract: draft.decisionContract,
    tagReview: draft.tagReview,
    legacyCategoriesRetained: draft.legacyCategoriesRetained,
    projects: draft.projects,
    assignments: draft.assignments.map((item) => ({
      ...details(item.recordId),
      projectName: item.projectName,
      categoryName: item.categoryName,
      reason: item.reason,
      confidence: item.confidence,
      suggestedTags: item.suggestedTags,
    })),
    unresolved: draft.unresolvedRecordIds.map((id) => ({
      ...details(id),
      suggestedTags: draft.unresolvedTagSuggestions?.find((item) => item.recordId === id)
        ?.suggestedTags,
    })),
  };
}

const importedOccurrence = z.object({
  occurrenceId: z.string().min(1).max(200),
  title: z.string().max(2000),
  url: z.string(),
  navigationVersion: z.number().int().nonnegative().optional(),
});
const importedProposal = z.object({
  excludedRecordIds: z.array(z.string().min(1)).max(1000).optional(),
  tagReview: tagReviewSchema.optional(),
  decisionContract: z.string().max(80).optional(),
  legacyCategoriesRetained: z.boolean().optional(),
  format: z.literal('tabflow-collection-proposal'),
  version: z.literal(1),
  scope: z
    .object({
      kind: z.enum(['all', 'window', 'project', 'selection']),
      label: z.string().max(300),
      occurrenceCount: z.number().int().min(1).max(1000),
      occurrenceIds: z.array(z.string().min(1).max(200)).min(1).max(1000),
    })
    .optional(),
  summary: z.string().max(2000),
  name: z.string().trim().max(120).optional(),
  projects: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        purpose: z.string().max(500),
        areaName: z.string().trim().min(1).max(80).nullable(),
        categories: z
          .array(
            z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300) }),
          )
          .max(1000),
      }),
    )
    .max(1000),
  assignments: z
    .array(
      importedOccurrence.extend({
        projectName: z.string().trim().min(1).max(80),
        categoryName: z.string().trim().min(1).max(80),
        reason: z.string().max(300),
        confidence: z.number().min(0).max(1),
        suggestedTags: z.array(z.string().trim().min(1).max(80)).optional(),
      }),
    )
    .max(1000),
  unresolved: z
    .array(
      importedOccurrence.extend({
        suggestedTags: z.array(z.string().trim().min(1).max(80)).optional(),
      }),
    )
    .max(1000),
});

/** Import only stable occurrences; sanitized URLs are never used to guess duplicate identities. */
export function proposalImport(
  input: unknown,
  records: readonly TabRecord[],
  memberships: readonly Membership[],
) {
  const parsed = importedProposal.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid proposal at ${issue?.path.join('.') || 'file'}: ${issue?.message || 'unsupported format'}`,
    );
  }
  const source = parsed.data;
  const occurrences = [...source.assignments, ...source.unresolved];
  if (new Set(occurrences.map((item) => item.occurrenceId)).size !== occurrences.length)
    throw new Error('The imported proposal repeats a tab occurrence.');
  if (source.scope) {
    const ids = new Set(source.scope.occurrenceIds);
    if (
      ids.size !== source.scope.occurrenceIds.length ||
      ids.size !== source.scope.occurrenceCount ||
      occurrences.length !== ids.size ||
      occurrences.some((item) => !ids.has(item.occurrenceId))
    )
      throw new Error(
        'The response does not cover its exported scope exactly. Ask the external AI to return every exported occurrence once, with the original scope unchanged.',
      );
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const owners = new Set(
    memberships
      .filter((membership) => membership.source === 'owner')
      .map((membership) => membership.recordId),
  );
  const skipped: Array<{ id: string; title: string; reason: string }> = [];
  const retained = new Map<string, TabRecord>();
  for (const item of occurrences) {
    const record = byId.get(item.occurrenceId);
    const reason = !record?.live
      ? 'Not currently open'
      : record.locked
        ? 'Protected'
        : owners.has(record.id)
          ? 'Owner assignment retained'
          : safeProposalUrl(record.url) !== item.url
            ? 'Address changed'
            : item.navigationVersion !== undefined &&
                item.navigationVersion !== record.navigationVersion
              ? 'Page navigated since export'
              : '';
    if (reason) skipped.push({ id: item.occurrenceId, title: item.title, reason });
    else retained.set(item.occurrenceId, record!);
  }
  if (!retained.size)
    throw new Error(
      'No eligible matching tab occurrences. Import this draft in the original TabFlow profile with its tabs still open.',
    );
  const draft = validateCollectionDraft(
    {
      summary: source.summary,
      name: source.name,
      decisionContract: source.decisionContract,
      tagReview: source.tagReview?.filter((item) => retained.has(item.recordId)),
      legacyCategoriesRetained: source.legacyCategoriesRetained,
      projects: source.projects,
      model: 'Imported review draft',
      scopeRecordIds: [...retained.keys()],
      excludedRecordIds: source.excludedRecordIds?.filter((id) => retained.has(id)),
      assignments: source.assignments
        .filter((item) => retained.has(item.occurrenceId))
        .map((item) => {
          const record = retained.get(item.occurrenceId)!;
          return {
            recordId: record.id,
            url: record.url,
            navigationVersion: record.navigationVersion,
            projectName: item.projectName,
            categoryName: item.categoryName,
            reason: item.reason,
            confidence: item.confidence,
            suggestedTags: item.suggestedTags,
          };
        }),
      unresolvedRecordIds: source.unresolved
        .filter((item) => retained.has(item.occurrenceId))
        .map((item) => item.occurrenceId),
      unresolvedTagSuggestions: source.unresolved
        .filter((item) => retained.has(item.occurrenceId) && item.suggestedTags?.length)
        .map((item) => {
          const record = retained.get(item.occurrenceId)!;
          return {
            recordId: record.id,
            url: record.url,
            navigationVersion: record.navigationVersion,
            suggestedTags: item.suggestedTags || [],
          };
        }),
    },
    new Set(retained.keys()),
  );
  return {
    draft,
    sourceScope: source.scope
      ? { label: source.scope.label, count: source.scope.occurrenceCount }
      : undefined,
    skipped,
    total: occurrences.length,
    legacyAddressChecks: occurrences.some((item) => item.navigationVersion === undefined),
  };
}
