import type { AppState, CollectionDraft, CollectionProposal, PlanAction, TabRecord } from './types';

export function renameDraftProject(draft: CollectionDraft, previous: string, value: string) {
  const project = draft.projects.find((entry) => entry.name === previous);
  const name = value.trim();
  if (
    !project ||
    !name ||
    name.length > 80 ||
    draft.projects.some(
      (entry) => entry !== project && entry.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error('Use a unique, nonempty project name.');
  project.name = name;
  for (const assignment of draft.assignments)
    if (assignment.projectName === previous) assignment.projectName = name;
  return project;
}
export function renameDraftCategory(
  draft: CollectionDraft,
  projectName: string,
  previous: string,
  value: string,
) {
  const project = draft.projects.find((entry) => entry.name === projectName);
  const category = project?.categories.find((entry) => entry.name === previous);
  const name = value.trim();
  if (
    !project ||
    !category ||
    !name ||
    name.length > 80 ||
    project.categories.some(
      (entry) => entry !== category && entry.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error('Use a unique, nonempty category name in this project.');
  category.name = name;
  for (const assignment of draft.assignments)
    if (assignment.projectName === projectName && assignment.categoryName === previous)
      assignment.categoryName = name;
  return category;
}

/** Consolidate a reviewed proposal before it creates any native project windows. */
export function mergeDraftProjects(draft: CollectionDraft, sourceName: string, targetName: string) {
  const source = draft.projects.find((project) => project.name === sourceName);
  const target = draft.projects.find((project) => project.name === targetName);
  if (!source || !target || source === target)
    throw new Error('Choose two different projects in this proposal.');
  const renamed = new Map<string, string>();
  for (const category of source.categories) {
    const match = target.categories.find(
      (item) => item.name.toLowerCase() === category.name.toLowerCase(),
    );
    if (!match) {
      target.categories.push({ ...category });
      renamed.set(category.name, category.name);
      continue;
    }
    if (match.description === category.description) {
      renamed.set(category.name, match.name);
      continue;
    }
    const base = `${source.name} · ${category.name}`.slice(0, 72);
    let name = base;
    for (
      let index = 2;
      target.categories.some((item) => item.name.toLowerCase() === name.toLowerCase());
      index++
    )
      name = `${base.slice(0, 75 - String(index).length)} ${index}`;
    target.categories.push({ ...category, name });
    renamed.set(category.name, name);
  }
  for (const assignment of draft.assignments) {
    if (assignment.projectName !== source.name) continue;
    assignment.projectName = target.name;
    assignment.categoryName = renamed.get(assignment.categoryName) || assignment.categoryName;
    if (!draft.ownerAssignedRecordIds?.includes(assignment.recordId))
      draft.ownerAssignedRecordIds = [...(draft.ownerAssignedRecordIds || []), assignment.recordId];
  }
  draft.projects = draft.projects.filter((project) => project !== source);
  return target;
}

export function nativeGroupActions(
  proposal: CollectionProposal,
  app: Pick<AppState, 'records' | 'projects' | 'categories' | 'memberships' | 'groups'> &
    Partial<Pick<AppState, 'windows'>>,
): PlanAction[] {
  const live = new Map(
    app.records
      .filter((record) => record.live && !record.locked && !record.pinned)
      .map((record) => [record.id, record]),
  );
  const buckets = new Map<
    string,
    {
      project: string;
      windowId: number;
      records: TabRecord[];
      color?: chrome.tabGroups.TabGroup['color'];
    }
  >();
  for (const assignment of proposal.assignments) {
    if (proposal.excludedRecordIds?.includes(assignment.recordId)) continue;
    const record = live.get(assignment.recordId);
    if (!record || record.windowId === undefined) continue;
    if (record.url !== assignment.url || record.navigationVersion !== assignment.navigationVersion)
      continue;
    const project = app.projects.find(
      (candidate) => candidate.name.toLowerCase() === assignment.projectName.toLowerCase(),
    );
    const category = app.categories.find(
      (candidate) =>
        candidate.projectId === project?.id &&
        candidate.name.toLowerCase() === assignment.categoryName.toLowerCase(),
    );
    if (
      !project ||
      !category ||
      !app.memberships.some(
        (membership) =>
          membership.recordId === record.id &&
          membership.projectId === project.id &&
          membership.categoryId === category.id,
      )
    )
      continue;
    const nativeName =
      app.windows?.find((window) => window.id === record.windowId)?.projectId === project.id
        ? category.name
        : `${project.name} · ${category.name}`;
    const key = `${assignment.projectName}\u0000${assignment.categoryName}\u0000${record.windowId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        project: nativeName,
        windowId: record.windowId,
        records: [],
        color: category.color,
      };
      buckets.set(key, bucket);
    }
    bucket.records.push(record);
  }
  return [...buckets.values()]
    .filter((bucket) => {
      const targetName = bucket.project.slice(0, 80);
      return !bucket.records.every((record) =>
        app.groups.some(
          (group) =>
            group.id === record.groupId &&
            group.windowId === bucket.windowId &&
            group.title === targetName,
        ),
      );
    })
    .map((bucket) => ({
      type: 'group' as const,
      recordIds: bucket.records.sort((a, b) => a.index - b.index).map((record) => record.id),
      windowId: bucket.windowId,
      name: bucket.project.slice(0, 80),
      color:
        app.groups.find(
          (group) =>
            group.windowId === bucket.windowId && group.title === bucket.project.slice(0, 80),
        )?.color ||
        bucket.color ||
        'grey',
      reason: 'Reviewed collection assignment; grouped within the existing window.',
      confidence: 1,
    }));
}
