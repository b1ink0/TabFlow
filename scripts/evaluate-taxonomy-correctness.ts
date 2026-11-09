// Explicit opt-in; production reconciliation with synthetic evidence and no browser access.
import { writeFileSync } from 'node:fs';
import { generateCollectionDraft } from '../src/ai/workflows/generation';
import { DEFAULTS, newRecord } from '../src/shared/model';
import { collectionAnalysisSchema } from '../src/shared/organization/collection-analysis';
import { CLASSIFICATION_CONTRACT } from '../src/ai/workflows/classification';
import type { AppState, CollectionAnalysis, CollectionDraft } from '../src/shared/types';
const base = process.env.TABFLOW_CHAT_URL,
  model = process.env.TABFLOW_CHAT_MODEL;
const context = Number(process.env.TABFLOW_CHAT_CONTEXT);
const decisionBase = process.env.TABFLOW_DECISION_URL,
  decisionModel = process.env.TABFLOW_DECISION_MODEL;
const decisionContext = Number(process.env.TABFLOW_DECISION_CONTEXT);
if (!base || !model || !context || !decisionBase || !decisionModel || !decisionContext)
  throw new Error(
    'Supply explicit generative and decision endpoints, model IDs and request context envelopes.',
  );
const data = [
  ['OrbitAssist source repository', 'https://github.com/fixture/orbitassist'],
  ['OrbitAssist releases', 'https://github.com/fixture/orbitassist/releases'],
  ['Read garden care guides on Field Notes', 'https://garden.example.test/care/guide'],
  ['Seasonal planting schedule', 'https://schedule.example.test/'],
];
const records = data.map(([title, url], index) => ({
  ...newRecord(url!),
  id: `taxonomy-gold-${index}`,
  title: title!,
  live: true,
  suspended: true,
}));
const raw: CollectionDraft['projects'] = [
  {
    name: 'OrbitAssist Development',
    purpose: 'Develop OrbitAssist desktop assistant',
    areaName: 'Software',
    categories: [{ name: 'Source code', description: 'Source repository for OrbitAssist' }],
  },
  {
    name: 'OrbitAssist Release Tracking',
    purpose: 'Maintain releases of the same OrbitAssist desktop assistant',
    areaName: 'Software',
    categories: [{ name: 'Releases', description: 'Version releases and changelogs' }],
  },
  {
    name: 'Garden Guides',
    purpose: 'Read garden care guides',
    areaName: 'Community garden',
    categories: [{ name: 'Guides', description: 'Reference articles about plant care' }],
  },
  {
    name: 'Garden Planning',
    purpose: 'Plan planting dates and seasonal tasks',
    areaName: 'Community garden',
    categories: [{ name: 'Schedules', description: 'Botany seasonal planting timetables' }],
  },
];
const app: AppState = {
  records,
  windows: [],
  groups: [],
  areas: [],
  memberships: [],
  workItems: [],
  proposals: [],
  collectionProposals: [],
  organizationJobs: [],
  snapshots: [],
  operations: [],
  jobs: [],
  version: 'synthetic-taxonomy-evaluation',
  tagVocabulary: [],
  projects: [
    {
      id: 'accepted',
      name: 'OrbitAssist',
      purpose: 'Develop and maintain the OrbitAssist desktop assistant',
      areaId: null,
      updatedAt: 1,
      revision: 1,
      maintainReviewQueue: false,
    },
  ],
  categories: [
    {
      id: 'source',
      projectId: 'accepted',
      name: 'Implementation',
      description: 'Source-code repository and implementation work',
      color: 'blue',
      order: 0,
      updatedAt: 1,
      revision: 1,
    },
    {
      id: 'releases',
      projectId: 'accepted',
      name: 'Releases',
      description: 'Version releases and changelogs',
      color: 'green',
      order: 1,
      updatedAt: 1,
      revision: 1,
    },
  ],
  settings: {
    ...DEFAULTS,
    aiBase: base,
    aiModel: model,
    aiContextTokens: context,
    aiCompletionTokens: 8192,
    useDedicatedDecisionModel: true,
    decisionBase,
    decisionModel,
    decisionContextTokens: decisionContext,
    classificationMinConfidence: 0.8,
  },
};
let checkpoint: CollectionAnalysis = collectionAnalysisSchema.parse({
  id: 'live-taxonomy-evaluation',
  decisionContract: CLASSIFICATION_CONTRACT,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  purpose: 'proposal',
  instruction: '',
  reuseAcceptedTaxonomyOnly: false,
  scope: records.map(({ id, url, navigationVersion }) => ({ id, url, navigationVersion })),
  discoveredIds: records.map((item) => item.id),
  classifiedIds: [],
  projects: raw,
  summaries: ['Synthetic discovery already saved.'],
  assignments: [],
  unresolvedRecordIds: [],
  tagVocabulary: [],
});
const receipts: import('../src/shared/inference/inference-receipt').InferenceReceipt[] = [];
const started = Date.now();
const draft = await generateCollectionDraft(app, {
  onProgress: console.log,
  checkpoint: {
    id: checkpoint.id,
    receipt: async (receipt) => {
      receipts.push({ ...receipt, analysisId: checkpoint.id });
      writeFileSync('artifacts/taxonomy-live-receipts.json', JSON.stringify(receipts, null, 2));
    },
    load: async () => checkpoint,
    save: async (value) => {
      checkpoint = collectionAnalysisSchema.parse(value);
      return checkpoint;
    },
  },
});
const first = draft.assignments.find((row) => row.recordId === records[0]!.id),
  second = draft.assignments.find((row) => row.recordId === records[1]!.id),
  third = draft.assignments.find((row) => row.recordId === records[2]!.id),
  fourth = draft.assignments.find((row) => row.recordId === records[3]!.id);
const result = {
  generativeModel: model,
  decisionModel,
  seconds: (Date.now() - started) / 1000,
  sourceProjects: raw.length,
  canonicalProjects: draft.projects.length,
  acceptedProjectPreserved: draft.projects.some((item) => item.name === 'OrbitAssist'),
  coherentAssignment:
    first?.projectName === 'OrbitAssist' &&
    second?.projectName === 'OrbitAssist' &&
    !!third &&
    third.projectName === fourth?.projectName &&
    third.projectName !== 'OrbitAssist',
  projects: draft.projects,
  assignments: draft.assignments,
  unresolved: draft.unresolvedRecordIds,
};
writeFileSync('artifacts/taxonomy-correctness-live.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
