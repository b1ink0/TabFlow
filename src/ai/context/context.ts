import type { AppState, TabRecord } from '../../shared/types';

/** Bounded model evidence; original records and cached text remain available to paged read tools. */
export function context(app: AppState, records: TabRecord[], includeContent = true) {
  const textLimit = app.settings.textLimit;
  const windowIds = new Set(records.map((record) => record.windowId));
  const memberships = new Map(app.memberships.map((item) => [item.recordId, item.projectId]));
  return {
    windows: app.windows.map((window) => ({
      ...window,
      project:
        app.projects.find((project) => project.id === window.projectId)?.name || 'Unassigned',
    })),
    groups: app.groups
      .filter((group) => windowIds.has(group.windowId))
      .map((group) => ({
        id: group.id,
        windowId: group.windowId,
        name: group.title,
        color: group.color,
      })),
    tabs: records.map((record) => ({
      id: record.id,
      title: record.title.slice(0, 500),
      parentRecordId: record.parentRecordId || null,
      openerRecordId: record.openerRecordId || null,
      branchName: record.branchName || '',
      url: record.url.slice(0, 2000),
      windowId: record.windowId,
      groupId: record.groupId,
      groupName: app.groups.find((group) => group.id === record.groupId)?.title || null,
      project:
        app.projects.find(
          (project) =>
            project.id ===
            (memberships.has(record.id) ? memberships.get(record.id) : record.projectId),
        )?.name || null,
      locked: record.locked,
      pinned: record.pinned,
      suspended: record.suspended,
      foreignSuspended: record.foreignSuspended,
      note: record.note.slice(0, 500),
      tags: record.tags.slice(0, 20).map((tag) => tag.slice(0, 80)),
      lastAccessed: record.lastAccessed,
      cacheAvailable: Boolean(record.content),
      cacheCharacterCount: record.content?.text.length || 0,
      cacheCapturedAt: record.content?.capturedAt ?? null,
      metadataTruncated:
        record.title.length > 500 ||
        record.url.length > 2000 ||
        record.note.length > 500 ||
        record.tags.length > 20 ||
        record.tags.some((tag) => tag.length > 80),
      content:
        includeContent && record.content
          ? {
              description: record.content.description.slice(0, 300),
              headings: record.content.headings.slice(0, 8).map((heading) => heading.slice(0, 120)),
              text: record.content.text.slice(0, textLimit),
              capturedAt: record.content.capturedAt,
              truncated:
                record.content.text.length > textLimit ||
                record.content.description.length > 300 ||
                record.content.headings.length > 8 ||
                record.content.headings.some((heading) => heading.length > 120),
            }
          : null,
    })),
  };
}

/** Character bound supplements the owner's occurrence batch size; it is not an exact token count. */
export function evidenceBatches(
  app: AppState,
  records: TabRecord[],
  maxCount: number,
  maxCharacters = app.settings.aiEvidenceCharacters,
) {
  const batches: TabRecord[][] = [];
  let batch: TabRecord[] = [];
  let used = 0;
  for (const record of records) {
    const size = JSON.stringify(context(app, [record]).tabs[0]).length;
    if (
      batch.length &&
      (batch.length >= maxCount || (maxCharacters > 0 && used + size > maxCharacters))
    ) {
      batches.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(record);
    used += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** System One returns typed decisions, so it needs template headroom but no chat output reserve. */
export function decisionRequestBudget(contextTokens: number) {
  const budget = contextTokens - 1024;
  if (budget <= 0)
    throw new Error(
      'The decision context leaves too little input room after template overhead. Increase the loaded server context. No chat thinking/output budget is reserved for System One.',
    );
  return budget;
}

export function modelRequestBudget(app: AppState, role: 'generative' | 'small' | 'decision') {
  const contextTokens =
    role === 'generative'
      ? app.settings.aiContextTokens
      : role === 'small'
        ? app.settings.smallContextTokens
        : app.settings.decisionContextTokens;
  const outputTokens =
    role === 'generative' ? app.settings.aiCompletionTokens : app.settings.smallCompletionTokens;
  if (!contextTokens)
    throw new Error(
      `Set the loaded ${role} model's context tokens in Settings before analyzing a collection. TabFlow cannot infer that runtime limit from a model name.`,
    );
  if (role === 'decision') return decisionRequestBudget(contextTokens);
  const bytes = contextTokens - outputTokens - 1024;
  if (bytes < 2048)
    throw new Error(
      `The ${role} context leaves too little room after ${outputTokens} thinking/output tokens. Increase the loaded server context or reduce the output budget in Settings.`,
    );
  return bytes;
}

/** A server-reported context rejection is deterministic; shrink instead of repeating it unchanged. */
export function decisionContextRetryBudget(
  error: unknown,
  request: unknown,
  currentBudget: number,
) {
  const message = error instanceof Error ? error.message : String(error);
  const match =
    /request\s*\((\d+)\s*tokens\)\s*exceeds the available context size\s*\((\d+)\s*tokens\)/i.exec(
      message,
    );
  if (!match) return undefined;
  const requested = Number(match[1]),
    available = Number(match[2]);
  if (
    !Number.isSafeInteger(requested) ||
    !Number.isSafeInteger(available) ||
    requested <= available ||
    available <= 0
  )
    return undefined;
  return Math.max(
    0,
    Math.min(
      currentBudget - 1,
      available - 1024,
      Math.floor(((modelRequestBytes(request) * available) / requested) * 0.9),
    ),
  );
}

/** UTF-8 bytes conservatively bound ordinary prompt tokens; 1,024 tokens are reserved for template overhead. */
export function modelRequestBytes(request: unknown) {
  return new TextEncoder().encode(JSON.stringify(request)).length;
}

export function splitOversizedBatch(
  queue: TabRecord[][],
  batch: TabRecord[],
  request: unknown,
  budget: number,
  role: string,
) {
  if (modelRequestBytes(request) <= budget) return false;
  if (batch.length === 1)
    throw new Error(
      `The ${role} request cannot fit even one occurrence with its current project/category options. Increase the loaded model context${role === 'dedicated decision' ? '' : ', lower the thinking/output budget,'} or review a smaller project scope. No incomplete proposal was saved.`,
    );
  const middle = Math.ceil(batch.length / 2);
  queue.unshift(batch.slice(0, middle), batch.slice(middle));
  return true;
}
