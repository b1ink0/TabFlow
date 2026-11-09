import { tagReviewSchema } from './organization/tag-analysis';
import { z } from 'zod';
import { validFavicon } from './tabs/favicon';
import type {
  Area,
  Backup,
  CollectionDraft,
  OrganizationDraft,
  Plan,
  Project,
  Settings,
  TabRecord,
  WindowInfo,
  WorkItem,
  UpdateSummary,
} from './types';
export const SCHEMA_VERSION = 6;
export const COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;
export const DEFAULTS: Settings = {
  imageModel: '',
  imageBase: '',
  tagModelRole: 'small',
  tagVerification: 'chat',
  aiStreamResponses: true,
  maxConcurrentInference: 1,
  aiReasoningEffort: 'server',
  smallReasoningEffort: 'server',
  aiCompletionTokens: 8192,
  smallCompletionTokens: 4096,
  aiContextTokens: 0,
  smallContextTokens: 0,
  decisionContextTokens: 0,
  aiTokenField: 'max_tokens',
  smallTokenField: 'max_tokens',
  classificationMinConfidence: 0.65,
  autoSuspend: false,
  suspendMinutes: 60,
  protectPinned: true,
  protectAudio: true,
  protectForms: true,
  protectGrouped: false,
  neverSuspendSites: '',
  pauseSuspensionOffline: true,
  wakeOnFocus: false,
  restoreScroll: true,
  capturePreviews: false,
  previewExcludedSites: '',
  discardPlaceholders: false,
  autoIndex: true,
  textLimit: 10000,
  snapshotRetention: 150,
  backupEnabled: false,
  backupHours: 24,
  aiProvider: 'lmstudio',
  aiBase: 'http://127.0.0.1:1234/v1',
  aiModel: '',
  aiKey: '',
  smallModelBase: 'http://127.0.0.1:1234/v1',
  smallModel: '',
  smallModelKey: '',
  useDedicatedDecisionModel: false,
  decisionProvider: 'jev',
  decisionBase: 'http://127.0.0.1:1234',
  decisionModel: '',
  decisionKey: '',
  googleCalendarClientId: '',
  aiBatchSize: 35,
  aiMaxAttempts: 6,
  aiEvidenceCharacters: 64000,
  maintainCollectionReview: false,
  reviewProjectWindowsOnly: false,
};
export const uuid = () => crypto.randomUUID();
export const sessionReloadSchema = z.object({
  snapshotId: z.string().min(1),
  requestedAt: z.number().finite(),
  recordIds: z.array(z.string().min(1)).max(100000),
  ready: z.boolean().default(true),
  claimed: z.boolean().default(false),
  operationId: z.string().optional(),
  phase: z.enum(['preparing', 'ready', 'restoring', 'interrupted']).optional(),
  parked: z
    .array(
      z.object({
        tabId: z.number().int(),
        marker: z.string(),
        url: z.string(),
        status: z.enum(['pending', 'parked', 'restored', 'retained', 'failed']),
        error: z.string().optional(),
      }),
    )
    .max(100000)
    .default([]),
});
export const updateProgressSchema = z
  .object({
    total: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    interrupted: z.boolean(),
    stage: z.enum(['preparing', 'ready', 'restoring', 'interrupted']),
    processed: z.number().int().nonnegative(),
    errors: z.array(z.string()).max(3),
  })
  .refine((value) => value.processed <= value.total && value.remaining <= value.total);
export const updateCompletionSchema = z
  .object({
    finishedAt: z.number().finite(),
    total: z.number().int().nonnegative(),
    restored: z.number().int().nonnegative(),
    retained: z.number().int().nonnegative(),
  })
  .refine((value) => value.restored + value.retained === value.total);
