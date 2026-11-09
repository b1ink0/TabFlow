// Explicit opt-in. Synthetic evidence only; never connects to a browser profile.
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateCollectionDraft } from '../src/ai/workflows/generation';
import { DEFAULTS, newRecord } from '../src/shared/model';
import type { AppState, CollectionAnalysis, CollectionDraft } from '../src/shared/types';
import { collectionAnalysisSchema } from '../src/shared/organization/collection-analysis';

const endpoint = process.env.TABFLOW_DECISION_URL,
  model = process.env.TABFLOW_DECISION_MODEL;
const context = Number(process.env.TABFLOW_DECISION_CONTEXT);
if (!endpoint || !model || !Number.isSafeInteger(context) || context <= 0)
  throw new Error(
    'Set TABFLOW_DECISION_URL, TABFLOW_DECISION_MODEL and an explicit TABFLOW_DECISION_CONTEXT request envelope (not an inferred server limit).',
  );
const chatRole = process.env.TABFLOW_CLASSIFIER_ROLE === 'small';
const count = Number(process.argv[2] || 100);
if (![1, 5, 20, 100].includes(count))
  throw new Error('Choose 1, 5, 20 or 100 synthetic occurrences.');
const names = [
  'AsterDesk',
  'BirchNotes',
  'CobaltMail',
  'DuneBoard',
  'ElmSearch',
  'FlintSync',
  'GroveTasks',
  'HazelForms',
  'IndigoFiles',
  'JadeMetrics',
  'KestrelWiki',
  'LarchDeploy',
  'MossCalendar',
  'NectarCRM',
  'OpalStudio',
  'PebbleReader',
  'QuillLedger',
  'ReedChat',
  'SlateDocs',
  'ThistleMaps',
  'UmberPlan',
  'ValeCode',
  'WrenCloud',
  'YarrowHub',
  'ZephyrBooks',
];
const kinds = [
  {
    name: 'Implementation',
    description:
      'Source-code repositories and local development code. Excludes reading documentation.',
  },
  { name: 'Pull requests', description: 'GitHub pull-request pages and code reviews.' },
  { name: 'Issues', description: 'Bug reports and GitHub issue pages.' },
  {
    name: 'Documentation',
    description: 'Reading API documentation, integration guides and reference pages.',
  },
];
const projects: CollectionDraft['projects'] = names.map((name) => ({
  name,
  purpose: `Develop and maintain the ${name} application.`,
  areaName: 'Software',
  categories: kinds,
}));
const fixtures = names
  .flatMap((name, p) =>
    kinds.map((kind, k) => {
      const slug = name.toLowerCase();
      const title = [
        `${name}: source code repository`,
        `Improve keyboard navigation · Pull Request #${p + 2} · ${name}`,
        `Crash after opening preferences · Issue #${p + 3} · ${name}`,
        `${name} API authentication reference`,
      ][k]!;
      const url = [
        `https://github.com/fixture/${slug}`,
        `https://github.com/fixture/${slug}/pull/${p + 2}`,
        `https://github.com/fixture/${slug}/issues/${p + 3}`,
        `https://docs.example.test/${slug}/authentication`,
      ][k]!;
      return {
        record: { ...newRecord(url), id: `gold-${p}-${k}`, title, live: true, suspended: true },
        project: name,
        category: kind.name,
        tags: k === 3 ? ['documentation'] : ['github'],
      };
    }),
  )
  .slice(0, count);
const app: AppState = {
  records: fixtures.map((item) => item.record),
  windows: [],
  groups: [],
  projects: [],
  areas: [],
  categories: [],
  memberships: [],
  workItems: [],
  proposals: [],
  collectionProposals: [],
  organizationJobs: [],
  snapshots: [],
  operations: [],
  jobs: [],
  version: 'synthetic-correctness-evaluation',
  tagVocabulary: count <= 20 ? ['github', 'documentation', 'recipes', 'botany'] : [],
  settings: {
    ...DEFAULTS,
    useDedicatedDecisionModel: !chatRole,
    smallModelBase: endpoint,
    smallModel: model,
    smallContextTokens: context,
    smallCompletionTokens: 8192,
    decisionBase: endpoint,
    decisionModel: model,
    decisionContextTokens: context,
    classificationMinConfidence: 0.8,
  },
};
let checkpoint: CollectionAnalysis | undefined;
const started = Date.now();
try {
  const draft = await generateCollectionDraft(app, {
    reuseAcceptedTaxonomyOnly: true,
    seedProjects: projects,
    onProgress: (message) => console.log(message),
    checkpoint: {
      id: 'synthetic-quality',
      load: async () => checkpoint,
      save: async (value) => {
        checkpoint = collectionAnalysisSchema.parse(value);
        return checkpoint;
      },
    },
  });
  const correct = draft.assignments.filter((row) => {
    const gold = fixtures.find((item) => item.record.id === row.recordId);
    return gold?.project === row.projectName && gold.category === row.categoryName;
  });
  let tagTruePositive = 0,
    tagFalsePositive = 0,
    tagFalseNegative = 0;
  const failures: unknown[] = [];
  for (const gold of fixtures) {
    const assigned = draft.assignments.find((row) => row.recordId === gold.record.id);
    if (
      !assigned ||
      assigned.projectName !== gold.project ||
      assigned.categoryName !== gold.category
    )
      failures.push({
        id: gold.record.id,
        title: gold.record.title,
        expected: `${gold.project}/${gold.category}`,
        actual: assigned ? `${assigned.projectName}/${assigned.categoryName}` : 'unresolved',
        confidence: assigned?.confidence,
      });
    if (count <= 20) {
      const tags =
        assigned?.suggestedTags ||
        draft.unresolvedTagSuggestions?.find((row) => row.recordId === gold.record.id)
          ?.suggestedTags ||
        [];
      for (const tag of tags)
        if (gold.tags.includes(tag)) tagTruePositive++;
        else {
          tagFalsePositive++;
          failures.push({ id: gold.record.id, unsupportedTag: tag });
        }
      for (const tag of gold.tags) if (!tags.includes(tag)) tagFalseNegative++;
    }
  }
  const result = {
    model,
    role: chatRole ? 'small-chat' : 'System One',
    requestEnvelope: context,
    occurrences: count,
    seconds: (Date.now() - started) / 1000,
    assigned: draft.assignments.length,
    correct: correct.length,
    unresolved: draft.unresolvedRecordIds.length,
    acceptedPrecision: draft.assignments.length ? correct.length / draft.assignments.length : 0,
    correctCoverage: correct.length / count,
    tagTruePositive,
    tagFalsePositive,
    tagFalseNegative,
    tagChecks: checkpoint?.tagChecks?.length || 0,
    failures,
  };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    `artifacts/classification-correctness-${chatRole ? 'chat-' : ''}${count}.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
