import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeTags } from '../src/ai/workflows/tagging';
import { generateCollectionDraft } from '../src/ai/workflows/generation';
import {
  resolveTagReview,
  orderTagCandidates,
  tagEvidence,
  tagEvidenceKey,
  type TagAnalysis,
} from '../src/shared/organization/tag-analysis';
import { DEFAULTS, newRecord } from '../src/shared/model';
import type { AppState, CollectionAnalysis } from '../src/shared/types';

const page = {
  ...newRecord('https://github.com/fixture/app/pull/2'),
  id: 'one',
  title: 'App pull request',
  live: true,
};
const app: AppState = {
  records: [page],
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
    smallModel: 'chat',
    smallContextTokens: 32768,
    smallCompletionTokens: 2048,
    decisionModel: 'decision',
    decisionContextTokens: 4096,
    tagVerification: 'none',
  },
};
const reply = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
const proposal = {
  tags: [{ name: 'GitHub', source: 'url', quote: 'github.com' }],
  newTags: [],
  uncertain: false,
};
function store(analysisId = 'saved') {
  const rows = new Map<string, TagAnalysis>();
  return {
    rows,
    storage: {
      analysisId,
      load: async () => structuredClone([...rows.values()]),
      save: async (row: TagAnalysis) => {
        rows.set(row.id, structuredClone(row));
      },
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('independent resumable tagging', () => {
  it('verifies more than two novel labels and separates accepted, rejected and uncertain subjects', async () => {
    const facts = { ...page, title: 'Atlas TypeScript accessibility testing guide' };
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ++requests === 1
          ? reply({
              tags: [],
              newTags: [
                { name: 'TypeScript', source: 'title', quote: 'TypeScript' },
                { name: 'Accessibility', source: 'title', quote: 'accessibility' },
                { name: 'Testing', source: 'title', quote: 'testing' },
                { name: 'Reference', source: 'title', quote: 'guide' },
              ],
              uncertain: false,
            })
          : reply({
              TypeScript: 'accepted',
              Accessibility: 'accepted',
              Testing: 'uncertain',
              Reference: 'rejected',
            }),
      ),
    );
    const result = await analyzeTags(
      { ...app, settings: { ...app.settings, tagVerification: 'chat' } },
      [facts],
      [],
      { vocabulary: [] },
    );
    expect(requests).toBe(2);
    expect(result.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual([
      'TypeScript',
      'Accessibility',
    ]);
    expect(result.tagReview?.[0]?.tags).toEqual([{ name: 'Testing', outcome: 'uncertain' }]);
  });
  it('retains good tabs after an earlier failure, skips failed tabs explicitly and retries them without replaying completed work', async () => {
    const { rows, storage } = store();
    const other = { ...page, id: 'other', title: 'Other pull request' };
    let failing = true;
    const provider = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const title = JSON.parse(body.messages[1].content).page.title;
      return reply(
        failing && title === page.title
          ? { ...proposal, tags: [{ name: 'GitHub', source: 'title', quote: 'missing quote' }] }
          : proposal,
      );
    });
    vi.stubGlobal('fetch', provider);
    const failure = vi.fn();
    const fixture = { ...app, settings: { ...app.settings, aiMaxAttempts: 2 } };
    await expect(
      analyzeTags(fixture, [page, other], [], {
        vocabulary: ['GitHub'],
        storage,
        onFailure: failure,
      }),
    ).rejects.toThrow('1 tabs completed; 1 failed after 2 attempts');
    expect(provider).toHaveBeenCalledTimes(3);
    expect([...rows.values()].find((row) => row.recordId === other.id)?.status).toBe('complete');
    expect([...rows.values()].find((row) => row.recordId === page.id)?.failure?.attempts).toBe(2);
    expect(failure).toHaveBeenLastCalledWith(expect.objectContaining({ recordIds: [page.id] }));
    const skipped = await analyzeTags(fixture, [page, other], [], {
      vocabulary: ['GitHub'],
      storage,
      skipRecordIds: [page.id],
    });
    expect(provider).toHaveBeenCalledTimes(3);
    expect(skipped.decisions.map((item) => item.recordId)).toEqual([other.id]);
    failing = false;
    const retried = await analyzeTags(fixture, [page, other], [], {
      vocabulary: ['GitHub'],
      storage,
    });
    expect(provider).toHaveBeenCalledTimes(4);
    expect(retried.decisions).toHaveLength(2);
    expect([...rows.values()].find((row) => row.recordId === page.id)?.failure).toBeUndefined();
  });
  it('stops on authentication errors instead of consuming retries or skipping every tab', async () => {
    const provider = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', provider);
    await expect(
      analyzeTags(app, [page, { ...page, id: 'two' }], [], { vocabulary: [] }),
    ).rejects.toThrow('401');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('uses one chat proposal instead of 300 tag decisions', async () => {
    const provider = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.messages[0].content).not.toMatch(/at most two|for separate owner review/);
      expect(request.response_format.json_schema.schema.properties.newTags.maxItems).toBe(6);
      return reply(proposal);
    });
    vi.stubGlobal('fetch', provider);
    const receipt = vi.fn(async () => undefined);
    const result = await analyzeTags(app, [page], [], {
      onReceipt: receipt,
      vocabulary: ['GitHub', ...Array.from({ length: 299 }, (_, i) => `Topic ${i}`)],
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith(
      expect.objectContaining({ contract: 'bounded-tags-v2', stage: 'tagging' }),
    );
    expect(result.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual(['GitHub']);
  });
  it('saves before verification, retries six times and resumes a failed verdict with another model', async () => {
    const { rows, storage } = store();
    let fail = true,
      proposals = 0,
      judgments = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.messages) {
          proposals++;
          return reply(proposal);
        }
        judgments++;
        return new Response(
          JSON.stringify({
            model: 'decision',
            answers: fail
              ? {}
              : {
                  tag_0: {
                    type: 'choice',
                    choice: 'yes',
                    probabilities: { yes: 0.7, no: 0.3 },
                    confidence: 0.4,
                  },
                },
            usage: { input_tokens: 10, output_tokens: 0 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const fixture = { ...app, settings: { ...app.settings, tagVerification: 'decision' as const } };
    await expect(
      analyzeTags(fixture, [page], [], { vocabulary: ['GitHub'], storage }),
    ).rejects.toThrow('6 attempts');
    expect(proposals).toBe(1);
    expect(judgments).toBe(6);
    expect([...rows.values()][0]?.status).toBe('proposed');
    fail = false;
    const result = await analyzeTags(
      { ...fixture, settings: { ...fixture.settings, decisionModel: 'replacement' } },
      [page],
      [],
      { vocabulary: ['GitHub'], storage },
    );
    expect(proposals).toBe(1);
    expect([...rows.values()][0]?.decisions[0]?.outcome).toBe('uncertain');
    expect(result.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual([]);
    expect(result.tagReview?.[0]?.tags[0]?.name).toBe('GitHub');
  });
  it('keeps committed proposals across a chat model change', async () => {
    const { storage } = store('switch');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(proposal)),
    );
    await analyzeTags(app, [page], [], { vocabulary: ['GitHub'], storage });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Error('Completed proposal must not repeat');
      }),
    );
    const result = await analyzeTags(
      { ...app, settings: { ...app.settings, smallModel: 'another' } },
      [page],
      [],
      { vocabulary: ['GitHub'], storage },
    );
    expect(result.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual(['GitHub']);
  });
  it('fingerprints facts independently of focus, placement and sleeping state', async () => {
    expect(await tagEvidenceKey(page)).toBe(
      await tagEvidenceKey({
        ...page,
        active: true,
        suspended: true,
        groupId: 4,
        lastAccessed: Date.now(),
        favicon: 'changed',
      }),
    );
    expect(await tagEvidenceKey(page)).not.toBe(
      await tagEvidenceKey({ ...page, title: 'Different subject' }),
    );
  });
  it('rejects invented labels and evidence and keeps supported novel labels in the draft', async () => {
    const provider = vi.fn(async () =>
      reply({ ...proposal, tags: [{ name: 'Imaginary', source: 'title', quote: 'not here' }] }),
    );
    vi.stubGlobal('fetch', provider);
    await expect(analyzeTags(app, [page], [], { vocabulary: ['GitHub'] })).rejects.toThrow(
      '6 attempts',
    );
    expect(provider).toHaveBeenCalledTimes(6);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({
          tags: [],
          newTags: [{ name: 'Code review', source: 'title', quote: 'pull request' }],
          uncertain: false,
        }),
      ),
    );
    const result = await analyzeTags(app, [page], [], { vocabulary: ['GitHub'] });
    expect(result.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual(['Code review']);
    expect(result.tagReview).toEqual([]);
  });
  it.each([333, 600])(
    'persists %i duplicate occurrences and resumes without repeated requests',
    async (count) => {
      const { rows, storage } = store('large');
      const pages = Array.from({ length: count }, (_, i) => ({ ...page, id: `occurrence-${i}` }));
      const provider = vi.fn(async () => reply(proposal));
      vi.stubGlobal('fetch', provider);
      const options = {
        vocabulary: ['GitHub', ...Array.from({ length: 299 }, (_, i) => `Unrelated topic ${i}`)],
        storage,
      };
      expect((await analyzeTags(app, pages, [], options)).unresolvedTagSuggestions).toHaveLength(
        count,
      );
      expect(rows.size).toBe(count);
      expect(provider).toHaveBeenCalledTimes(count);
      await analyzeTags(app, pages, [], options);
      expect(provider).toHaveBeenCalledTimes(count);
      await analyzeTags(app, [{ ...pages[0]!, title: 'Changed subject' }], [], options);
      expect(provider).toHaveBeenCalledTimes(count + 1);
      expect(rows.size).toBe(count + 1);
    },
  );
  it('reviewing a novel label changes the draft and leaves original owner tags alone', () => {
    const draft = {
      assignments: [],
      unresolvedRecordIds: [page.id],
      tagReview: [{ recordId: page.id, tags: [{ name: 'Code review', outcome: 'new' as const }] }],
      unresolvedTagSuggestions: [] as Array<{
        recordId: string;
        url: string;
        navigationVersion: number;
        suggestedTags: string[];
      }>,
    };
    resolveTagReview(draft, page, 'Code review', true);
    expect(draft.unresolvedTagSuggestions[0]?.suggestedTags).toEqual(['Code review']);
    expect(page.tags).toEqual([]);
    expect(draft.tagReview).toEqual([]);
  });
  it('persists context-limited catalog segments and retries only an unfinished segment', async () => {
    const { rows, storage } = store('segments');
    let fail = true,
      calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (fail && rows.size) return reply({ tags: 'malformed' });
        return reply(proposal);
      }),
    );
    const fixture = {
      ...app,
      settings: { ...app.settings, smallContextTokens: 8192, smallCompletionTokens: 1024 },
    };
    const options = {
      vocabulary: [
        'GitHub',
        ...Array.from(
          { length: 999 },
          (_, i) => `Long irrelevant candidate label ${i} and descriptive topic`,
        ),
      ],
      storage,
    };
    await expect(analyzeTags(fixture, [page], [], options)).rejects.toThrow('6 attempts');
    const before = [...rows.values()][0]!;
    expect(before.cursor).toBeGreaterThan(0);
    expect(before.cursor).toBeLessThan(1000);
    expect(calls).toBe(7);
    fail = false;
    const result = await analyzeTags(fixture, [page], [], options);
    expect([...rows.values()][0]?.cursor).toBe(1000);
    expect(result.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual(['GitHub']);
    expect(before.cursor).toBeLessThan(1000);
  });
  it('continues an explicitly requested tag stage without any category or discovery model', async () => {
    let checkpoint: CollectionAnalysis = {
      id: 'old-run',
      taggingRequested: true,
      decisionContract: 'isolated-evidence-v2',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      purpose: 'proposal',
      instruction: '',
      reuseAcceptedTaxonomyOnly: true,
      scope: [{ id: page.id, url: page.url, navigationVersion: page.navigationVersion }],
      discoveredIds: [page.id],
      classifiedIds: [page.id],
      projects: [
        {
          name: 'App',
          purpose: 'Maintain App',
          areaName: 'Software',
          categories: [{ name: 'Reviews', description: 'Pull request reviews' }],
        },
      ],
      tagVocabulary: ['GitHub'],
      tagChecks: [{ recordId: page.id, tag: 'GitHub', selected: true, confidence: 0.9 }],
      summaries: [],
      assignments: [
        {
          recordId: page.id,
          url: page.url,
          navigationVersion: page.navigationVersion,
          projectName: 'App',
          categoryName: 'Reviews',
          reason: 'Saved category',
          confidence: 0.9,
        },
      ],
      unresolvedRecordIds: [],
    };
    const before = structuredClone(checkpoint);
    const { storage } = store('old-run');
    const provider = vi.fn(async () => reply(proposal));
    vi.stubGlobal('fetch', provider);
    const fixture = {
      ...app,
      settings: {
        ...app.settings,
        useDedicatedDecisionModel: true,
        decisionModel: '',
        decisionContextTokens: 0,
        aiModel: '',
        aiContextTokens: 0,
      },
    };
    const draft = await generateCollectionDraft(fixture, {
      reuseAcceptedTaxonomyOnly: true,
      checkpoint: {
        id: 'old-run',
        load: async () => checkpoint,
        save: async (value) => (checkpoint = structuredClone(value)),
        tags: storage,
      },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(draft.assignments[0]).toMatchObject({
      categoryName: 'Reviews',
      suggestedTags: ['GitHub'],
    });
    expect(checkpoint).toEqual(before);
  });
  it('persists chat uncertainty without inventing a confidence score', async () => {
    const { rows, storage } = store('chat-verifier');
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requests++;
        return requests === 1 ? reply(proposal) : reply({ GitHub: 'uncertain' });
      }),
    );
    const result = await analyzeTags(
      { ...app, settings: { ...app.settings, tagVerification: 'chat' } },
      [page],
      [],
      { vocabulary: ['GitHub'], storage },
    );
    expect(requests).toBe(2);
    expect([...rows.values()][0]?.decisions[0]).toMatchObject({
      name: 'GitHub',
      outcome: 'uncertain',
    });
    expect([...rows.values()][0]?.decisions[0]?.confidence).toBeUndefined();
    expect(result.unresolvedTagSuggestions?.[0]?.suggestedTags).toEqual([]);
    expect(result.tagReview?.[0]?.tags[0]?.outcome).toBe('uncertain');
  });
  it('derives the actual field for a literal quote and strips only an exactly matching quotation wrapper', async () => {
    const { rows, storage } = store('attribution');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({ ...proposal, tags: [{ name: 'GitHub', source: 'text', quote: '"github.com"' }] }),
      ),
    );
    await analyzeTags(app, [page], [], { vocabulary: ['GitHub'], storage });
    expect([...rows.values()][0]?.tags[0]).toMatchObject({ source: 'url', quote: 'github.com' });
  });
  it('prioritizes observed mentions while preserving all catalog choices', () => {
    const catalog = ['Botany', 'Generic topic', 'GitHub', 'App pull request', '\u6307\u7d0b'];
    const ordered = orderTagCandidates(catalog, tagEvidence(page));
    expect(ordered[0]).toBe('App pull request');
    expect(new Set(ordered)).toEqual(new Set(catalog));
    expect(ordered.indexOf('GitHub')).toBeLessThan(ordered.indexOf('Botany'));
  });
});