export function summarizeUpdate(ticket: z.infer<typeof sessionReloadSchema>): UpdateSummary {
  const stage = ticket.phase || 'interrupted';
  const remaining = ticket.parked.filter(
    (item) => !['restored', 'retained'].includes(item.status),
  ).length;
  return {
    total: ticket.parked.length,
    remaining,
    interrupted: stage === 'interrupted',
    stage,
    processed:
      stage === 'preparing' || stage === 'ready'
        ? ticket.parked.filter((item) => item.status === 'parked').length
        : ticket.parked.length - remaining,
    errors: ticket.parked.flatMap((item) => (item.error ? [item.error] : [])).slice(0, 3),
  };
}
export const migrationProgressSchema = z.object({
  id: z.string(),
  operationId: z.string(),
  status: z.enum(['running', 'complete', 'partial', 'cancelled', 'interrupted']),
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  currentTitle: z.string().optional(),
});
export const now = () => Date.now();
export const clip = (v: unknown, n = 10000) => String(v ?? '').slice(0, n);
import { isNativeNewTabURL, pageURL } from './tabs/urls';
export { pageURL, suspendedInfo, makeSuspendedURL } from './tabs/urls';
export function newRecord(url: string, id: string = uuid()): TabRecord {
  return {
    id,
    url,
    title: url,
    createdAt: now(),
    navigationVersion: 0,
    index: 0,
    groupId: -1,
    pinned: false,
    suspended: false,
    foreignSuspended: false,
    active: false,
    audible: false,
    lastAccessed: now(),
    lastSeen: now(),
    live: false,
    wasOpen: false,
    projectId: null,
    locked: false,
    note: '',
    tags: [],
    scroll: 0,
    activations: 0,
    focusedMs: 0,
  };
}
export function searchable(r: TabRecord) {
  return [
    r.title,
    r.branchName,
    r.url,
    r.content?.description,
    r.content?.headings?.join(' '),
    r.content?.text,
    r.note,
    ...r.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
const serverURL = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  }, 'Use an HTTP(S) server URL without embedded credentials.')
  .transform((v) => v.replace(/\/$/, ''));
