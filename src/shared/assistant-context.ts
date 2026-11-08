import { z } from 'zod';
import type { AppState } from './types';

export const attachmentSchema = z.object({
  kind: z.enum(['tab', 'window', 'project', 'category', 'tag', 'proposal', 'selection']),
  id: z.string().min(1).max(10000),
  label: z.string().max(10000),
  recordIds: z.array(z.string().min(1)).max(10000).optional(),
});
export type AssistantAttachment = z.infer<typeof attachmentSchema>;

function* catalogEntries(app: AppState): Generator<AssistantAttachment> {
  for (const item of app.collectionProposals)
    yield {
      kind: 'proposal',
      id: item.id,
      label: `${item.name || item.summary || 'Organization'} (${item.status})`,
    };
  for (const item of app.projects) yield { kind: 'project', id: item.id, label: item.name };
  const projects = new Map(app.projects.map((item) => [item.id, item.name]));
  for (const item of app.categories)
    yield {
      kind: 'category',
      id: item.id,
      label: `${projects.get(item.projectId) || 'Project'} / ${item.name}`,
    };
  for (const item of app.windows)
    yield { kind: 'window', id: String(item.id), label: `Window ${item.id}` };
  const tags = new Set<string>();
  for (const tag of app.tagVocabulary || []) tags.add(tag);
  for (const item of app.records) for (const tag of item.tags) tags.add(tag);
  for (const tag of tags) yield { kind: 'tag', id: tag, label: tag };
  for (const item of app.records)
    if (item.live) yield { kind: 'tab', id: item.id, label: item.title || item.url };
}
export function attachmentCatalog(app: AppState): AssistantAttachment[] {
  return [...catalogEntries(app)];
}
export function searchAttachments(app: AppState, query: string, offset = 0, limit = 50) {
  const needle = query.trim().toLocaleLowerCase();
  const records = new Map(app.records.map((item) => [item.id, item]));
  const items: AssistantAttachment[] = [];
  let skipped = 0;
  for (const item of catalogEntries(app)) {
    const url = item.kind === 'tab' ? records.get(item.id)?.url || '' : '';
    if (
      needle &&
      !`${item.kind} ${item.label} ${item.id} ${url}`.toLocaleLowerCase().includes(needle)
    )
      continue;
    if (skipped++ < Math.max(0, offset)) continue;
    items.push(item);
    if (items.length > limit) break;
  }
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}

/** Resolve once when sending; later tabs joining a window/tag must not expand a saved request. */
export function resolveAttachments(app: AppState, input: AssistantAttachment[]): string[] {
  const attachments = z.array(attachmentSchema).max(100).parse(input);
  const catalog = attachmentCatalog(app);
  const ids = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.kind === 'selection') {
      if (!attachment.recordIds?.length) throw new Error('Attached selection is empty.');
      for (const id of attachment.recordIds) {
        if (!app.records.some((item) => item.id === id && item.live))
          throw new Error('An attached selected tab is no longer open.');
        ids.add(id);
      }
      continue;
    }
    if (!catalog.some((item) => item.kind === attachment.kind && item.id === attachment.id))
      throw new Error(`Attached ${attachment.kind} is no longer available: ${attachment.label}`);
    for (const record of app.records.filter((item) => item.live)) {
      const membership = app.memberships.find((item) => item.recordId === record.id);
      const matches =
        attachment.kind === 'tab'
          ? record.id === attachment.id
          : attachment.kind === 'window'
            ? String(record.windowId) === attachment.id
            : attachment.kind === 'tag'
              ? record.tags.includes(attachment.id)
              : attachment.kind === 'project'
                ? (membership ? membership.projectId : record.projectId) === attachment.id
                : attachment.kind === 'category'
                  ? membership?.categoryId === attachment.id
                  : (() => {
                      const proposal = app.collectionProposals.find(
                        (item) => item.id === attachment.id,
                      );
                      return (
                        proposal?.scopeRecordIds || [
                          ...(proposal?.assignments.map((item) => item.recordId) || []),
                          ...(proposal?.unresolvedRecordIds || []),
                        ]
                      ).includes(record.id);
                    })();
      if (matches) ids.add(record.id);
    }
  }
  return [...ids];
}
