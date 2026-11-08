import type { CollectionDraft, CollectionProposal } from './types';
import { canonicalTags } from './tag-analysis';

export function editableProposal(proposal: CollectionDraft): CollectionDraft {
  return {
    excludedRecordIds: proposal.excludedRecordIds ? [...proposal.excludedRecordIds] : undefined,
    summary: proposal.summary,
    name: proposal.name,
    model: proposal.model,
    scopeRecordIds: proposal.scopeRecordIds ? [...proposal.scopeRecordIds] : undefined,
    sourceJobIds: proposal.sourceJobIds ? [...proposal.sourceJobIds] : undefined,
    projects: proposal.projects.map((item) => ({
      ...item,
      categories: item.categories.map((category) => ({ ...category })),
    })),
    assignments: proposal.assignments.map((item) => ({
      ...item,
      suggestedTags: item.suggestedTags ? [...item.suggestedTags] : undefined,
    })),
    unresolvedRecordIds: [...proposal.unresolvedRecordIds],
    unresolvedTagSuggestions: proposal.unresolvedTagSuggestions?.map((item) => ({
      ...item,
      suggestedTags: [...item.suggestedTags],
    })),
    ownerAssignedRecordIds: proposal.ownerAssignedRecordIds
      ? [...proposal.ownerAssignedRecordIds]
      : undefined,
    tagReview: proposal.tagReview?.map((item) => ({
      ...item,
      tags: item.tags.map((tag) => ({ ...tag })),
    })),
    decisionContract: proposal.decisionContract,
    legacyCategoriesRetained: proposal.legacyCategoriesRetained,
  };
}
export const proposalScopeIds = (proposal: CollectionDraft) =>
  proposal.scopeRecordIds || [
    ...proposal.assignments.map((item) => item.recordId),
    ...proposal.unresolvedRecordIds,
  ];
/** Exclusion retains saved decisions for restoration, but omits all effects when applied. */
export function setDraftExclusions(draft: CollectionDraft, recordIds: string[], excluded: boolean) {
  const scope = new Set(proposalScopeIds(draft));
  if (!recordIds.length || recordIds.some((id) => !scope.has(id)))
    throw new Error('Use occurrence IDs from this proposal scope.');
  const ids = new Set(draft.excludedRecordIds || []);
  for (const id of recordIds) {
    if (excluded) ids.add(id);
    else ids.delete(id);
  }
  draft.excludedRecordIds = [...ids];
}
export const activeProposalScopeIds = (proposal: CollectionDraft) =>
  proposalScopeIds(proposal).filter((id) => !proposal.excludedRecordIds?.includes(id));