export const settingsSchema = z.object({
  tagModelRole: z.enum(['small', 'generative']).default('small'),
  tagVerification: z.enum(['none', 'chat', 'decision']).default('chat'),
  imageModel: z.string().max(2000).default(''),
  imageBase: z.string().max(2000).default(''),
  aiStreamResponses: z.boolean().default(true),
  maxConcurrentInference: z.number().int().min(1).max(8).default(1),
  aiReasoningEffort: z.enum(['server', 'none', 'low', 'medium', 'high']).default('server'),
  smallReasoningEffort: z.enum(['server', 'none', 'low', 'medium', 'high']).default('server'),
  aiCompletionTokens: z.number().int().min(1024).max(65536).default(8192),
  smallCompletionTokens: z.number().int().min(512).max(65536).default(4096),
  aiContextTokens: z.number().int().min(0).max(1048576).default(0),
  smallContextTokens: z.number().int().min(0).max(1048576).default(0),
  decisionContextTokens: z.number().int().min(0).max(1048576).default(0),
  aiTokenField: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  smallTokenField: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  classificationMinConfidence: z.number().min(0).max(1).default(0.65),
  autoSuspend: z.boolean(),
  suspendMinutes: z.number().min(5).max(10080),
  protectPinned: z.boolean(),
  protectAudio: z.boolean(),
  protectForms: z.boolean().default(true),
  protectGrouped: z.boolean().default(false),
  neverSuspendSites: z.string().max(8000).default(''),
  pauseSuspensionOffline: z.boolean().default(true),
  wakeOnFocus: z.boolean().default(false),
  restoreScroll: z.boolean().default(true),
  capturePreviews: z.boolean().default(false),
  previewExcludedSites: z.string().max(8000).default(''),
  discardPlaceholders: z.boolean(),
  autoIndex: z.boolean(),
  textLimit: z.number().int().min(500).max(20000),
  snapshotRetention: z.number().int().min(10).max(5000),
  backupEnabled: z.boolean(),
  backupHours: z.number().min(1).max(168),
  aiProvider: z.enum(['lmstudio', 'bud']),
  aiBase: serverURL,
  aiModel: z.string().max(2000),
  aiKey: z.string().max(2000),
  smallModelBase: serverURL,
  smallModel: z.string().max(2000),
  smallModelKey: z.string().max(2000),
  useDedicatedDecisionModel: z.boolean().default(false),
  decisionProvider: z.enum(['jev', 'bud']).default('jev'),
  decisionBase: serverURL,
  decisionModel: z.string().max(2000),
  decisionKey: z.string().max(2000),
  googleCalendarClientId: z.string().trim().max(300),
  aiBatchSize: z.number().int().min(5).max(60),
  aiMaxAttempts: z.number().int().min(1).max(10).default(6),
  aiEvidenceCharacters: z.number().int().min(0).max(2000000).default(64000),
  maintainCollectionReview: z.boolean().default(false),
  reviewProjectWindowsOnly: z.boolean().default(false),
});
export const validateSettings = (input: unknown): Settings => {
  const legacy = typeof input === 'object' && input ? (input as Record<string, unknown>) : {};
  const value = { ...DEFAULTS, ...legacy } as Settings;
  if (!('smallModelBase' in legacy)) {
    value.smallModelBase = String(
      legacy.decisionProvider === 'openai-compatible'
        ? legacy.decisionBase || value.aiBase
        : value.aiBase,
    );
    value.smallModel = String(
      legacy.decisionProvider === 'openai-compatible' ? legacy.decisionModel || '' : '',
    );
    value.smallModelKey = String(
      legacy.decisionProvider === 'openai-compatible' ? legacy.decisionKey || '' : '',
    );
  }
  if (!('decisionProvider' in legacy))
    value.decisionProvider =
      legacy.aiProvider === 'bud' || legacy.decisionProvider === 'bud' ? 'bud' : 'jev';
  if (!('useDedicatedDecisionModel' in legacy))
    value.useDedicatedDecisionModel =
      legacy.decisionProvider === 'bud' ||
      legacy.aiProvider === 'bud' ||
      (legacy.decisionEnabled === true && legacy.decisionProvider !== 'openai-compatible');
  if (legacy.decisionProvider === 'bud' || legacy.aiProvider === 'bud') {
    if (typeof legacy.budBase === 'string') value.decisionBase = legacy.budBase;
    if (typeof legacy.budModel === 'string') value.decisionModel = legacy.budModel;
  }
  return settingsSchema.parse(value);
};
export const provenanceSchema = z.object({
  author: z.enum(['owner', 'ai']),
  model: z.string().max(2000).optional(),
  proposalId: z.string().max(200).optional(),
});
export const areaInputSchema = z.object({
  provenance: provenanceSchema.optional(),
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).optional().default(''),
});
export const workItemInputSchema = z.object({
  provenance: provenanceSchema.optional(),
  id: z.string().optional(),
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(4000).optional().default(''),
  areaId: z.string().nullable().optional().default(null),
  projectId: z.string().nullable().optional().default(null),
  recordId: z.string().nullable().optional().default(null),
  url: z.string().nullable().optional().default(null),
  status: z.enum(['open', 'doing', 'waiting', 'done']).optional().default('open'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().default('normal'),
  dueAt: z.number().nullable().optional().default(null),
  source: z.enum(['owner', 'tab']).optional().default('owner'),
});
export function validateArea(input: unknown, existing?: Area): Area {
  const value = areaInputSchema.parse(input);
  return {
    ...value,
    id: existing?.id || value.id || uuid(),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
}
export function validateWorkItem(input: unknown, existing?: WorkItem): WorkItem {
  const value = workItemInputSchema.parse(input);
  return {
    ...value,
    provenance: value.provenance || existing?.provenance || { author: 'owner' },
    id: existing?.id || value.id || uuid(),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
}
export const collectionDraftSchema = z.object({
  excludedRecordIds: z.array(z.string().min(1)).max(1000).optional(),
  name: z.string().trim().max(120).optional(),
  tagReview: tagReviewSchema.optional(),
  decisionContract: z.string().max(80).optional(),
  legacyCategoriesRetained: z.boolean().optional(),
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
  model: z.string().max(2000).optional(),
  summary: z.string().max(2000),
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
      z.object({
        recordId: z.string().min(1),
        url: z.string(),
        navigationVersion: z.number().int().min(0),
        projectName: z.string().trim().min(1).max(80),
        categoryName: z.string().trim().min(1).max(80),
        suggestedTags: z.array(z.string().trim().min(1).max(80)).optional(),
        reason: z.string().max(300),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(1000),
  unresolvedRecordIds: z.array(z.string().min(1)).max(1000),
  ownerAssignedRecordIds: z.array(z.string().min(1)).max(1000).optional().default([]),
  scopeRecordIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
  sourceJobIds: z.array(z.string().min(1)).max(10).optional(),
});
export function validateCollectionDraft(
  input: unknown,
  eligibleRecordIds: Set<string>,
): CollectionDraft {
  const draft = collectionDraftSchema.parse(input);
  if (draft.scopeRecordIds) {
    if (
      new Set(draft.scopeRecordIds).size !== draft.scopeRecordIds.length ||
      draft.scopeRecordIds.some((id) => !eligibleRecordIds.has(id))
    )
      throw new Error('Collection proposal has an invalid occurrence scope.');
    eligibleRecordIds = new Set(draft.scopeRecordIds);
  }
  if (
    new Set(draft.excludedRecordIds || []).size !== (draft.excludedRecordIds || []).length ||
    draft.excludedRecordIds?.some((id) => !eligibleRecordIds.has(id))
  )
    throw new Error('Excluded tabs must use unique occurrence IDs from this proposal scope.');
  const projectNames = new Set(draft.projects.map((p) => p.name.toLowerCase()));
  if (projectNames.size !== draft.projects.length)
    throw new Error('Collection proposal has duplicate project names.');
  for (const project of draft.projects) {
    const categoryNames = project.categories.map((category) => category.name.toLowerCase());
    if (new Set(categoryNames).size !== categoryNames.length)
      throw new Error('Collection proposal has duplicate categories.');
  }
  const decided = new Set<string>();
  for (const assignment of draft.assignments) {
    if (!eligibleRecordIds.has(assignment.recordId) || decided.has(assignment.recordId))
      throw new Error('Collection proposal contains an unknown or duplicate occurrence.');
    const project = draft.projects.find(
      (p) => p.name.toLowerCase() === assignment.projectName.toLowerCase(),
    );
    if (
      !project?.categories.some(
        (c) => c.name.toLowerCase() === assignment.categoryName.toLowerCase(),
      )
    )
      throw new Error(
        `Tab ${JSON.stringify(assignment.recordId)} references ${JSON.stringify(assignment.projectName)} / ${JSON.stringify(assignment.categoryName)}. ${project ? `Available categories: ${project.categories.map((c) => JSON.stringify(c.name)).join(', ') || '(none)'}. Add the category in categoryEdits before assigning it.` : `Available projects: ${draft.projects.map((p) => JSON.stringify(p.name)).join(', ') || '(none)'}. Add the project in projectEdits first.`}`,
      );
    decided.add(assignment.recordId);
  }
  for (const id of draft.unresolvedRecordIds) {
    if (!eligibleRecordIds.has(id) || decided.has(id))
      throw new Error('Collection proposal has an invalid unresolved occurrence.');
    decided.add(id);
  }
  if (
    new Set(draft.ownerAssignedRecordIds).size !== draft.ownerAssignedRecordIds.length ||
    draft.ownerAssignedRecordIds.some(
      (id) => !draft.assignments.some((assignment) => assignment.recordId === id),
    )
  )
    throw new Error('Collection proposal has an invalid owner-reviewed assignment.');
  if (decided.size !== eligibleRecordIds.size)
    throw new Error('Collection proposal omitted eligible occurrences.');
  const tagIds = new Set<string>();
  for (const item of draft.unresolvedTagSuggestions || []) {
    if (!draft.unresolvedRecordIds.includes(item.recordId) || tagIds.has(item.recordId))
      throw new Error('Invalid independent tag suggestion occurrence.');
    tagIds.add(item.recordId);
  }
  const reviewIds = new Set<string>();
  for (const item of draft.tagReview || []) {
    if (
      !eligibleRecordIds.has(item.recordId) ||
      reviewIds.has(item.recordId) ||
      new Set(item.tags.map((tag) => tag.name.toLowerCase())).size !== item.tags.length
    )
      throw new Error('Invalid tag-review occurrence or duplicate label.');
    reviewIds.add(item.recordId);
  }
  return draft;
}
export const actionSchema = z.object({
  type: z.enum([
    'group',
    'ungroup',
    'move',
    'moveGroup',
    'reorder',
    'suspend',
    'wake',
    'pin',
    'mute',
  ]),
  nativeGroupId: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
  recordIds: z.array(z.string()).min(1),
  windowId: z.number().int().optional(),
  index: z.number().int().min(0).optional(),
  name: z.string().max(80).optional(),
  color: z.enum(COLORS).optional(),
  reason: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export const planSchema = z.object({
  provenance: provenanceSchema.optional(),
  collectionProposalId: z.string().max(200).optional(),
  summary: z.string().max(2000).default(''),
  actions: z.array(actionSchema).max(1000),
  matchIds: z.array(z.string()).optional(),
  expected: z
    .record(
      z.string(),
      z.object({
        url: z.string(),
        navigationVersion: z.number(),
        windowId: z.number().int().optional(),
        groupId: z.number().int().optional(),
      }),
    )
    .optional(),
});
const organizationDraftSchema = z.object({
  tagReview: tagReviewSchema.optional(),
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
  projectId: z.string().min(1),
  projectRevision: z.number().int().positive(),
  summary: z.string().max(2000),
  projectSuggestion: z
    .object({ name: z.string().min(1).max(80), purpose: z.string().max(1000) })
    .optional(),
  categories: z
    .array(z.object({ name: z.string().min(1).max(80), description: z.string().max(500) }))
    .max(1000),
  assignments: z
    .array(
      z.object({
        recordId: z.string().min(1),
        url: z.string(),
        navigationVersion: z.number().int().min(0),
        categoryName: z.string().min(1).max(80),
        reason: z.string().max(500),
        confidence: z.number().min(0).max(1),
        suggestedTags: z.array(z.string().trim().min(1).max(80)).optional(),
      }),
    )
    .max(1000),
  unresolvedRecordIds: z.array(z.string().min(1)).max(1000),
});
export function validateOrganizationDraft(
  input: unknown,
  project: Project,
  records: TabRecord[],
  ownerCorrections: Set<string>,
  acceptedCategoryNames: string[],
): OrganizationDraft {
  const draft = organizationDraftSchema.parse(input);
  if (draft.projectId !== project.id || draft.projectRevision !== project.revision)
    throw new Error('Project changed while the organization draft was being generated.');
  if (draft.projectSuggestion && !draft.projectSuggestion.name.trim())
    throw new Error('Draft project name cannot be blank.');
  const names = draft.categories.map((category) => category.name);
  const uniqueNames = new Set(names.map((name) => name.trim().toLowerCase()));
  if (uniqueNames.size !== names.length)
    throw new Error('Draft contains duplicate category names.');
  const allowedNames = new Set([
    ...draft.categories.map((category) => category.name.trim().toLowerCase()),
    ...acceptedCategoryNames.map((name) => name.trim().toLowerCase()),
  ]);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const assigned = new Set<string>();
  for (const assignment of draft.assignments) {
    const record = recordsById.get(assignment.recordId);
    if (!record?.live || record.locked || ownerCorrections.has(record.id))
      throw new Error('Draft includes a tab that is closed or protected by an owner correction.');
    if (record.url !== assignment.url || record.navigationVersion !== assignment.navigationVersion)
      throw new Error('A tab changed while the organization draft was being generated.');
    if (assigned.has(record.id)) throw new Error('Draft assigns one tab more than once.');
    assigned.add(record.id);
    if (!allowedNames.has(assignment.categoryName.trim().toLowerCase()))
      throw new Error('Draft assignment references an unknown category.');
  }
  if (new Set(draft.unresolvedRecordIds).size !== draft.unresolvedRecordIds.length)
    throw new Error('Draft contains duplicate unresolved tab IDs.');
  for (const id of draft.unresolvedRecordIds) {
    if (!recordsById.get(id)?.live || assigned.has(id))
      throw new Error('Draft unresolved list contains an unavailable or assigned tab.');
  }
  if (assigned.size + draft.unresolvedRecordIds.length !== records.length)
    throw new Error('Draft omitted one or more tabs from its result.');
  const tagged = new Set<string>();
  for (const item of draft.unresolvedTagSuggestions || []) {
    const record = recordsById.get(item.recordId);
    if (
      tagged.has(item.recordId) ||
      !draft.unresolvedRecordIds.includes(item.recordId) ||
      !record?.live ||
      record.locked ||
      ownerCorrections.has(item.recordId) ||
      record.url !== item.url ||
      record.navigationVersion !== item.navigationVersion
    )
      throw new Error('Invalid independent project tag suggestion.');
    tagged.add(item.recordId);
  }
  if (
    new Set((draft.tagReview || []).map((item) => item.recordId)).size !==
      (draft.tagReview || []).length ||
    draft.tagReview?.some(
      (item) =>
        !recordsById.has(item.recordId) ||
        new Set(item.tags.map((tag) => tag.name.toLowerCase())).size !== item.tags.length,
    )
  )
    throw Error('Invalid project tag-review occurrence or duplicate label.');
  return {
    ...draft,
    projectSuggestion: draft.projectSuggestion
      ? {
          name: draft.projectSuggestion.name.trim(),
          purpose: draft.projectSuggestion.purpose.trim(),
        }
      : undefined,
    categories: draft.categories.map((category) => ({
      name: category.name.trim(),
      description: category.description.trim(),
    })),
    summary: draft.summary.trim(),
  };
}
export function organizationDraftSignature(
  draft: Pick<
    OrganizationDraft,
    | 'tagReview'
    | 'projectId'
    | 'projectRevision'
    | 'projectSuggestion'
    | 'categories'
    | 'assignments'
    | 'unresolvedRecordIds'
    | 'unresolvedTagSuggestions'
  >,
): string {
  const normalize = (value: string) => value.trim().toLowerCase();
  return JSON.stringify({
    projectId: draft.projectId,
    tagReview: draft.tagReview,
    projectRevision: draft.projectRevision,
    projectSuggestion: draft.projectSuggestion
      ? [normalize(draft.projectSuggestion.name), normalize(draft.projectSuggestion.purpose)]
      : null,
    categories: draft.categories
      .map((category) => [normalize(category.name), normalize(category.description)])
      .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    assignments: [...draft.assignments]
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .map((assignment) => [
        assignment.recordId,
        assignment.url,
        assignment.navigationVersion,
        normalize(assignment.categoryName),
        [...(assignment.suggestedTags || [])].sort(),
      ]),
    unresolvedRecordIds: [...draft.unresolvedRecordIds].sort(),
    unresolvedTags: [...(draft.unresolvedTagSuggestions || [])]
      .sort((a, b) => a.recordId.localeCompare(b.recordId))
      .map((item) => [
        item.recordId,
        item.url,
        item.navigationVersion,
        [...item.suggestedTags].sort(),
      ]),
  });
}
export function validatePlan(input: unknown, records: TabRecord[], windows: WindowInfo[]): Plan {
  const plan = planSchema.parse(input);
  const byId = new Map(records.map((r) => [r.id, r]));
  const windowsById = new Set(windows.map((w) => w.id));
  const assigned = new Set<string>();
  for (const a of plan.actions) {
    if ((a.type === 'pin' || a.type === 'mute') && a.enabled === undefined)
      throw new Error('Pin and mute actions require an explicit enabled state.');
    if (a.type !== 'group' && a.name?.trim())
      throw new Error(
        'Only group actions accept a group name. A move action changes the browser window and does not join a group; use group for grouping.',
      );
    a.recordIds = [...new Set(a.recordIds)];
    for (const id of a.recordIds) {
      const r = byId.get(id);
      if (!r?.live) throw new Error('A tab is no longer open. Refresh the plan.');
      if (r.locked) throw new Error(`Protected tab: ${r.title}`);
      if (
        ['group', 'ungroup', 'move', 'moveGroup', 'reorder', 'pin'].includes(a.type) &&
        r.splitViewId !== undefined &&
        r.splitViewId >= 0
      )
        throw new Error(
          'This tab is in a native split. Unsplit it in the browser before changing its placement.',
        );
      if (a.type === 'group') {
        if (assigned.has(id)) throw new Error('A tab appears in multiple proposed groups.');
        assigned.add(id);
        if (r.pinned) throw new Error('Pinned tabs cannot join native groups.');
      }
    }
    if (a.type === 'moveGroup') {
      if (a.nativeGroupId === undefined) throw new Error('Choose a native group to move.');
      const members = records.filter((record) => record.live && record.groupId === a.nativeGroupId);
      if (
        !members.length ||
        members.length !== a.recordIds.length ||
        members.some((record) => !a.recordIds.includes(record.id))
      )
        throw new Error('Native group membership changed. Refresh before moving the whole group.');
    }
    if (['group', 'move', 'moveGroup'].includes(a.type) && !windowsById.has(a.windowId!))
      throw new Error('Target window is no longer open.');
    if (a.type === 'reorder') {
      if (a.recordIds.length !== 1 || a.index === undefined)
        throw new Error('Reordering requires one tab and a destination index.');
      const r = byId.get(a.recordIds[0]!);
      if (!r?.live || r.windowId === undefined || !windowsById.has(r.windowId))
        throw new Error('Tab window is no longer open.');
      if (r.pinned) throw new Error('Pinned tabs cannot be reordered here.');
      const siblings = records.filter((entry) => entry.live && entry.windowId === r.windowId);
      if (a.index >= siblings.length) throw new Error('Destination index is outside this window.');
      const destinationPinned = siblings.find((entry) => entry.index === a.index)?.pinned;
      if (destinationPinned)
        throw new Error('Tabs cannot be reordered across the pinned boundary.');
    }
    if (a.type === 'group') {
      a.name = a.name?.trim();
      if (!a.name) throw new Error('Group name is empty.');
      a.color = a.color || 'blue';
    }
  }
  plan.matchIds = [...new Set(plan.matchIds || [])].filter((id) => byId.has(id));
  return plan;
}
const snapshotTab = z
  .object({
    nativeNewTab: z.literal(true).optional(),
    parentRecordId: z.string().nullable().optional(),
    openerRecordId: z.string().nullable().optional(),
    branchName: z.string().max(80).optional(),
    suspendedFavicon: z.string().refine(validFavicon).optional(),
    recordId: z.string(),
    url: z.string(),
    title: z.string().max(1000),
    scroll: z.number(),
    index: z.number(),
    groupId: z.number(),
    pinned: z.boolean(),
    muted: z.boolean().optional(),
    suspended: z.boolean(),
    locked: z.boolean(),
    projectId: z.string().nullable(),
    note: z.string().max(4000),
    tags: z.array(z.string()),
  })
  .refine(
    (tab) =>
      tab.nativeNewTab ? isNativeNewTabURL(tab.url) && !tab.suspended : Boolean(pageURL(tab.url)),
    'Only web pages or explicitly marked native new tabs can be restored.',
  );
const snapshotSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  label: z.string(),
  automatic: z.boolean(),
  windows: z.array(
    z.object({
      id: z.number(),
      focused: z.boolean(),
      projectId: z.string().nullable(),
      projectName: z.string(),
      groups: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          color: z.enum(COLORS),
          collapsed: z.boolean(),
        }),
      ),
      tabs: z.array(snapshotTab),
    }),
  ),
});
export function importSnapshot(input: unknown): Backup {
  const value = z
    .object({
      format: z.literal('tabloom'),
      schema: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ]),
      exportedAt: z.number(),
      assistant: z.unknown().optional(),
      projects: z
        .array(
          z
            .object({
              id: z.string(),
              name: z.string().max(80),
              provenance: provenanceSchema.optional(),
              purpose: z.string().max(1000).optional(),
              displayColor: z
                .string()
                .regex(/^#[0-9a-fA-F]{6}$/)
                .nullable()
                .optional(),
              revision: z.number().int().positive().optional(),
              maintainReviewQueue: z.boolean().optional(),
              areaId: z.string().nullable().optional(),
              updatedAt: z.number(),
            })
            .transform((project) => ({
              ...project,
              purpose: project.purpose || '',
              revision: project.revision || 1,
              maintainReviewQueue: project.maintainReviewQueue || false,
            })),
        )
        .max(500),
      categories: z
        .array(
          z.object({
            id: z.string(),
            projectId: z.string(),
            name: z.string().max(80),
            provenance: provenanceSchema.optional(),
            description: z.string().max(500),
            color: z.enum(COLORS).optional(),
            displayColor: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .nullable()
              .optional(),
            order: z.number().int().min(0),
            updatedAt: z.number(),
            revision: z.number().int().positive(),
          }),
        )
        .max(5000)
        .optional(),
      memberships: z
        .array(
          z
            .object({
              recordId: z.string(),
              projectId: z.string().nullable(),
              categoryId: z.string().nullable(),
              source: z.enum(['owner', 'legacy', 'accepted-ai', 'unassigned', 'inherited']),
              provenance: provenanceSchema.optional(),
              reason: z.string().max(500).optional(),
              updatedAt: z.number(),
            })
            .refine(
              (membership) =>
                (membership.projectId !== null || membership.categoryId === null) &&
                (membership.source !== 'unassigned' || membership.projectId === null),
              'Inbox membership cannot reference a project category.',
            ),
        )
        .max(100000)
        .optional(),
      areas: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().max(80),
            description: z.string().max(1000),
            provenance: provenanceSchema.optional(),
            createdAt: z.number(),
            updatedAt: z.number(),
          }),
        )
        .max(500)
        .optional(),
      workItems: z
        .array(
          z.object({
            id: z.string(),
            title: z.string().max(240),
            provenance: provenanceSchema.optional(),
            notes: z.string().max(4000),
            areaId: z.string().nullable(),
            projectId: z.string().nullable(),
            recordId: z.string().nullable(),
            url: z.string().nullable(),
            status: z.enum(['open', 'doing', 'waiting', 'done']),
            priority: z.enum(['low', 'normal', 'high', 'urgent']),
            dueAt: z.number().nullable(),
            source: z.enum(['owner', 'tab']),
            createdAt: z.number(),
            updatedAt: z.number(),
          }),
        )
        .max(10000)
        .optional(),
      snapshots: z.array(snapshotSchema),
    })
    .parse(input);
  return value;
}
