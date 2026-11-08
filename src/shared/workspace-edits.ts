import { z } from 'zod';
import type { AppState } from './types';
import { validateTabTree } from './tab-tree';
export const workDraftFields = {
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(1000),
  areaId: z.string().nullable(),
  projectId: z.string().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  dueAt: z.number().int().min(0).nullable().optional(),
  recordId: z.string().min(1).nullable().optional(),
};

export const workspaceStructureSchema = z.object({
  kind: z.literal('structure'),
  area: z
    .object({
      id: z.string().min(1).nullable(),
      name: z.string().trim().min(1).max(80),
      description: z.string().max(1000),
    })
    .nullable(),
  project: z
    .object({
      id: z.string().min(1).nullable(),
      name: z.string().trim().min(1).max(80),
      purpose: z.string().max(1000),
    })
    .nullable(),
  categories: z
    .array(
      z.object({
        id: z.string().min(1).nullable(),
        name: z.string().trim().min(1).max(80),
        description: z.string().max(500),
        color: z.enum([
          'grey',
          'blue',
          'red',
          'yellow',
          'green',
          'pink',
          'purple',
          'cyan',
          'orange',
        ]),
      }),
    )
    .max(100),
  recordIds: z.array(z.string().min(1)).max(1000),
  categoryName: z.string().trim().min(1).max(80).nullable(),
});

export const workspaceEditSchema = z.discriminatedUnion('kind', [
  workspaceStructureSchema,
  z.object({
    kind: z.literal('tab_parent'),
    recordId: z.string().min(1),
    parentRecordId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal('branch_name'),
    recordId: z.string().min(1),
    name: z.string().trim().max(80),
  }),
  z.object({
    kind: z.literal('category_order'),
    projectId: z.string().min(1),
    categoryIds: z.array(z.string().min(1)).max(5000),
  }),
  z.object({ kind: z.literal('delete_category'), categoryId: z.string().min(1) }),
  z.object({
    kind: z.literal('move_category'),
    categoryId: z.string().min(1),
    projectId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('tags'),
    recordId: z.string(),
    mode: z.enum(['add', 'remove', 'replace']),
    tags: z.array(z.string().trim().min(1).max(80)),
  }),
  z.object({ kind: z.literal('note'), recordId: z.string(), note: z.string().max(4000) }),
  z.object({
    kind: z.literal('membership'),
    recordId: z.string(),
    projectId: z.string().nullable(),
    categoryId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('project'),
    projectId: z.string(),
    name: z.string().trim().min(1).max(80),
    purpose: z.string().max(1000),
    areaId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('category'),
    categoryId: z.string().nullable(),
    projectId: z.string(),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500),
    color: z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']),
  }),
  z.object({
    kind: z.literal('work_item'),
    workItemId: z.string(),
    status: z.enum(['open', 'doing', 'waiting', 'done']),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    title: workDraftFields.title.nullable().optional(),
    notes: workDraftFields.notes.nullable().optional(),
    areaId: workDraftFields.areaId.optional(),
    projectId: workDraftFields.projectId.optional(),
    dueAt: workDraftFields.dueAt,
    linkedRecordId: workDraftFields.recordId,
  }),
  z.object({ kind: z.literal('create_work_item'), task: z.object(workDraftFields) }),
]);
export type WorkspaceEdit = z.infer<typeof workspaceEditSchema>;
export const workspaceEditDraftSchema = z.object({
  kind: z.literal('workspace_edits'),
  summary: z.string().trim().min(1).max(1000),
  edits: z
    .array(z.object({ edit: workspaceEditSchema, before: z.string().max(100000) }))
    .min(1)
    .max(1000),
});
export type WorkspaceEditDraft = z.infer<typeof workspaceEditDraftSchema>;

