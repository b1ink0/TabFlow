import { stubFetch } from './taxonomy-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateCollectionDraft } from '../src/ai/client';
import { recordInference, ReceiptPersistenceError } from '../src/ai/inference-receipt';
import { DEFAULTS, newRecord } from '../src/shared/model';
import {
  classificationEvidence,
  categoryChoices,
  CLASSIFICATION_CONTRACT,
} from '../src/ai/classification';
import { collectionAnalysisSchema } from '../src/shared/collection-analysis';
import type { AppState, CollectionAnalysis } from '../src/shared/types';
const record = {
  ...newRecord('https://github.com/fixture/cedar-notes'),
  id: 'one',
  title: 'Cedar Notes source repository',
  live: true,
};
const app: AppState = {
  records: [record],
  windows: [],
  groups: [],
  projects: [],
  categories: [],
  areas: [],
  memberships: [],
  workItems: [],
  proposals: [],
  collectionProposals: [],
  organizationJobs: [],
  snapshots: [],
  operations: [],
  jobs: [],
  version: 'test',
  settings: {
    ...DEFAULTS,
    aiMaxAttempts: 3,
    aiModel: 'discovery',
    smallModel: 'small',
    aiContextTokens: 32768,
    smallContextTokens: 32768,
    decisionContextTokens: 32768,
    useDedicatedDecisionModel: true,
    decisionModel: 'decision',
    decisionBase: 'http://127.0.0.1:8080',
  },
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const chat = (value: unknown) =>
  response({ choices: [{ message: { content: JSON.stringify(value) } }] });
afterEach(() => vi.unstubAllGlobals());
describe('grounded classification contract', () => {
  it('persists transport receipts separately and stops on storage failure without repeating inference', async () => {
    const write = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ answers: {} }));
    await recordInference(write, 'model', 'tagging', { state: 'observed facts' }, run);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'tagging',
        outcome: 'responded',
        request: '{"state":"observed facts"}',
        response: '{"answers":{}}',
      }),
    );
    write.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(recordInference(write, 'model', 'tagging', {}, run)).rejects.toBeInstanceOf(
      ReceiptPersistenceError,
    );
    expect(run).toHaveBeenCalledTimes(2);
    const failed = vi.fn(async () => {
      throw new Error('Unavailable');
    });
    await expect(recordInference(write, 'model', 'classification', {}, failed)).rejects.toThrow(
      'Unavailable',
    );
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'failed', error: 'Unavailable' }),
    );
  });
  it('keeps candidate labels out of facts and retains original metadata and category meaning', () => {
    const evidence = classificationEvidence(app, {
      ...record,
      tags: ['owner-tag'],
      note: 'Use this for Cedar Notes',
      suspended: true,
    });
    expect(evidence.tags).toEqual(['owner-tag']);
    expect(evidence.note).toBe('Use this for Cedar Notes');
    expect(evidence.url).toBe(record.url);
    expect(
      categoryChoices([
        {
          name: 'Cedar Notes',
          purpose: 'Assistive desktop application',
          areaName: 'Software',
          categories: [
            {
              name: 'Documentation',
              description: 'Reading API reference, not implementation code',
            },
          ],
        },
      ])[0]?.description,
    ).toContain('Reading API reference');
  });
  it.each(['transport', 'duplicate', 'corrected', 'distinct', 'storage'] as const)(
    'resumes reconciliation after %s without repeating discovery or completed sources',
    async (failureMode) => {
      const second = {
        ...record,
        id: 'two',
        title: 'Cedar Notes API reference',
        url: 'https://docs.fixture.test/cedar-notes',
      };
      let checkpoint: CollectionAnalysis | undefined,
        fail = true,
        discoveryCalls = 0,
        normalizations = 0,
        selectionCalls = 0;
      const provider = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = z
          .object({
            state: z.string().optional(),
            questions: z
              .record(
                z.string(),
                z.object({ instructions: z.string(), criteria: z.record(z.string(), z.string()) }),
              )
              .optional(),
            messages: z.array(z.object({ content: z.string() })).optional(),
            response_format: z.object({ json_schema: z.object({ name: z.string() }) }).optional(),
          })
          .parse(JSON.parse(String(init?.body)));
        if (request.questions) {
          expect(checkpoint?.taxonomyProgress?.cursor).toBe(2);
          expect(Object.keys(request.questions)).toHaveLength(1);
          expect(request.questions.tab_0?.criteria.c0).toContain('Source code');
          return response({
            model: 'decision',
            answers: {
              tab_0: {
                type: 'choice',
                choice: 'c0',
                confidence: 0.99,
                probabilities: { c0: 0.99, keep: 0.01 },
              },
            },
            usage: { input_tokens: 10, output_tokens: 0 },
          });
        }
        const data = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(request.messages?.at(-1)?.content || '{}'));
        if (request.response_format?.json_schema.name !== 'taxonomy_reconciliation') {
          discoveryCalls++;
          return chat({
            summary: 'Batch-local observations',
            projects: [
              {
                name: 'Cedar Notes local development',
                purpose: 'Build Cedar Notes',
                areaName: 'Software',
                categories: [{ name: 'Code', description: 'Source code' }],
              },
              {
                name: 'Software Development: Cedar Notes',
                purpose: 'Maintain Cedar Notes',
                areaName: 'Software',
                categories: [{ name: 'Implementation', description: 'Source code' }],
              },
            ],
          });
        }
        if (data.activity) {
          const source = z.object({ name: z.string() }).parse(data.activity);
          if (source.name === 'Software Development: Cedar Notes') {
            selectionCalls++;
            if (
              fail &&
              (failureMode === 'transport' || (failureMode === 'storage' && selectionCalls <= 3))
            )
              throw Error('Synthetic reconciliation interruption');
            if (failureMode !== 'transport' && failureMode !== 'storage' && fail) {
              if (selectionCalls > 1) {
                expect(request.messages?.at(-1)?.content).toContain('If it is a distinct goal');
                expect(request.messages?.at(-1)?.content).toContain(
                  'Software Development: Cedar Notes',
                );
              }
              if (failureMode === 'duplicate' || selectionCalls === 1)
                return chat({
                  existingProjectName: null,
                  reason: 'Contradictory new name',
                  name: ' cEdAr nOtEs ',
                  purpose: 'Different or same goal must be resolved explicitly',
                  areaName: 'Software',
                });
            }
          }
          return chat({
            existingProjectName:
              source.name === 'Cedar Notes local development' || failureMode === 'distinct'
                ? null
                : 'Cedar Notes',
            reason: 'Same application goal',
            name:
              source.name === 'Cedar Notes local development'
                ? 'Cedar Notes'
                : failureMode === 'distinct'
                  ? 'Distinct application'
                  : 'Alternate unused name',
            purpose: 'Build and maintain Cedar Notes',
            areaName: 'Software',
          });
        }
        normalizations++;
        const categories = z.array(z.object({ name: z.string() })).parse(data.sourceCategories);
        return chat({
          mappings: categories.map((item) => ({
            source: item.name,
            name: 'Implementation',
            description: 'Source code repositories and implementation',
          })),
        });
      });
      stubFetch('fetch', provider, { taxonomy: false });
      const options = {
        checkpoint: {
          id: 'taxonomy',
          load: async () => checkpoint,
          save: async (value: CollectionAnalysis) => {
            if (failureMode === 'storage' && fail && value.taxonomyProgress?.cursor === 2)
              throw Error('Synthetic checkpoint write failure');
            checkpoint = collectionAnalysisSchema.parse(value);
            return checkpoint;
          },
        },
      };
      if (failureMode === 'corrected' || failureMode === 'distinct') {
        const draft = await generateCollectionDraft({ ...app, records: [record, second] }, options);
        expect(selectionCalls).toBe(2);
        expect(discoveryCalls).toBe(1);
        expect(draft.projects).toHaveLength(failureMode === 'distinct' ? 2 : 1);
        expect(draft.projects[0]?.name).toBe('Cedar Notes');
        expect(draft.projects[0]?.purpose).toBe('Build and maintain Cedar Notes');
        return;
      }
      await expect(
        generateCollectionDraft({ ...app, records: [record, second] }, options),
      ).rejects.toThrow('reconciliation failed');
      expect(selectionCalls).toBe(3);
      expect(checkpoint?.taxonomyProgress?.cursor).toBe(1);
      expect(discoveryCalls).toBe(1);
      expect(normalizations).toBe(1);
      if (failureMode === 'storage') {
        const loadedProgress = checkpoint?.taxonomyProgress;
        const committed = structuredClone(loadedProgress);
        await expect(
          generateCollectionDraft({ ...app, records: [record, second] }, options),
        ).rejects.toThrow('checkpoint write failure');
        expect(loadedProgress).toEqual(committed);
        expect(checkpoint?.taxonomyProgress?.cursor).toBe(1);
        expect(discoveryCalls).toBe(1);
      }
      fail = false;
      const draft = await generateCollectionDraft({ ...app, records: [record, second] }, options);
      expect(discoveryCalls).toBe(1);
      expect(normalizations).toBe(failureMode === 'storage' ? 3 : 2);
      expect(draft.projects).toHaveLength(1);
      expect(draft.projects[0]?.name).toBe('Cedar Notes');
      expect(draft.assignments).toHaveLength(2);
      expect(draft.summary).not.toContain('Batch-local');
    },
  );
  it('refuses silent reuse of legacy decisions without deleting their checkpoint', async () => {
    const legacy: CollectionAnalysis = {
      id: 'legacy',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: '',
      reuseAcceptedTaxonomyOnly: true,
      scope: [{ id: record.id, url: record.url, navigationVersion: 0 }],
      discoveredIds: [record.id],
      classifiedIds: [record.id],
      projects: [],
      summaries: [],
      assignments: [],
      unresolvedRecordIds: [record.id],
    };
    const save = vi.fn();
    await expect(
      generateCollectionDraft(app, {
        reuseAcceptedTaxonomyOnly: true,
        checkpoint: { id: legacy.id, load: async () => legacy, save },
      }),
    ).rejects.toThrow('legacy classification format');
    expect(save).not.toHaveBeenCalled();
    expect(legacy.classifiedIds).toEqual([record.id]);
  });
  it.each(['decision', 'small'] as const)(
    'persists a bounded %s project selection before a category failure and resumes it under a model switch',
    async (role) => {
      const projects = Array.from({ length: 12 }, (_, i) => ({
        name: `Product ${i}`,
        purpose: `Product ${i}`,
        areaName: 'Work',
        categories: Array.from({ length: 5 }, (_, c) => ({
          name: `Category ${c}`,
          description: 'A documented category '.repeat(6),
        })),
      }));
      let checkpoint: CollectionAnalysis | undefined,
        projectCalls = 0,
        fail = true;
      stubFetch(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body)));
          if (body.messages) {
            const format = z
              .object({ json_schema: z.object({ name: z.string() }) })
              .parse(body.response_format);
            if (format.json_schema.name === 'tabflow_project_choice') {
              projectCalls++;
              return chat({ choice: 'p0', confidence: 0.99 });
            }
            if (fail) return chat({ assignments: [] });
            const messages = z.array(z.object({ content: z.string() })).parse(body.messages);
            const payload = z
              .object({ choices: z.record(z.string(), z.string()) })
              .parse(JSON.parse(messages.at(-1)!.content));
            expect(Object.keys(payload.choices)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'keep']);
            return chat({
              assignments: [
                {
                  recordId: record.id,
                  choice: 'c0',
                  confidence: 0.99,
                  reason: 'Project-specific category definition',
                },
              ],
            });
          }
          const request = z
            .object({ questions: z.record(z.string(), z.object({ instructions: z.string() })) })
            .parse(JSON.parse(String(init?.body)));
          if (request.questions.project) {
            projectCalls++;
            return response({
              model: 'decision',
              answers: {
                project: {
                  type: 'choice',
                  choice: 'p0',
                  confidence: 0.99,
                  probabilities: { p0: 0.99, keep: 0.01 },
                },
              },
              usage: { input_tokens: 10, output_tokens: 0 },
            });
          }
          return response({
            model: 'decision',
            answers: fail
              ? {}
              : {
                  tab_0: {
                    type: 'choice',
                    choice: 'c0',
                    confidence: 0.99,
                    probabilities: { c0: 0.99, keep: 0.01 },
                  },
                },
            usage: { input_tokens: 10, output_tokens: 0 },
          });
        }),
      );
      const options = {
        reuseAcceptedTaxonomyOnly: true,
        seedProjects: projects,
        checkpoint: {
          id: 'routed',
          load: async () => checkpoint,
          save: async (value: CollectionAnalysis) => {
            checkpoint = collectionAnalysisSchema.parse(value);
            return checkpoint;
          },
        },
      };
      const fixture = {
        ...app,
        settings: {
          ...app.settings,
          useDedicatedDecisionModel: role === 'decision',
          decisionContextTokens: 4096,
          smallContextTokens: 12288,
          smallCompletionTokens: 1024,
        },
      };
      await expect(generateCollectionDraft(fixture, options)).rejects.toThrow(
        'failed after 3 attempts',
      );
      expect(checkpoint?.projectChecks?.[0]?.projectName).toBe('Product 0');
      fail = false;
      const draft = await generateCollectionDraft(
        {
          ...fixture,
          settings: {
            ...fixture.settings,
            decisionModel: 'replacement',
            smallModel: 'replacement-small',
          },
        },
        options,
      );
      expect(projectCalls).toBe(1);
      expect(draft.assignments).toHaveLength(1);
      expect(checkpoint?.decisionContract).toBe(CLASSIFICATION_CONTRACT);
    },
  );
});