const equalName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function combinedTags(left: string[] = [], right: string[] = []) {
  return canonicalTags([...left, ...right]);
}
export function mergeProposalDrafts(
  target: CollectionProposal,
  source: CollectionProposal,
  projectNames: string[],
  conflict: 'keep_target' | 'use_source',
) {
  if (target.id === source.id) throw new Error('Choose different source and target proposal IDs.');
  if (
    target.status !== 'pending' ||
    target.copyState ||
    (source.copyState && source.status === 'pending')
  )
    throw new Error(
      'The target must be pending and neither proposal may have window creation in progress.',
    );
  const selected = projectNames.length
    ? source.projects.filter((item) => projectNames.includes(item.name))
    : source.projects;
  if (
    new Set(projectNames).size !== projectNames.length ||
    selected.length !== (projectNames.length || source.projects.length)
  )
    throw new Error(
      'Use exact project names from the source proposal; [] imports all projects and uncertain tabs.',
    );
  const draft = editableProposal(target);
  const mapped = new Map<string, { projectName: string; categoryName: string }>();
  for (const incoming of selected) {
    let project = draft.projects.find((item) => equalName(item.name, incoming.name));
    if (!project) {
      project = { ...incoming, categories: [] };
      draft.projects.push(project);
    }
    for (const category of incoming.categories) {
      const match = project.categories.find((item) => equalName(item.name, category.name));
      let name = match?.name || category.name;
      if (match && match.description !== category.description) {
        const base = `${incoming.name} · ${category.name}`.slice(0, 72);
        const compatible = project.categories.find(
          (item) =>
            (item.name === base || item.name.startsWith(`${base} `)) &&
            item.description === category.description,
        );
        name = compatible?.name || base;
        for (
          let index = 2;
          !compatible && project.categories.some((item) => equalName(item.name, name));
          index++
        )
          name = `${base} ${index}`.slice(0, 80);
      }
      if (!project.categories.some((item) => equalName(item.name, name)))
        project.categories.push({ ...category, name });
      mapped.set(`${incoming.name.toLowerCase()}\0${category.name.toLowerCase()}`, {
        projectName: project.name,
        categoryName: name,
      });
    }
  }
  const scope = new Set(proposalScopeIds(target));
  const assignments = new Map(draft.assignments.map((item) => [item.recordId, item]));
  const unresolved = new Set(draft.unresolvedRecordIds);
  const independent = new Map(
    (draft.unresolvedTagSuggestions || []).map((item) => [item.recordId, item]),
  );
  const reviewed = new Set(draft.ownerAssignedRecordIds || []);
  let conflicts = 0;
  const sourceOwner = new Set(source.ownerAssignedRecordIds || []);
  for (const item of source.assignments) {
    const placement = mapped.get(
      `${item.projectName.toLowerCase()}\0${item.categoryName.toLowerCase()}`,
    );
    if (!placement) continue;
    const existing = assignments.get(item.recordId);
    const tags = independent.get(item.recordId);
    if (
      (existing &&
        (existing.url !== item.url || existing.navigationVersion !== item.navigationVersion)) ||
      (tags && (tags.url !== item.url || tags.navigationVersion !== item.navigationVersion))
    )
      throw new Error(
        'The proposals contain different page versions for the same occurrence. Sync them before merging.',
      );
    const differs =
      existing &&
      (existing.projectName !== placement.projectName ||
        existing.categoryName !== placement.categoryName);
    if (differs) conflicts++;
    const suggestedTags = combinedTags(
      existing?.suggestedTags || tags?.suggestedTags,
      item.suggestedTags,
    );
    if (!existing || conflict === 'use_source') {
      assignments.set(item.recordId, { ...item, ...placement, suggestedTags });
      if (sourceOwner.has(item.recordId)) reviewed.add(item.recordId);
    } else existing.suggestedTags = suggestedTags;
    scope.add(item.recordId);
    unresolved.delete(item.recordId);
    independent.delete(item.recordId);
  }
  if (!projectNames.length) {
    for (const id of source.unresolvedRecordIds) {
      scope.add(id);
      if (!assignments.has(id)) unresolved.add(id);
    }
    for (const item of source.unresolvedTagSuggestions || []) {
      const existing = assignments.get(item.recordId) || independent.get(item.recordId);
      if (
        existing &&
        (existing.url !== item.url || existing.navigationVersion !== item.navigationVersion)
      )
        throw new Error(
          'Independent tag suggestions reference different page versions. Sync before merging.',
        );
      const suggestedTags = combinedTags(existing?.suggestedTags, item.suggestedTags);
      if (assignments.has(item.recordId))
        assignments.get(item.recordId)!.suggestedTags = suggestedTags;
      else independent.set(item.recordId, { ...item, suggestedTags });
    }
  }
  const previousScope = new Set(proposalScopeIds(target));
  draft.excludedRecordIds = [
    ...new Set([
      ...(draft.excludedRecordIds || []),
      ...(source.excludedRecordIds || []).filter((id) => scope.has(id) && !previousScope.has(id)),
    ]),
  ];
  draft.assignments = [...assignments.values()];
  draft.unresolvedRecordIds = [...unresolved];
  draft.unresolvedTagSuggestions = [...independent.values()];
  draft.ownerAssignedRecordIds = [...reviewed].filter((id) => assignments.has(id));
  draft.scopeRecordIds = [...scope];
  const reviews = new Map((draft.tagReview || []).map((item) => [item.recordId, item]));
  const importedIds = new Set(
    source.assignments
      .filter((item) => selected.some((project) => equalName(project.name, item.projectName)))
      .map((item) => item.recordId),
  );
  if (!projectNames.length) for (const id of source.unresolvedRecordIds) importedIds.add(id);
  for (const item of source.tagReview || []) {
    if (!importedIds.has(item.recordId)) continue;
    const previous = reviews.get(item.recordId);
    const tags = new Map((previous?.tags || []).map((tag) => [tag.name.toLowerCase(), tag]));
    for (const tag of item.tags)
      if (!tags.has(tag.name.toLowerCase())) tags.set(tag.name.toLowerCase(), { ...tag });
    reviews.set(item.recordId, { recordId: item.recordId, tags: [...tags.values()] });
  }
  draft.tagReview = [...reviews.values()];
  return { draft, conflicts };
}

export function removeDraftStructure(
  draft: CollectionDraft,
  projectName: string,
  categoryName: string | null,
) {
  const project = draft.projects.find((item) => item.name === projectName);
  if (
    !project ||
    (categoryName !== null && !project.categories.some((item) => item.name === categoryName))
  )
    throw new Error('Use an exact project/category name from this proposal.');
  const removed = draft.assignments.filter(
    (item) =>
      item.projectName === projectName &&
      (categoryName === null || item.categoryName === categoryName),
  );
  const ids = new Set(removed.map((item) => item.recordId));
  draft.assignments = draft.assignments.filter((item) => !ids.has(item.recordId));
  draft.unresolvedRecordIds = [...new Set([...draft.unresolvedRecordIds, ...ids])];
  draft.ownerAssignedRecordIds = draft.ownerAssignedRecordIds?.filter((id) => !ids.has(id));
  draft.unresolvedTagSuggestions = [
    ...(draft.unresolvedTagSuggestions || []),
    ...removed
      .filter((item) => item.suggestedTags?.length)
      .map((item) => ({
        recordId: item.recordId,
        url: item.url,
        navigationVersion: item.navigationVersion,
        suggestedTags: [...(item.suggestedTags || [])],
      })),
  ];
  if (categoryName === null) draft.projects = draft.projects.filter((item) => item !== project);
  else project.categories = project.categories.filter((item) => item.name !== categoryName);
  return removed.length;
}

export function mergeDraftCategories(
  draft: CollectionDraft,
  projectName: string,
  sourceName: string,
  targetName: string,
) {
  const project = draft.projects.find((item) => item.name === projectName);
  if (
    !project ||
    sourceName === targetName ||
    ![sourceName, targetName].every((name) => project.categories.some((item) => item.name === name))
  )
    throw new Error('Choose two different categories in the same proposal project.');
  for (const item of draft.assignments)
    if (item.projectName === projectName && item.categoryName === sourceName)
      item.categoryName = targetName;
  project.categories = project.categories.filter((item) => item.name !== sourceName);
}