export function workspaceEditBaseline(
  app: Pick<
    AppState,
    'records' | 'memberships' | 'projects' | 'categories' | 'areas' | 'workItems'
  >,
  edit: WorkspaceEdit,
): string {
  if (edit.kind === 'category_order') {
    const categories = app.categories.filter((item) => item.projectId === edit.projectId);
    if (!app.projects.some((item) => item.id === edit.projectId))
      throw new Error('Project no longer exists.');
    if (
      new Set(edit.categoryIds).size !== edit.categoryIds.length ||
      edit.categoryIds.length !== categories.length ||
      categories.some((item) => !edit.categoryIds.includes(item.id))
    )
      throw new Error('Reorder the complete current category list in this project.');
    return JSON.stringify(categories);
  }
  if (edit.kind === 'delete_category' || edit.kind === 'move_category') {
    const category = app.categories.find((item) => item.id === edit.categoryId);
    if (!category) throw new Error('Category no longer exists.');
    const destination =
      edit.kind === 'move_category'
        ? app.projects.find((project) => project.id === edit.projectId)
        : undefined;
    if (edit.kind === 'move_category') {
      if (!destination) throw new Error('Choose an existing destination project.');
      if (destination.id === category.projectId)
        throw new Error('Category is already in that project.');
      if (
        app.categories.some(
          (item) =>
            item.projectId === destination.id &&
            item.name.toLocaleLowerCase() === category.name.toLocaleLowerCase(),
        )
      )
        throw new Error(
          'A category with this name already exists in the destination. Rename it first.',
        );
      if (
        app.records.some(
          (record) =>
            record.locked &&
            app.memberships.some(
              (membership) =>
                membership.recordId === record.id && membership.categoryId === category.id,
            ),
        )
      )
        throw new Error('Remove protection from category tabs before moving the category.');
    }
    return JSON.stringify({
      category,
      memberships: app.memberships.filter((item) => item.categoryId === category.id),
      ...(destination
        ? {
            destination,
            destinationCategories: app.categories.filter(
              (item) => item.projectId === destination.id,
            ),
          }
        : {}),
    });
  }
  if (edit.kind === 'structure') {
    if (!edit.area && !edit.project)
      throw new Error('Provide an area or a project to create/edit.');
    if (!edit.project && (edit.categories.length || edit.recordIds.length || edit.categoryName))
      throw new Error('Categories and assignments need a target project.');
    const area = edit.area?.id ? app.areas.find((item) => item.id === edit.area?.id) : undefined;
    const project = edit.project?.id
      ? app.projects.find((item) => item.id === edit.project?.id)
      : undefined;
    if (edit.area?.id && !area) throw new Error('Unknown area ID.');
    if (edit.project?.id && !project) throw new Error('Unknown project ID.');
    if (
      edit.area &&
      app.areas.some(
        (item) =>
          item.id !== edit.area?.id &&
          item.name.toLocaleLowerCase() === edit.area?.name.toLocaleLowerCase(),
      )
    )
      throw new Error('An area with that name already exists. Use its exact ID.');
    if (
      edit.project &&
      app.projects.some(
        (item) =>
          item.id !== edit.project?.id &&
          item.name.toLocaleLowerCase() === edit.project?.name.toLocaleLowerCase(),
      )
    )
      throw new Error('A project with that name already exists. Use its exact ID.');
    const categories = project
      ? app.categories.filter((item) => item.projectId === project.id)
      : [];
    const names = new Set<string>();
    for (const category of edit.categories) {
      const name = category.name.toLocaleLowerCase();
      if (names.has(name)) throw new Error('Category names must be unique within the project.');
      names.add(name);
      if (category.id && !categories.some((item) => item.id === category.id))
        throw new Error('Unknown category in this project.');
      if (
        categories.some((item) => item.id !== category.id && item.name.toLocaleLowerCase() === name)
      )
        throw new Error('Category already exists. Use its exact ID.');
    }
    if (
      edit.categoryName &&
      !names.has(edit.categoryName.toLocaleLowerCase()) &&
      !categories.some(
        (item) =>
          item.name.toLocaleLowerCase() === edit.categoryName?.toLocaleLowerCase() &&
          !edit.categories.some((next) => next.id === item.id),
      )
    )
      throw new Error(
        'Create the target category in this call, or use an existing category name in this project.',
      );
    if (new Set(edit.recordIds).size !== edit.recordIds.length)
      throw new Error('Assignment IDs must be unique.');
    const records = edit.recordIds.map((id) => {
      const record = app.records.find((item) => item.id === id && item.live && !item.locked);
      if (!record) throw new Error('Use actual unprotected live occurrence IDs.');
      return {
        id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        membership: app.memberships.find((item) => item.recordId === id) || null,
      };
    });
    return JSON.stringify({ area: area || null, project: project || null, categories, records });
  }
  if (edit.kind === 'create_work_item' || edit.kind === 'work_item') {
    const fields = edit.kind === 'create_work_item' ? edit.task : edit;
    if (fields.projectId && !app.projects.some((item) => item.id === fields.projectId))
      throw new Error('Unknown task project.');
    if (fields.areaId && !app.areas.some((item) => item.id === fields.areaId))
      throw new Error('Unknown task area.');
    const recordId = edit.kind === 'create_work_item' ? edit.task.recordId : edit.linkedRecordId;
    if (recordId && !app.records.some((item) => item.id === recordId && item.live && !item.locked))
      throw new Error('Unknown or protected task tab.');
    if (edit.kind === 'create_work_item') {
      const linked = app.records.find((item) => item.id === recordId);
      return JSON.stringify({
        projectId: fields.projectId,
        areaId: fields.areaId,
        record: linked
          ? { id: linked.id, url: linked.url, navigationVersion: linked.navigationVersion }
          : null,
      });
    }
    const item = app.workItems.find((item) => item.id === edit.workItemId);
    if (!item) throw new Error('Unknown work item ID.');
    return JSON.stringify(item);
  }
  if ('recordId' in edit) {
    const record = app.records.find((item) => item.id === edit.recordId && item.live);
    if (!record || record.locked) throw new Error('Use an actual unprotected live occurrence ID.');
    if (edit.kind === 'tab_parent') {
      const parent = app.records.find((item) => item.id === edit.parentRecordId && item.live);
      if (edit.parentRecordId && !parent) throw new Error('Choose an existing live parent tab.');
      validateTabTree(
        app.records.map((item) =>
          item.id === record.id ? { ...item, parentRecordId: edit.parentRecordId } : item,
        ),
      );
      return JSON.stringify({
        url: record.url,
        navigationVersion: record.navigationVersion,
        parentRecordId: record.parentRecordId || null,
        parent: parent
          ? { id: parent.id, url: parent.url, navigationVersion: parent.navigationVersion }
          : null,
      });
    }
    if (edit.kind === 'branch_name')
      return JSON.stringify({
        url: record.url,
        navigationVersion: record.navigationVersion,
        name: record.branchName || '',
      });
    if (edit.kind === 'membership') {
      if (edit.projectId && !app.projects.some((item) => item.id === edit.projectId))
        throw new Error('Unknown project ID.');
      if (
        edit.categoryId &&
        !app.categories.some(
          (item) => item.id === edit.categoryId && item.projectId === edit.projectId,
        )
      )
        throw new Error('Choose a category in the target project.');
    }
    return JSON.stringify({
      url: record.url,
      navigationVersion: record.navigationVersion,
      value:
        edit.kind === 'tags'
          ? record.tags
          : edit.kind === 'note'
            ? record.note
            : app.memberships.find((item) => item.recordId === record.id) || null,
    });
  }
  const project = app.projects.find((item) => item.id === edit.projectId);
  if (!project) throw new Error('Unknown project ID.');
  if (edit.kind === 'project') {
    if (edit.areaId && !app.areas.some((item) => item.id === edit.areaId))
      throw new Error('Unknown area ID.');
    return JSON.stringify(project);
  }
  const category = edit.categoryId
    ? app.categories.find(
        (item) => item.id === edit.categoryId && item.projectId === edit.projectId,
      )
    : null;
  if (edit.categoryId && !category) throw new Error('Unknown category in the target project.');
  return JSON.stringify({ projectRevision: project.revision, category });
}

