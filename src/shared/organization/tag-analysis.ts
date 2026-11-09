import { z } from 'zod';
import type { TabRecord } from '../types';

export const TAG_CONTRACT = 'bounded-tags-v2';
export const tagSupportSchema = z.object({
  name: z.string().trim().min(1).max(80),
  source: z.enum(['title', 'url', 'note', 'text']),
  quote: z.string().min(1).max(200),
});
export const tagAnalysisSchema = z.object({
  id: z.string().min(1).max(1000),
  analysisId: z.string().min(1).max(200),
  recordId: z.string().min(1),
  url: z.string(),
  navigationVersion: z.number().int().min(0),
  evidenceKey: z.string().length(64),
  catalogKey: z.string().length(64),
  contract: z.enum(['bounded-tags-v1', TAG_CONTRACT]),
  revision: z.number().int().min(1),
  updatedAt: z.number().int().min(0),
  cursor: z.number().int().min(0).max(1000),
  status: z.enum(['proposed', 'complete']),
  failure: z
    .object({
      attempts: z.number().int().min(1).max(10),
      error: z.string().max(1000),
      failedAt: z.number().int().min(0),
    })
    .optional(),
  proposalModel: z.string().max(300),
  tags: z.array(tagSupportSchema).max(6),
  newTags: z.array(tagSupportSchema).max(6),
  uncertain: z.boolean(),
  decisions: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        outcome: z.enum(['accepted', 'rejected', 'uncertain']),
        confidence: z.number().min(0).max(1).optional(),
        probability: z.number().min(0).max(1).optional(),
        model: z.string().max(300),
      }),
    )
    .max(6),
});
export type TagAnalysis = z.infer<typeof tagAnalysisSchema>;
export const tagReviewSchema = z
  .array(
    z.object({
      recordId: z.string().min(1),
      tags: z.array(
        z.object({
          name: z.string().trim().min(1).max(80),
          outcome: z.enum(['new', 'uncertain']),
        }),
      ),
    }),
  )
  .max(1000);
export type TagReview = z.infer<typeof tagReviewSchema>;
export interface TagStorage {
  analysisId: string;
  load: () => Promise<TagAnalysis[]>;
  save: (result: TagAnalysis) => Promise<void>;
}

export function tagEvidence(record: TabRecord) {
  const cached = record.content?.url === record.url ? record.content : undefined;
  return {
    title: record.title.slice(0, 500),
    url: record.url.slice(0, 2000),
    note: record.note.slice(0, 500),
    text: cached
      ? [cached.description, ...cached.headings, cached.text].join('\n').slice(0, 10000)
      : '',
    existingTags: record.tags,
  };
}
export async function tagHash(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
export const tagEvidenceKey = (record: TabRecord) =>
  tagHash({ ...tagEvidence(record), navigationVersion: record.navigationVersion });
export const tagResultId = (
  row: Pick<TagAnalysis, 'analysisId' | 'recordId' | 'evidenceKey' | 'catalogKey'>,
) => JSON.stringify([row.analysisId, row.recordId, row.evidenceKey, row.catalogKey]);
export function canonicalTags(tags: string[]) {
  return [...new Map(tags.map((name) => [name.trim().toLowerCase(), name.trim()])).values()].filter(
    Boolean,
  );
}

/** Order candidates by observed mentions without removing rare or multilingual possibilities. */
export function orderTagCandidates(catalog: string[], evidence: ReturnType<typeof tagEvidence>) {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const facts = normalize([evidence.title, evidence.url, evidence.note].join(' '));
  const words = new Set(facts.split(' '));
  const score = (name: string) => {
    const normalized = normalize(name);
    return (
      (normalized.length > 2 && ` ${facts} `.includes(` ${normalized} `) ? 100 : 0) +
      normalized.split(' ').filter((word) => word.length > 2 && words.has(word)).length
    );
  };
  return catalog
    .map((name, index) => ({ name, index, score: score(name) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.name);
}

/** Owner review changes a draft only; applying original tab metadata remains a separate action. */
export function resolveTagReview(
  draft: {
    tagReview?: TagReview;
    assignments: Array<{ recordId: string; suggestedTags?: string[] }>;
    unresolvedRecordIds: string[];
    unresolvedTagSuggestions?: Array<{
      recordId: string;
      url: string;
      navigationVersion: number;
      suggestedTags: string[];
    }>;
  },
  record: Pick<TabRecord, 'id' | 'url' | 'navigationVersion'>,
  name: string,
  include: boolean,
) {
  if (
    !draft.tagReview?.some(
      (item) => item.recordId === record.id && item.tags.some((tag) => tag.name === name),
    )
  ) {
    if (!include) {
      const target =
        draft.assignments.find((item) => item.recordId === record.id) ||
        draft.unresolvedTagSuggestions?.find((item) => item.recordId === record.id);
      if (target?.suggestedTags)
        target.suggestedTags = target.suggestedTags.filter(
          (tag) => tag.toLowerCase() !== name.toLowerCase(),
        );
    }
    return;
  }
  if (include) {
    let target =
      draft.assignments.find((item) => item.recordId === record.id) ||
      draft.unresolvedTagSuggestions?.find((item) => item.recordId === record.id);
    if (!target) {
      if (!draft.unresolvedRecordIds.includes(record.id))
        throw Error('The tag occurrence is no longer in this draft.');
      draft.unresolvedTagSuggestions ||= [];
      const independent = {
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        suggestedTags: [] as string[],
      };
      draft.unresolvedTagSuggestions.push(independent);
      target = independent;
    }
    const tags = canonicalTags([...(target.suggestedTags || []), name]);
    target.suggestedTags = tags;
  }
  draft.tagReview = draft.tagReview
    .map((item) =>
      item.recordId === record.id
        ? {
            ...item,
            tags: item.tags.filter((tag) => tag.name.toLowerCase() !== name.toLowerCase()),
          }
        : item,
    )
    .filter((item) => item.tags.length);
}
