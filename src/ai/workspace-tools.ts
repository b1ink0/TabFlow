import { z } from 'zod';
import { reviewTool } from './review-tool';
import type { AppState } from '../shared/types';
import type { AssistantCommand } from '../shared/assistant';
import {
  workspaceEditSchema,
  workspaceStructureSchema,
  workspaceEditBaseline,
  workDraftFields,
  type WorkspaceEdit,
} from '../shared/workspace-edits';
import { attachmentCatalog, resolveAttachments } from '../shared/assistant-context';
import { tagHash } from '../shared/tag-analysis';
import { tabAncestors } from '../shared/tab-tree';
import { context } from './context';

export function workspaceReviewTools(
  app: AppState,
  prepare: (command: AssistantCommand) => void,
  history?: (offset: number) => Promise<import('../shared/assistant-actions').AssistantChange[]>,
) {
  const knownChanges = new Map(app.assistantChanges?.map((item) => [item.id, item]));
  const scope = (ids: string[], inspection = false) => {
    const unique = [...new Set(ids)];
    const records = unique.map((id) =>
      app.records.find((record) => record.id === id && record.live),
    );
    if (records.some((record) => !record || (inspection && record.locked)))
      throw new Error(
        `Use actual live occurrence IDs; inspection excludes protected tabs. Invalid IDs: ${unique.filter((_, index) => !records[index]).join(', ') || 'none'}. Protected IDs: ${
          records
            .filter((record) => inspection && record?.locked)
            .map((record) => record!.id)
            .join(', ') || 'none'
        }. Call list_tabs first; use its exact returned occurrence IDs. Known titles and URLs are readable without waking.`,
      );
    return {
      recordIds: unique,
      expected: Object.fromEntries(
        records.map((record) => [
          record!.id,
          { url: record!.url, navigationVersion: record!.navigationVersion },
        ]),
      ),
    };
  };
  return [
    reviewTool({
      name: 'prepare_work_items',
      description:
        'Prepare several new tasks together for review and Undo. Use actual project/area/tab IDs. dueAt is Unix milliseconds for an explicitly requested date in the owner time zone; null means no date. Ask when ambiguous. This saves dated tasks, not OS reminders. Existing task fields are editable using prepare_workspace_edits with kind work_item.',
      parameters: z.object({ tasks: z.array(z.object(workDraftFields)).min(1).max(100) }),
      function: ({ tasks }) => {
        const edits: WorkspaceEdit[] = tasks.map((task) => ({ kind: 'create_work_item', task }));
        prepare({
          kind: 'workspace_edits',
          summary: `Create ${tasks.length} tasks`,
          edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
        });
        return JSON.stringify({ awaitingOwnerReview: true, applied: false, tasks: tasks.length });
      },
    }),
    reviewTool({
      name: 'read_tab_metadata',
      description:
        'Read complete accepted tab metadata in pages. Use for exact edits when summaries truncate tags, notes, title or URL. Does not wake tabs. offset indexes tags for tags, characters otherwise. Retain the returned revision and restart if it changes between pages.',
      parameters: z.object({
        recordId: z.string(),
        field: z.enum(['tags', 'note', 'title', 'url']),
        offset: z.number().int().min(0).max(100000),
      }),
      function: async ({ recordId, field, offset }) => {
        const record = app.records.find((item) => item.id === recordId && item.live);
        if (!record) throw new Error('Use an actual live tab occurrence ID.');
        const value = record[field];
        const limit = field === 'tags' ? 20 : 2000;
        return JSON.stringify({
          recordId,
          field,
          value: value.slice(offset, offset + limit),
          total: value.length,
          nextOffset: offset + limit < value.length ? offset + limit : null,
          revision: await tagHash({
            url: record.url,
            navigationVersion: record.navigationVersion,
            value,
          }),
        });
      },
    }),
    reviewTool({
      name: 'prepare_tab_organization',
      description:
        'Organize existing live tabs directly, including tabs outside every proposal. Batch-change their accepted project/category or Inbox, add/remove tags and optionally set notes in one reviewed action. membership=null preserves assignments; projectId=null means Inbox. note=null preserves notes. Use actual tab/project/category IDs. Preserves unrelated tags and does not move or wake browser tabs.',
      parameters: z.object({
        recordIds: z.array(z.string()).min(1).max(1000),
        membership: z
          .object({ projectId: z.string().nullable(), categoryId: z.string().nullable() })
          .nullable(),
        addTags: z.array(z.string().trim().min(1).max(80)).max(20),
        removeTags: z.array(z.string().trim().min(1).max(80)).max(20),
        note: z.string().max(4000).nullable(),
      }),
      function: ({ recordIds, membership, addTags, removeTags, note }) => {
        const ids = scope(recordIds).recordIds;
        const edits: WorkspaceEdit[] = [];
        for (const id of ids) {
          if (membership) edits.push({ kind: 'membership', recordId: id, ...membership });
          if (removeTags.length)
            edits.push({ kind: 'tags', recordId: id, mode: 'remove', tags: removeTags });
          if (addTags.length)
            edits.push({ kind: 'tags', recordId: id, mode: 'add', tags: addTags });
          if (note !== null) edits.push({ kind: 'note', recordId: id, note });
        }
        if (!edits.length || edits.length > 1000)
          throw new Error(
            'Choose at least one change and at most 1000 edits per action. Split larger combined changes into smaller batches.',
          );
        const draft = {
          kind: 'workspace_edits' as const,
          summary: `Organize ${ids.length} existing tabs`,
          edits: edits.map((edit) => ({
            edit: workspaceEditSchema.parse(edit),
            before: workspaceEditBaseline(app, edit),
          })),
        };
        prepare(draft);
        return JSON.stringify({
          awaitingOwnerReview: true,
          applied: false,
          occurrences: ids.length,
          edits: edits.length,
          browserPlacementChanged: false,
        });
      },
    }),
    reviewTool({
      name: 'prepare_project_consolidation',
      description:
        'Move live unprotected memberships from one accepted project into another in a reviewed, undoable metadata action. Map each source category explicitly to an existing target category or null. Uncategorised source tabs stay uncategorised in the target. The source project is retained; no categories/projects/tabs are deleted and browser placement is unchanged.',
      parameters: z.object({
        sourceProjectId: z.string(),
        targetProjectId: z.string(),
        categoryMappings: z
          .array(
            z.object({ sourceCategoryId: z.string(), targetCategoryId: z.string().nullable() }),
          )
          .max(1000),
      }),
      function: ({ sourceProjectId, targetProjectId, categoryMappings }) => {
        if (
          sourceProjectId === targetProjectId ||
          ![sourceProjectId, targetProjectId].every((id) =>
            app.projects.some((item) => item.id === id),
          )
        )
          throw new Error('Choose two different accepted project IDs.');
        if (
          new Set(categoryMappings.map((item) => item.sourceCategoryId)).size !==
          categoryMappings.length
        )
          throw new Error('Map each source category only once.');
        for (const mapping of categoryMappings) {
          if (
            !app.categories.some(
              (item) => item.id === mapping.sourceCategoryId && item.projectId === sourceProjectId,
            ) ||
            (mapping.targetCategoryId &&
              !app.categories.some(
                (item) =>
                  item.id === mapping.targetCategoryId && item.projectId === targetProjectId,
              ))
          )
            throw new Error(
              'Category mapping must use real IDs in the source and target projects.',
            );
        }
        const candidates = app.memberships.filter((item) => item.projectId === sourceProjectId);
        const members = candidates.filter((item) =>
          app.records.some(
            (record) => record.id === item.recordId && record.live && !record.locked,
          ),
        );
        const edits: WorkspaceEdit[] = members.map((item) => {
          const mapping = categoryMappings.find(
            (mapping) => mapping.sourceCategoryId === item.categoryId,
          );
          if (item.categoryId && !mapping)
            throw new Error(
              `No mapping for category ${item.categoryId}. Read both projects and provide a target category or explicit null.`,
            );
          return {
            kind: 'membership',
            recordId: item.recordId,
            projectId: targetProjectId,
            categoryId: mapping?.targetCategoryId || null,
          };
        });
        if (!edits.length) throw new Error('The source has no eligible live tab memberships.');
        prepare({
          kind: 'workspace_edits',
          summary: `Consolidate ${edits.length} tab memberships into the target project`,
          edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
        });
        return JSON.stringify({
          applied: false,
          awaitingOwnerReview: true,
          occurrences: edits.length,
          skippedClosedOrProtected: candidates.length - members.length,
          sourceProjectRetained: true,
        });
      },
    }),
    reviewTool({
      name: 'prepare_tag_maintenance',
      description:
        'Rename/combine or remove a tag on existing live tabs, independently of proposals and categories. recordIds=[] targets all live tabs bearing sourceTag; locked tabs are reported as skipped. Other tags and memberships are retained. Does not rewrite pending proposals or remove catalog/history entries. Prepares an action for approval and Undo.',
      parameters: z.object({
        action: z.enum(['rename_or_merge', 'remove']),
        sourceTag: z.string().trim().min(1).max(80),
        targetTag: z.string().trim().min(1).max(80).nullable(),
        recordIds: z.array(z.string()).max(1000),
      }),
      function: ({ action, sourceTag, targetTag, recordIds }) => {
        if (action === 'rename_or_merge' && !targetTag)
          throw new Error('A tag rename needs a target tag.');
        if (recordIds.length) scope(recordIds);
        const records = app.records.filter(
          (item) =>
            item.live &&
            (!recordIds.length || recordIds.includes(item.id)) &&
            item.tags.some((tag) => tag.toLowerCase() === sourceTag.toLowerCase()),
        );
        const edits: WorkspaceEdit[] = records
          .filter((item) => !item.locked)
          .map((record) => ({
            kind: 'tags',
            recordId: record.id,
            mode: 'replace',
            tags: [
              ...new Set([
                ...record.tags.filter((tag) => tag.toLowerCase() !== sourceTag.toLowerCase()),
                ...(action === 'rename_or_merge' && targetTag ? [targetTag] : []),
              ]),
            ],
          }));
        if (!edits.length)
          throw new Error('No eligible live tabs carry that tag. No action was prepared.');
        prepare({
          kind: 'workspace_edits',
          summary: `${action === 'remove' ? 'Remove' : 'Rename/merge'} tag ${sourceTag}${targetTag && action !== 'remove' ? ` to ${targetTag}` : ''}`,
          edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
        });
        return JSON.stringify({
          applied: false,
          awaitingOwnerReview: true,
          occurrences: edits.length,
          skippedProtected: records.length - edits.length,
        });
      },
    }),
    reviewTool({
      name: 'search_workspace_entities',
      description:
        'Find actual tab, project, category, window and tag IDs by name, URL or ID. Paginated, read-only. Use returned IDs to resolve scope; duplicate titles are separate occurrences.',
      parameters: z.object({
        query: z.string().max(200),
        kind: z.enum(['all', 'tab', 'project', 'category', 'window', 'tag', 'proposal']),
        offset: z.number().int().min(0).max(100000),
      }),
      function: ({ query, kind, offset }) => {
        const words = query.toLowerCase().trim().split(/\s+/);
        const matches = attachmentCatalog(app).filter(
          (item) =>
            (kind === 'all' || kind === item.kind) &&
            words.every((word) =>
              `${item.label} ${item.id} ${item.kind === 'tab' ? app.records.find((record) => record.id === item.id)?.url : ''}`
                .toLowerCase()
                .includes(word),
            ),
        );
        return JSON.stringify({
          total: matches.length,
          entities: matches.slice(offset, offset + 30).map((item) => ({
            ...item,
            label: item.label.slice(0, 500),
            truncated: item.label.length > 500,
          })),
          nextOffset: offset + 30 < matches.length ? offset + 30 : null,
        });
      },
    }),
    reviewTool({
      name: 'read_entity_tabs',
      description:
        'Read exact tab occurrence IDs in a project, category, native window or tag. Read-only, paginated; never wakes pages. Useful for regrouping and finding candidates for a project.',
      parameters: z.object({
        kind: z.enum(['project', 'category', 'window', 'tag']),
        id: z.string(),
        offset: z.number().int().min(0).max(100000),
      }),
      function: ({ kind, id, offset }) => {
        const ids = resolveAttachments(app, [{ kind, id, label: id }]);
        return JSON.stringify({
          total: ids.length,
          tabs: ids.slice(offset, offset + 30).map((id) => {
            const record = app.records.find((record) => record.id === id)!;
            return {
              id,
              title: record.title.slice(0, 500),
              parentRecordId: record.parentRecordId || null,
              openerRecordId: record.openerRecordId || null,
              branchName: record.branchName || '',
              url: record.url.slice(0, 2000),
              tags: record.tags.slice(0, 20),
              note: record.note.slice(0, 500),
              truncated:
                record.title.length > 500 ||
                record.url.length > 2000 ||
                record.tags.length > 20 ||
                record.note.length > 500,
              locked: record.locked,
              membership: app.memberships.find((item) => item.recordId === id) || null,
            };
          }),
          nextOffset: offset + 30 < ids.length ? offset + 30 : null,
        });
      },
    }),
    reviewTool({
      name: 'read_tab_branch',
      description:
        'Read a parent tab and its exact live descendants across projects, categories and windows. Paginated, read-only; does not wake pages or expand mutation scope. Use returned parentRecordId and branchName for explicit nesting edits.',
      parameters: z.object({
        recordId: z.string().min(1),
        offset: z.number().int().min(0).max(100000),
      }),
      function: ({ recordId, offset }) => {
        if (!app.records.some((record) => record.id === recordId && record.live))
          throw new Error('Read an actual live parent occurrence ID first.');
        const records = app.records.filter(
          (record) =>
            record.live &&
            (record.id === recordId || tabAncestors(record.id, app.records).includes(recordId)),
        );
        return JSON.stringify({
          total: records.length,
          offset,
          nextOffset: offset + 30 < records.length ? offset + 30 : null,
          tabs: context(app, records.slice(offset, offset + 30), false).tabs,
        });
      },
    }),
    reviewTool({
      name: 'prepare_workspace_structure',
      description:
        'Prepare atomic accepted-workspace area/project/category creation or editing plus tab assignments. IDs null CREATE entities; existing IDs EDIT exact entities. New IDs are allocated inside the reviewed transaction. area=null preserves an existing project area or leaves a new project without an area. project=null permits area-only creation/editing. categories may be created in the same call and categoryName references their name; null assigns tabs uncategorized. recordIds=[] changes structure only. This is accepted workspace data, not a pending organization proposal. One approval, one Undo/Redo history entry; no native browser changes.',
      parameters: workspaceStructureSchema.omit({ kind: true }),
      function: (fields) => {
        const edit = workspaceStructureSchema.parse({ kind: 'structure', ...fields });
        const draft = {
          kind: 'workspace_edits' as const,
          summary: `${edit.project ? `Organize ${edit.project.name}` : `Save area ${edit.area?.name || ''}`}`,
          edits: [{ edit, before: workspaceEditBaseline(app, edit) }],
        };
        prepare(draft);
        return JSON.stringify({
          awaitingOwnerReview: true,
          applied: false,
          assignments: edit.recordIds.length,
          categories: edit.categories.length,
        });
      },
    }),
    reviewTool({
      name: 'prepare_workspace_edits',
      description:
        'Draft direct edits to accepted workspace data: add/remove/replace tags, set tab notes, assign individual tabs to existing projects/categories or Inbox, rename/update projects, create/update categories and colors, delete_category to remove a category while retaining its tabs in the same project uncategorized, update work status/priority. Can classify into existing categories yourself when explicitly asked. Include different edits together. Add tags preserves other tags; replace/clear only when requested. Read targets first. Review only; no native grouping, navigation or browser-tab deletion.',
      parameters: z.object({
        summary: z.string().min(1).max(1000),
        edits: z.array(workspaceEditSchema).min(1).max(1000),
      }),
      function: ({ summary, edits }) => {
        const draft = {
          kind: 'workspace_edits' as const,
          summary,
          edits: edits.map((edit) => ({ edit, before: workspaceEditBaseline(app, edit) })),
        };
        prepare(draft);
        return JSON.stringify({
          awaitingOwnerReview: true,
          applied: false,
          edits: edits.length,
          summary,
        });
      },
    }),
    reviewTool({
      name: 'prepare_page_inspection',
      description:
        'Propose bounded inspection of at most twenty ambiguous pages. Owner approval grants access; suspended pages are inspected one at a time. This only prepares a review action.',
      parameters: z.object({ recordIds: z.array(z.string()).min(1).max(20) }),
      function: ({ recordIds }) => {
        prepare({ kind: 'inspect', ...scope(recordIds, true) });
        return JSON.stringify({
          awaitingOwnerReview: true,
          queued: false,
          occurrences: recordIds.length,
        });
      },
    }),
    reviewTool({
      name: 'read_inspection_status',
      description:
        'Read actual inspection job results/errors; completed cache can then be read using read_tab_evidence.',
      parameters: z.object({ jobId: z.string() }),
      function: ({ jobId }) => {
        const job = app.jobs.find((entry) => entry.id === jobId);
        if (!job) throw new Error('Inspection job not found.');
        return JSON.stringify(job);
      },
    }),
    reviewTool({
      name: 'prepare_membership_correction',
      description:
        'Propose an explicit owner correction to an existing project/category for actual occurrences. It will be remembered and protected from AI reclassification after Apply. No browser movement.',
      parameters: z.object({
        recordIds: z.array(z.string()).min(1).max(1000),
        projectId: z.string(),
        categoryId: z.string().nullable(),
      }),
      function: ({ recordIds, projectId, categoryId }) => {
        if (!app.projects.some((project) => project.id === projectId))
          throw new Error('Use an actual project ID.');
        if (
          categoryId &&
          !app.categories.some(
            (category) => category.id === categoryId && category.projectId === projectId,
          )
        )
          throw new Error('Use a category in that project or null.');
        prepare({ kind: 'assign', projectId, categoryId, ...scope(recordIds) });
        return JSON.stringify({
          awaitingOwnerReview: true,
          applied: false,
          occurrences: recordIds.length,
        });
      },
    }),
    reviewTool({
      name: 'prepare_recovery_action',
      description:
        'Prepare an explicitly requested snapshot, operation undo/redo, assistant change undo/redo, or snapshot arrangement restore. Must use actual history IDs. Only prepares review; never executes.',
      parameters: z.object({
        action: z.enum(['snapshot', 'undo', 'redo', 'restore', 'undo_assistant', 'redo_assistant']),
        id: z.string().nullable(),
        label: z.string().max(200),
      }),
      function: ({ action, id, label }) => {
        if (action === 'snapshot') {
          if (!label.trim()) throw new Error('Name the snapshot.');
          prepare({ kind: 'snapshot', label: label.trim() });
        } else if (action === 'redo_assistant') {
          if (
            !id ||
            ![...knownChanges.values()].some(
              (item) => item.id === id && !item.archived && item.status === 'undone',
            )
          )
            throw new Error('Use an undone assistant change ID from read_recovery_history.');
          prepare({ kind: 'redo_assistant', changeId: id });
        } else if (action === 'redo') {
          if (!id || !app.operations.some((item) => item.id === id && item.canRedo))
            throw new Error('Use an operation with an available Redo checkpoint.');
          prepare({ kind: 'redo', operationId: id });
        } else if (action === 'undo_assistant') {
          if (
            !id ||
            ![...knownChanges.values()].some(
              (item) => item.id === id && !item.archived && item.status !== 'undone',
            )
          )
            throw new Error('Use an actual assistant change ID from read_recovery_history.');
          prepare({ kind: 'undo_assistant', changeId: id });
        } else if (action === 'undo') {
          if (
            !id ||
            !app.operations.some(
              (operation) => operation.id === id && operation.status !== 'undone',
            )
          )
            throw new Error('Use an actual available operation ID.');
          prepare({ kind: 'undo', operationId: id });
        } else {
          if (!id || !app.snapshots.some((snapshot) => snapshot.id === id))
            throw new Error('Use an actual snapshot ID.');
          prepare({ kind: 'restore', snapshotId: id });
        }
        return JSON.stringify({ awaitingOwnerReview: true, executed: false, action, id });
      },
    }),
    reviewTool({
      name: 'read_recovery_history',
      description:
        'Read actual operation IDs, partial results and available snapshot IDs before proposing recovery.',
      parameters: z.object({ offset: z.number().int().min(0).max(100000) }),
      function: async ({ offset }) => {
        const changes = history
          ? await history(offset)
          : (app.assistantChanges || []).slice(offset, offset + 21);
        for (const item of changes) knownChanges.set(item.id, item);
        return JSON.stringify({
          assistantChanges: changes
            .slice(0, 20)
            .map(({ id, summary, status, outcome, operationId, deltaCount, archived }) => ({
              id,
              summary,
              status,
              outcome,
              operationId,
              changedValues: deltaCount,
              archived,
            })),
          operations: app.operations.slice(offset, offset + 20).map((operation) => ({
            id: operation.id,
            snapshotId: operation.snapshotId,
            collectionProposalId: operation.collectionProposalId,
            summary: operation.summary,
            createdAt: operation.createdAt,
            status: operation.status,
            kind: operation.kind,
            canRedo: Boolean(operation.canRedo),
            copyProgress:
              operation.kind === 'collection-copy'
                ? (() => {
                    const proposal = app.collectionProposals.find(
                      (entry) => entry.id === operation.collectionProposalId,
                    );
                    return {
                      windows: proposal?.copyState?.windows,
                      created: proposal?.copyState?.entries.filter((entry) => entry.created).length,
                      total: proposal?.copyState?.entries.length,
                      errors: proposal?.copyState?.entries
                        .filter((entry) => entry.error)
                        .slice(0, 5)
                        .map((entry) => entry.error),
                      originalsRetained: true,
                    };
                  })()
                : undefined,
            actionCount: operation.actionCount,
            affectedOccurrences: operation.affectedOccurrences,
            successfulActions: operation.successfulActions,
            failedActions: operation.failedActions,
            errors: operation.errors,
          })),
          operationCount: app.operations.length,
          snapshots: app.snapshots.slice(offset, offset + 20).map((snapshot) => ({
            id: snapshot.id,
            label: snapshot.label,
            createdAt: snapshot.createdAt,
            windows: snapshot.windowCount,
            tabs: snapshot.tabCount,
          })),
          snapshotCount: app.snapshots.length,
          nextOffset:
            changes.length > 20 ||
            offset + 20 < Math.max(app.operations.length, app.snapshots.length)
              ? offset + 20
              : null,
        });
      },
    }),
  ];
}