export function workspaceEditLabel(edit: WorkspaceEdit): string {
  if (edit.kind === 'tab_parent')
    return edit.parentRecordId ? 'Nest tab in a branch' : 'Detach tab from its branch';
  if (edit.kind === 'branch_name') return `Name tab branch: ${edit.name || '(use page title)'}`;
  if (edit.kind === 'category_order') return 'Reorder project categories';
  if (edit.kind === 'move_category')
    return `Move category ${edit.categoryId} to project ${edit.projectId}`;
  if (edit.kind === 'delete_category')
    return 'Delete category; retain its tabs in the same project as uncategorized';
  if (edit.kind === 'structure')
    return `${edit.area ? `${edit.area.id ? 'Update' : 'Create'} area ${edit.area.name}; ` : ''}${edit.project ? `${edit.project.id ? 'Update' : 'Create'} project ${edit.project.name}; ${edit.categories.length} categories; ${edit.recordIds.length} tab assignments${edit.categoryName ? ` to ${edit.categoryName}` : ''}` : ''}`;

  if (edit.kind === 'create_work_item')
    return `Create task: ${edit.task.title}${edit.task.dueAt ? ` · Due ${new Date(edit.task.dueAt).toLocaleString()}` : ''}`;
  return edit.kind === 'tags'
    ? `${edit.mode} tags: ${edit.tags.join(', ') || '(clear)'}`
    : edit.kind === 'note'
      ? `Set note: ${edit.note || '(clear)'}`
      : edit.kind === 'membership'
        ? 'Change project/category assignment'
        : edit.kind === 'project'
          ? `Update project: ${edit.name}: ${edit.purpose}`
          : edit.kind === 'category'
            ? `${edit.categoryId ? 'Update' : 'Create'} category: ${edit.name}: ${edit.description} (${edit.color})`
            : `Set work item: ${edit.title || ''} ${edit.status}, ${edit.priority}${edit.dueAt !== undefined ? ` · Due ${edit.dueAt === null ? 'none' : new Date(edit.dueAt).toLocaleString()}` : ''}${edit.notes !== undefined ? ` · ${edit.notes}` : ''}`;
}
export function workspaceEditRecordIds(
  edit: WorkspaceEdit,
  app?: Pick<AppState, 'memberships'>,
): string[] {
  if (edit.kind === 'delete_category' || edit.kind === 'move_category')
    return (
      app?.memberships
        .filter((item) => item.categoryId === edit.categoryId)
        .map((item) => item.recordId) || []
    );
  if (edit.kind === 'structure') return edit.recordIds;
  if ('recordId' in edit) return [edit.recordId];
  const id =
    edit.kind === 'create_work_item'
      ? edit.task.recordId
      : edit.kind === 'work_item'
        ? edit.linkedRecordId
        : undefined;
  return id ? [id] : [];
}
