import { defineTool } from './definition';
import { z } from 'zod';
import type { AppState, CollectionDraft } from '../../shared/types';
import {
  renameDraftProject,
  renameDraftCategory,
  mergeDraftProjects,
} from '../../shared/organization/collection';
import {
  editableProposal,
  setDraftExclusions,
  proposalScopeIds,
  removeDraftStructure,
  mergeDraftCategories,
} from '../../shared/organization/proposal-edits';
import { tagHash } from '../../shared/organization/tag-analysis';
import type { RpcMap } from '../../shared/rpc';

export function organizationReviewTools(
  app: AppState,
  persist: (draft: CollectionDraft, id?: string) => Promise<string | undefined>,
  report: (message: string) => void,
  reclassifyUnresolved: (
    proposalId: string,
    recordIds?: string[],
  ) => Promise<{
    assigned: number;
    unresolved: number;
    skipped: number;
  }>,
  mergeProposals: (
    input: RpcMap['mergeCollectionProposals']['payload'],
  ) => Promise<RpcMap['mergeCollectionProposals']['response']>,
  refresh: (id: string) => Promise<void> = async () => undefined,
  tagProposal?: (
    proposalId: string,
    recordIds: string[],
  ) => Promise<{ processed: number; tagged: number; skipped: number; needsReview: number }>,
  requestApplication?: (proposalId: string) => void,
) {
  return [
    defineTool({
      name: 'analyze_proposal_tags',
      description:
        'Analyze independent tags for ALL tabs in a saved pending proposal, including uncertain/unassigned tabs. recordIds=[] means its entire scope. Runs the resumable tag pipeline internally; do not enumerate read_proposal_occurrences pages first. Preserves projects/categories, existing suggested tags and original tab metadata. Saves suggestions and completes the turn with exact counts; do any separately requested draft refinements before invoking it. Never applies organization or wakes tabs.',
      parameters: z.object({
        proposalId: z.string(),
        recordIds: z.array(z.string()).max(1000).default([]),
      }),
      function: async ({ proposalId, recordIds }) => {
        await refresh(proposalId);
        if (!tagProposal) throw new Error('Saved proposal tag analysis is unavailable.');
        const result = await tagProposal(proposalId, recordIds);
        report(
          `Tag analysis saved · ${result.processed} processed · ${result.tagged} with accepted tags · ${result.needsReview} need tag review · ${result.skipped} skipped · not applied`,
        );
        return JSON.stringify({ proposalId, ...result, categoriesPreserved: true, applied: false });
      },
    }),
    defineTool({
      name: 'prepare_organization_application',
      description:
        'ONLY when the owner asks to APPLY a saved organization: request application of the exact pending proposal, subject to the chat approval mode. Do not call for creating, reading, tagging, merging, refining or reclassifying a draft. Those operations only save a pending draft.',
      parameters: z.object({ proposalId: z.string() }),
      function: async ({ proposalId }) => {
        await refresh(proposalId);
        const proposal = app.collectionProposals.find(
          (item) => item.id === proposalId && item.status === 'pending' && !item.copyState,
        );
        if (!proposal || !requestApplication)
          throw new Error('This pending organization cannot be prepared for application.');
        requestApplication(proposalId);
        return JSON.stringify({
          proposalId,
          applicationRequested: true,
          applied: false,
          assignedCount: proposal.assignments.length,
          unresolvedCount: proposal.unresolvedRecordIds.length,
        });
      },
    }),
    defineTool({
      name: 'copy_organization_proposal',
      description:
        'Fork a saved proposal into a separately named pending draft, preserving the source. projectNames=[] copies the whole draft including uncertain tabs; otherwise copy only the named projects and their assignments. Use to try a different organization or split a large draft. No browser or accepted workspace changes.',
      parameters: z.object({
        sourceProposalId: z.string(),
        name: z.string().trim().min(1).max(120),
        projectNames: z.array(z.string().min(1).max(80)).max(1000),
      }),
      function: async ({ sourceProposalId, name, projectNames }) => {
        const source = app.collectionProposals.find((item) => item.id === sourceProposalId);
        if (!source || (source.copyState && source.status === 'pending'))
          throw new Error('Use a saved source without window creation in progress.');
        const draft = editableProposal(source);
        draft.name = name;
        draft.sourceJobIds = undefined;
        if (projectNames.length) {
          draft.projects = draft.projects.filter((item) => projectNames.includes(item.name));
          if (draft.projects.length !== new Set(projectNames).size)
            throw new Error('Use exact source project names.');
          draft.assignments = draft.assignments.filter((item) =>
            projectNames.includes(item.projectName),
          );
          draft.unresolvedRecordIds = [];
          draft.unresolvedTagSuggestions = [];
          const ids = new Set(draft.assignments.map((item) => item.recordId));
          draft.scopeRecordIds = [...ids];
          draft.ownerAssignedRecordIds = draft.ownerAssignedRecordIds?.filter((id) => ids.has(id));
          draft.tagReview = draft.tagReview?.filter((item) => ids.has(item.recordId));
          if (!ids.size) throw new Error('These projects have no assigned occurrences to copy.');
        }
        const proposalId = await persist(draft);
        if (!proposalId)
          throw new Error(
            'The draft save returned no ID; inspect saved proposals before retrying.',
          );
        report('Created separate proposal copy · source preserved · not applied');
        return JSON.stringify({
          proposalId,
          sourceProposalId,
          sourcePreserved: true,
          assignedCount: draft.assignments.length,
          unresolvedCount: draft.unresolvedRecordIds.length,
          applied: false,
        });
      },
    }),
    defineTool({
      name: 'compare_organization_proposals',
      effect: 'read',
      description:
        'Compare two exact saved proposals before choosing a merge target. Returns statuses, names, counts, project differences and paginated overlapping assignment conflicts. Read-only; does not infer that a later draft should replace an older one.',
      parameters: z.object({
        leftProposalId: z.string(),
        rightProposalId: z.string(),
        offset: z.number().int().min(0).max(100000),
      }),
      function: async ({ leftProposalId, rightProposalId, offset }) => {
        await refresh(leftProposalId);
        await refresh(rightProposalId);
        const left = app.collectionProposals.find((item) => item.id === leftProposalId);
        const right = app.collectionProposals.find((item) => item.id === rightProposalId);
        if (!left || !right) throw new Error('Both proposal IDs must exist.');
        const conflicts = left.assignments.flatMap((item) => {
          const other = right.assignments.find((candidate) => candidate.recordId === item.recordId);
          return other &&
            (item.projectName !== other.projectName ||
              item.categoryName !== other.categoryName ||
              item.url !== other.url ||
              item.navigationVersion !== other.navigationVersion)
            ? [
                {
                  recordId: item.recordId,
                  left: { projectName: item.projectName, categoryName: item.categoryName },
                  right: { projectName: other.projectName, categoryName: other.categoryName },
                  samePageVersion:
                    item.url === other.url && item.navigationVersion === other.navigationVersion,
                },
              ]
            : [];
        });
        const summary = (item: typeof left) => ({
          id: item.id,
          name: item.name,
          status: item.status,
          assigned: item.assignments.length,
          uncertain: item.unresolvedRecordIds.length,
        });
        return JSON.stringify({
          left: summary(left),
          right: summary(right),
          projectsOnlyLeft: left.projects
            .filter((item) => !right.projects.some((other) => other.name === item.name))
            .map((item) => item.name),
          projectsOnlyRight: right.projects
            .filter((item) => !left.projects.some((other) => other.name === item.name))
            .map((item) => item.name),
          conflictCount: conflicts.length,
          conflicts: conflicts.slice(offset, offset + 25),
          nextOffset: offset + 25 < conflicts.length ? offset + 25 : null,
        });
      },
    }),
    defineTool({
      name: 'list_organization_proposals',
      effect: 'read',
      description:
        'List saved organization proposals by ID, status and compact scope summary. Use an exact ID to inspect or edit a particular draft.',
      parameters: z.object({ offset: z.number().int().min(0).max(100000) }),
      function: ({ offset }) => {
        const proposals = [...app.collectionProposals].sort((a, b) => b.createdAt - a.createdAt);
        return JSON.stringify({
          total: proposals.length,
          offset,
          nextOffset: offset + 20 < proposals.length ? offset + 20 : null,
          proposals: proposals.slice(offset, offset + 20).map((item) => ({
            id: item.id,
            name: item.name,
            status: item.status,
            summary: item.summary.slice(0, 180),
            createdAt: item.createdAt,
            projectCount: item.projects.length,
            assignedCount: item.assignments.length,
            unresolvedCount: item.unresolvedRecordIds.length,
          })),
        });
      },
    }),
    defineTool({
      name: 'read_organization_proposal',
      effect: 'read',
      description:
        'Read a compact page of a pending proposal: project names, categories and occurrence IDs. Use read_proposal_project for full details of one project.',
      parameters: z.object({ proposalId: z.string(), offset: z.number().int().min(0).max(100000) }),
      function: async ({ proposalId, offset }) => {
        await refresh(proposalId);
        const draft = app.collectionProposals.find((item) => item.id === proposalId);
        if (!draft) throw new Error('Proposal not found.');
        const scope = new Set(
          draft.scopeRecordIds?.length
            ? draft.scopeRecordIds
            : [...draft.assignments.map((item) => item.recordId), ...draft.unresolvedRecordIds],
        );
        const eligibleIds = app.records
          .filter(
            (item) =>
              item.live &&
              !item.locked &&
              !app.memberships.some(
                (membership) => membership.recordId === item.id && membership.source === 'owner',
              ),
          )
          .map((item) => item.id);
        report('Read saved organization proposal');
        return JSON.stringify({
          id: draft.id,
          name: draft.name,
          status: draft.status,
          updatedAt: draft.updatedAt || draft.createdAt,
          copyProgress: draft.copyState
            ? {
                windows: draft.copyState.windows,
                created: draft.copyState.entries.filter((entry) => entry.created).length,
                total: draft.copyState.entries.length,
                errors: draft.copyState.entries
                  .filter((entry) => entry.error)
                  .slice(0, 5)
                  .map((entry) => entry.error),
              }
            : null,
          projects: draft.projects.slice(offset, offset + 12).map((project) => ({
            name: project.name,
            purpose: project.purpose,
            areaName: project.areaName,
            categoryNames: project.categories.slice(0, 20).map((category) => category.name),
            categoryCount: project.categories.length,
          })),
          projectCount: draft.projects.length,
          nextProjectOffset: offset + 12 < draft.projects.length ? offset + 12 : null,
          assignments: draft.assignments.slice(offset, offset + 15).map((item) => ({
            recordId: item.recordId,
            projectName: item.projectName,
            categoryName: item.categoryName,
            suggestedTags: item.suggestedTags || [],
          })),
          assignmentCount: draft.assignments.filter(
            (item) => !draft.excludedRecordIds?.includes(item.recordId),
          ).length,
          excludedCount: draft.excludedRecordIds?.length || 0,
          scopedOccurrences: scope.size,
          eligibleOccurrences: eligibleIds.length,
          coversCurrentCollection:
            scope.size === eligibleIds.length && eligibleIds.every((id) => scope.has(id)),
          unresolvedEvidence: draft.unresolvedRecordIds.slice(offset, offset + 15).map((id) => {
            const record = app.records.find((item) => item.id === id && item.live);
            return record
              ? {
                  recordId: id,
                  title: record.title.slice(0, 160),
                  url: record.url.slice(0, 300),
                  suspended: record.suspended,
                  foreignSuspended: record.foreignSuspended,
                  cacheAvailable: Boolean(record.content),
                  locked: record.locked,
                  tags: record.tags,
                  suggestedTags:
                    draft.unresolvedTagSuggestions?.find((item) => item.recordId === id)
                      ?.suggestedTags || [],
                }
              : { recordId: id, unavailable: true };
          }),
          nextOffset:
            offset + 15 < Math.max(draft.assignments.length, draft.unresolvedRecordIds.length)
              ? offset + 15
              : null,
          unresolvedRecordIds: draft.unresolvedRecordIds.slice(offset, offset + 15),
          unresolvedCount: draft.unresolvedRecordIds.length,
        });
      },
    }),
    defineTool({
      name: 'read_proposal_occurrences',
      effect: 'read',
      description:
        'Search a bounded page of assigned or uncertain tabs in one saved proposal. query matches titles, URLs and tags (for example youtube); use nextOffset instead of rereading page zero. Uncertain means no project/category decision, not missing tags. No tabs are woken.',
      parameters: z.object({
        proposalId: z.string(),
        status: z.enum(['uncertain', 'assigned', 'all', 'excluded']),
        query: z.string().max(300).default(''),
        projectName: z.string().max(80).nullable().default(null),
        offset: z.number().int().min(0).max(100000),
      }),
      function: async ({ proposalId, status, query, projectName, offset }) => {
        await refresh(proposalId);
        const proposal = app.collectionProposals.find((item) => item.id === proposalId);
        if (!proposal) throw new Error('Proposal not found.');
        const rows = [
          ...proposal.assignments.map((item) => ({ ...item, status: 'assigned' })),
          ...proposal.unresolvedRecordIds.map((recordId) => ({
            recordId,
            projectName: null,
            categoryName: null,
            status: 'uncertain',
            suggestedTags:
              proposal.unresolvedTagSuggestions?.find((item) => item.recordId === recordId)
                ?.suggestedTags || [],
          })),
        ]
          .map((item) => {
            const record = app.records.find((record) => record.id === item.recordId);
            return {
              ...item,
              status: proposal.excludedRecordIds?.includes(item.recordId)
                ? 'excluded'
                : item.status,
              title: record?.title.slice(0, 160),
              url: record?.url.slice(0, 300),
              live: Boolean(record?.live),
              locked: record?.locked,
              tags: record?.tags,
            };
          })
          .filter(
            (item) =>
              (status === 'all' || status === item.status) &&
              (!projectName || item.projectName === projectName) &&
              (!query ||
                `${item.title} ${item.url} ${item.suggestedTags?.join(' ')} ${item.tags?.join(' ')}`
                  .toLowerCase()
                  .includes(query.toLowerCase())),
          );
        report(
          `Read proposal occurrences · ${Math.min(25, Math.max(0, rows.length - offset))} of ${rows.length} matches`,
        );
        return JSON.stringify({
          proposalId,
          total: rows.length,
          offset,
          nextOffset: offset + 25 < rows.length ? offset + 25 : null,
          occurrences: rows.slice(offset, offset + 25),
        });
      },
    }),
    defineTool({
      name: 'merge_organization_proposals',
      description:
        'Import projects and assignments from sourceProposalId INTO targetProposalId. Target must be pending; the source is preserved even if applied/undone. projectNames=[] imports all projects and uncertain tabs; otherwise import only named source projects. Keep_target preserves conflicting target assignments; use_source replaces them only when explicitly requested. Tags are combined without a count limit and retain review markers; assignmentConflict never discards tags. Never applies organization or changes browser tabs.',
      parameters: z.object({
        targetProposalId: z.string(),
        sourceProposalId: z.string(),
        projectNames: z.array(z.string().min(1).max(80)).max(1000),
        assignmentConflict: z.enum(['keep_target', 'use_source']),
      }),
      function: async (input) => {
        const target = app.collectionProposals.find((item) => item.id === input.targetProposalId);
        const source = app.collectionProposals.find((item) => item.id === input.sourceProposalId);
        if (!target || !source)
          throw new Error('List proposals and use exact source and target IDs.');
        const result = await mergeProposals({
          ...input,
          targetFingerprint: await tagHash(target),
          sourceFingerprint: await tagHash(source),
        });
        report('Merged proposal into target draft · source preserved · not applied');
        return JSON.stringify({
          proposalId: result.proposal.id,
          sourceProposalId: source.id,
          sourcePreserved: true,
          conflicts: result.conflicts,
          conflictPolicy: input.assignmentConflict,
          assignedCount: result.proposal.assignments.length,
          unresolvedCount: result.proposal.unresolvedRecordIds.length,
          applied: false,
        });
      },
    }),
    defineTool({
      name: 'merge_proposal_projects',
      description:
        'Combine two projects INSIDE the specified pending proposal. Source categories and assignments move into the target; conflicting category meanings stay distinct. Source project is removed only from this draft. Nothing is applied.',
      parameters: z.object({
        proposalId: z.string(),
        sourceProjectName: z.string().min(1).max(80),
        targetProjectName: z.string().min(1).max(80),
      }),
      function: async ({ proposalId, sourceProjectName, targetProjectName }) => {
        const proposal = app.collectionProposals.find(
          (item) => item.id === proposalId && item.status === 'pending',
        );
        if (!proposal) throw new Error('Pending proposal not found.');
        const draft = editableProposal(proposal);
        mergeDraftProjects(draft, sourceProjectName, targetProjectName);
        await persist(draft, proposalId);
        report('Combined projects in saved draft · not applied');
        return JSON.stringify({
          proposalId,
          targetProjectName,
          projectCount: draft.projects.length,
          applied: false,
        });
      },
    }),
    defineTool({
      name: 'rename_organization_proposal',
      description:
        'Rename a pending proposal itself and optionally update its summary. Does not rename its projects or change assignments. Usable from any chat with an explicit proposal ID.',
      parameters: z.object({
        proposalId: z.string(),
        name: z.string().trim().min(1).max(120),
        summary: z.string().max(2000).nullable().default(null),
      }),
      function: async ({ proposalId, name, summary }) => {
        const proposal = app.collectionProposals.find(
          (item) => item.id === proposalId && item.status === 'pending',
        );
        if (!proposal) throw new Error('Pending proposal not found.');
        const draft = editableProposal(proposal);
        draft.name = name;
        if (summary !== null) draft.summary = summary;
        await persist(draft, proposalId);
        report('Renamed saved proposal · not applied');
        return JSON.stringify({ proposalId, name, applied: false });
      },
    }),
    defineTool({
      name: 'edit_proposal_structure',
      description:
        'Remove a project/category from a pending draft or combine two categories in one project. Removal returns affected tabs to uncertain and preserves proposed tags; never closes tabs or deletes accepted projects. For merge_category targetCategoryName must be an exact existing category; categoryName identifies the source.',
      parameters: z.object({
        proposalId: z.string(),
        action: z.enum(['remove_project', 'remove_category', 'merge_category']),
        projectName: z.string().min(1).max(80),
        categoryName: z.string().max(80).nullable(),
        targetCategoryName: z.string().max(80).nullable(),
      }),
      function: async ({ proposalId, action, projectName, categoryName, targetCategoryName }) => {
        const proposal = app.collectionProposals.find(
          (item) => item.id === proposalId && item.status === 'pending',
        );
        if (!proposal) throw new Error('Pending proposal not found.');
        const draft = editableProposal(proposal);
        if (action === 'merge_category') {
          if (!categoryName || !targetCategoryName)
            throw new Error('Category merge requires source and target names.');
          mergeDraftCategories(draft, projectName, categoryName, targetCategoryName);
        } else {
          if (action === 'remove_category' && !categoryName)
            throw new Error('Choose the category to remove.');
          removeDraftStructure(
            draft,
            projectName,
            action === 'remove_project' ? null : categoryName,
          );
        }
        await persist(draft, proposalId);
        report('Edited proposal structure · no browser changes');
        return JSON.stringify({
          proposalId,
          action,
          assignedCount: draft.assignments.length,
          unresolvedCount: draft.unresolvedRecordIds.length,
          applied: false,
        });
      },
    }),
    defineTool({
      name: 'read_proposal_project',
      effect: 'read',
      description:
        'Read one exact project in a pending proposal, including its purpose and category descriptions, without loading the entire proposal.',
      parameters: z.object({ proposalId: z.string(), projectName: z.string().max(80) }),
      function: async ({ proposalId, projectName }) => {
        await refresh(proposalId);
        const proposal = app.collectionProposals.find((item) => item.id === proposalId);
        if (!proposal) throw new Error('Proposal not found.');
        const project = proposal.projects.find((item) => item.name === projectName);
        if (!project) throw new Error('Project not found in this proposal.');
        return JSON.stringify({
          proposalId,
          project,
          assignedCount: proposal.assignments.filter((item) => item.projectName === projectName)
            .length,
        });
      },
    }),
    defineTool({
      name: 'reclassify_unresolved_proposal',
      description:
        'Run the configured small chat/System One decision model on only the unresolved live occurrences in this pending proposal, using their saved original titles, URLs and available cache. Merge confident assignments into the same proposal; keep existing assignments and uncertain tabs. This does not wake tabs, apply the proposal or create a new proposal.',
      parameters: z.object({
        proposalId: z.string(),
        recordIds: z.array(z.string()).max(1000).default([]),
        query: z.string().max(300).default(''),
      }),
      function: async ({ proposalId, recordIds, query }) => {
        const proposal = app.collectionProposals.find(
          (item) => item.id === proposalId && item.status === 'pending',
        );
        if (!proposal) throw new Error('Pending proposal not found.');
        if (recordIds.some((id) => !proposal.unresolvedRecordIds.includes(id)))
          throw new Error('Only uncertain IDs from this proposal can be reclassified.');
        const selected = proposal.unresolvedRecordIds.filter((id) => {
          const record = app.records.find((item) => item.id === id);
          return (
            (!recordIds.length || recordIds.includes(id)) &&
            (!query ||
              `${record?.title} ${record?.url}`.toLowerCase().includes(query.toLowerCase()))
          );
        });
        if (!selected.length)
          return JSON.stringify({
            proposalId,
            assigned: 0,
            unresolved: proposal.unresolvedRecordIds.length,
            matched: 0,
            applied: false,
          });
        const result = await reclassifyUnresolved(proposalId, selected);
        const saved = app.collectionProposals.find((item) => item.id === proposalId);
        const scope = new Set(
          saved?.scopeRecordIds?.length
            ? saved.scopeRecordIds
            : [
                ...(saved?.assignments.map((item) => item.recordId) ?? []),
                ...(saved?.unresolvedRecordIds ?? []),
              ],
        );
        const eligibleIds = app.records
          .filter(
            (item) =>
              item.live &&
              !item.locked &&
              !app.memberships.some(
                (membership) => membership.recordId === item.id && membership.source === 'owner',
              ),
          )
          .map((item) => item.id);
        return JSON.stringify({
          proposalId,
          ...result,
          scopedOccurrences: scope.size,
          eligibleOccurrences: eligibleIds.length,
          coversCurrentCollection:
            scope.size === eligibleIds.length && eligibleIds.every((id) => scope.has(id)),
          wokeTabs: 0,
          applied: false,
          awaitingOwnerReview: true,
        });
      },
    }),
    defineTool({
      name: 'set_proposal_tabs_included',
      description:
        'Exclude tabs from a pending draft, or restore excluded tabs with included=true. Preserves all saved project/category/tag choices for restoration and draft Undo/Redo. recordIds selects exact IDs; otherwise query/projectName/status selects the complete matching scope internally, without paging. This never closes tabs or changes accepted memberships. Returns exact affected IDs.',
      parameters: z.object({
        proposalId: z.string(),
        recordIds: z.array(z.string()).max(1000).default([]),
        query: z.string().max(300).default(''),
        projectName: z.string().max(80).nullable().default(null),
        status: z.enum(['all', 'assigned', 'uncertain', 'excluded']).default('all'),
        included: z.boolean(),
      }),
      function: async ({ proposalId, recordIds, query, projectName, status, included }) => {
        await refresh(proposalId);
        const proposal = app.collectionProposals.find(
          (item) => item.id === proposalId && item.status === 'pending' && !item.copyState,
        );
        if (!proposal)
          throw new Error('Choose an exact pending proposal without window creation in progress.');
        const scope = proposalScopeIds(proposal);
        const ids = recordIds.length
          ? recordIds
          : scope.filter((id) => {
              const assignment = proposal.assignments.find((item) => item.recordId === id);
              const excluded = proposal.excludedRecordIds?.includes(id);
              const record = app.records.find((item) => item.id === id);
              return (
                (status === 'all' ||
                  (status === 'excluded'
                    ? excluded
                    : !excluded && (status === 'assigned' ? Boolean(assignment) : !assignment))) &&
                (!projectName || assignment?.projectName === projectName) &&
                (!query ||
                  `${record?.title || ''} ${record?.url || ''} ${record?.tags.join(' ') || ''}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase()))
              );
            });
        if (!ids.length) return JSON.stringify({ proposalId, affectedCount: 0, applied: false });
        const draft = editableProposal(proposal);
        setDraftExclusions(draft, ids, !included);
        await persist(draft, proposalId);
        report(
          `${included ? 'Restored' : 'Excluded'} ${ids.length} draft tabs; browser tabs unchanged`,
        );
        return JSON.stringify({
          proposalId,
          affectedCount: ids.length,
          recordIds: ids,
          included,
          applied: false,
        });
      },
    }),
    defineTool({
      name: 'refine_organization_proposal',
      description:
        'Patch only changed entries in an exact pending proposal, including from another chat. previousName="" ADDS a project/category; otherwise rename/update the exact existing name and preserve all references. Unlisted entries remain unchanged. Null/blank metadata preserves existing purpose/descriptions; clearPurpose/clearDescription=true explicitly clears those fields. Null areaName leaves a new project without an area and preserves an existing project area. Create categories before assigning tabs; categoryName=null explicitly returns a tab to uncertain, it does not assign a project. tagEdits replace proposed tags only; [] clears suggestions, never tab tags. assignmentGroups selects ALL matching non-excluded tabs internally by query/current project/category/status; use this for bulk changes instead of enumerating occurrence pages. Explicit assignments override group matches. New projects and categories in this call are available to assignments atomically. Nothing is applied.',
      parameters: z.object({
        assignmentGroups: z
          .array(
            z.object({
              query: z.string().max(300).default(''),
              fromProjectName: z.string().max(80).nullable().default(null),
              fromCategoryName: z.string().max(80).nullable().default(null),
              status: z.enum(['all', 'assigned', 'uncertain']).default('all'),
              projectName: z.string().max(80),
              categoryName: z.string().max(80).nullable(),
            }),
          )
          .max(100)
          .default([]),
        proposalId: z.string(),
        projectEdits: z
          .array(
            z.object({
              previousName: z.string().max(80),
              name: z.string().min(1).max(80),
              purpose: z.string().max(500).nullable().default(null),
              clearPurpose: z.boolean().default(false),
              areaName: z.string().min(1).max(80).nullable().default(null),
            }),
          )
          .max(100),
        categoryEdits: z
          .array(
            z.object({
              projectName: z.string().max(80),
              previousName: z.string().max(80),
              name: z.string().min(1).max(80),
              description: z.string().max(300).nullable().default(null),
              clearDescription: z.boolean().default(false),
            }),
          )
          .max(100),
        tagEdits: z
          .array(
            z.object({
              recordId: z.string(),
              suggestedTags: z.array(z.string().trim().min(1).max(80)),
            }),
          )
          .max(100)
          .default([]),
        assignments: z
          .array(
            z.object({
              recordId: z.string(),
              projectName: z.string().max(80),
              categoryName: z.string().max(80).nullable(),
            }),
          )
          .max(1000),
      }),
      function: async ({
        proposalId,
        projectEdits,
        categoryEdits,
        assignments,
        tagEdits,
        assignmentGroups,
      }) => {
        const existing = app.collectionProposals.find(
          (item) => item.id === proposalId && item.status === 'pending',
        );
        if (!existing) throw new Error('Read an actual pending proposal first.');
        const draft = editableProposal(existing);
        draft.ownerAssignedRecordIds ||= [];
        for (const edit of projectEdits) {
          if (!edit.previousName) {
            if (
              draft.projects.some(
                (item) => item.name.toLowerCase() === edit.name.trim().toLowerCase(),
              )
            )
              throw new Error(
                'That project already exists. Use its exact previousName to edit it, or merge_proposal_projects to combine projects.',
              );
            draft.projects.push({
              name: edit.name.trim(),
              purpose: edit.purpose || '',
              areaName: edit.areaName,
              categories: [],
            });
          } else {
            const project = renameDraftProject(draft, edit.previousName, edit.name);
            if (edit.clearPurpose) project.purpose = '';
            else if (edit.purpose?.trim()) project.purpose = edit.purpose;
            if (edit.areaName !== null) project.areaName = edit.areaName;
          }
        }
        for (const edit of categoryEdits) {
          if (!edit.previousName) {
            const project = draft.projects.find(
              (item) =>
                item.name.toLocaleLowerCase() === edit.projectName.trim().toLocaleLowerCase(),
            );
            if (!project) throw new Error('Category references an unknown project. Add it first.');
            if (
              project.categories.some(
                (item) => item.name.toLowerCase() === edit.name.trim().toLowerCase(),
              )
            )
              throw new Error('Category already exists; use its previousName.');
            project.categories.push({
              name: edit.name.trim(),
              description: edit.description || '',
            });
            continue;
          }
          const category = renameDraftCategory(
            draft,
            edit.projectName,
            edit.previousName,
            edit.name,
          );
          if (edit.clearDescription) category.description = '';
          else if (edit.description?.trim()) category.description = edit.description;
        }
        // Evaluate selectors against the original draft so one group's edits cannot expand another.
        const grouped = new Map<
          string,
          { recordId: string; projectName: string; categoryName: string | null }
        >();
        for (const group of assignmentGroups) {
          for (const id of proposalScopeIds(existing)) {
            if (existing.excludedRecordIds?.includes(id)) continue;
            const current = existing.assignments.find((item) => item.recordId === id);
            const record = app.records.find((item) => item.id === id);
            if (group.status !== 'all' && (group.status === 'assigned') !== Boolean(current))
              continue;
            if (
              group.fromProjectName &&
              current?.projectName.toLocaleLowerCase() !==
                group.fromProjectName.trim().toLocaleLowerCase()
            )
              continue;
            if (
              group.fromCategoryName &&
              current?.categoryName.toLocaleLowerCase() !==
                group.fromCategoryName.trim().toLocaleLowerCase()
            )
              continue;
            if (
              group.query &&
              !`${record?.title || ''} ${record?.url || ''} ${record?.tags.join(' ') || ''} ${record?.note || ''}`
                .toLocaleLowerCase()
                .includes(group.query.trim().toLocaleLowerCase())
            )
              continue;
            const edit = {
              recordId: id,
              projectName: group.projectName,
              categoryName: group.categoryName,
            };
            const prior = grouped.get(id);
            if (
              prior &&
              (prior.projectName !== edit.projectName || prior.categoryName !== edit.categoryName)
            )
              throw new Error(
                `Bulk assignment groups conflict on occurrence ${id}. Use non-overlapping selectors or an explicit assignment.`,
              );
            grouped.set(id, edit);
          }
        }
        for (const edit of assignments) grouped.set(edit.recordId, edit);
        const exactAssignments = [...grouped.values()];
        for (const edit of exactAssignments) {
          if (edit.categoryName !== null) {
            const target = draft.projects.find(
              (item) =>
                item.name.toLocaleLowerCase() === edit.projectName.trim().toLocaleLowerCase(),
            );
            const category = target?.categories.find(
              (item) =>
                item.name.toLocaleLowerCase() === edit.categoryName?.trim().toLocaleLowerCase(),
            );
            if (!target || !category)
              throw new Error(
                `Assignment for ${edit.recordId} references ${JSON.stringify(edit.projectName)} / ${JSON.stringify(edit.categoryName)}. Available categories: ${target?.categories.map((item) => item.name).join(', ') || '(none)'}. Add the project/category in this same call before assigning tabs.`,
              );
            edit.projectName = target.name;
            edit.categoryName = category.name;
          }
          const current = draft.assignments.find((item) => item.recordId === edit.recordId);
          const independent = draft.unresolvedTagSuggestions?.find(
            (item) => item.recordId === edit.recordId,
          );
          draft.unresolvedTagSuggestions = draft.unresolvedTagSuggestions?.filter(
            (item) => item.recordId !== edit.recordId,
          );
          if (!current && !draft.unresolvedRecordIds.includes(edit.recordId))
            throw new Error('Correction references an occurrence outside the proposal.');
          draft.assignments = draft.assignments.filter((item) => item.recordId !== edit.recordId);
          draft.unresolvedRecordIds = draft.unresolvedRecordIds.filter(
            (id) => id !== edit.recordId,
          );
          draft.ownerAssignedRecordIds = draft.ownerAssignedRecordIds?.filter(
            (id) => id !== edit.recordId,
          );
          if (edit.categoryName === null) {
            draft.unresolvedRecordIds.push(edit.recordId);
            if (current?.suggestedTags?.length)
              draft.unresolvedTagSuggestions = [
                ...(draft.unresolvedTagSuggestions || []),
                {
                  recordId: current.recordId,
                  url: current.url,
                  navigationVersion: current.navigationVersion,
                  suggestedTags: [...current.suggestedTags],
                },
              ];
            else if (independent)
              draft.unresolvedTagSuggestions = [
                ...(draft.unresolvedTagSuggestions || []),
                independent,
              ];
            continue;
          }
          const record = app.records.find((item) => item.id === edit.recordId && item.live);
          if (!record || record.locked)
            throw new Error('A correction target is missing or protected.');
          draft.assignments.push({
            recordId: record.id,
            url: current?.url || record.url,
            navigationVersion: current?.navigationVersion ?? record.navigationVersion,
            projectName: edit.projectName,
            categoryName: edit.categoryName,
            reason: 'Owner correction through conversation.',
            confidence: 1,
            suggestedTags: current?.suggestedTags || independent?.suggestedTags,
          });
          draft.ownerAssignedRecordIds?.push(record.id);
        }
        for (const edit of tagEdits) {
          draft.tagReview = draft.tagReview?.filter((item) => item.recordId !== edit.recordId);
          const record = app.records.find(
            (item) => item.id === edit.recordId && item.live && !item.locked,
          );
          const assignment = draft.assignments.find((item) => item.recordId === edit.recordId);
          if (!record || (!assignment && !draft.unresolvedRecordIds.includes(edit.recordId)))
            throw new Error('Tag correction target is outside the proposal or protected.');
          if (assignment) assignment.suggestedTags = [...new Set(edit.suggestedTags)];
          else
            draft.unresolvedTagSuggestions = [
              ...(draft.unresolvedTagSuggestions || []).filter(
                (item) => item.recordId !== edit.recordId,
              ),
              {
                recordId: record.id,
                url: record.url,
                navigationVersion: record.navigationVersion,
                suggestedTags: [...new Set(edit.suggestedTags)],
              },
            ];
        }
        await persist(draft, proposalId);
        report('Revised saved organization proposal · awaiting review');
        return JSON.stringify({
          proposalId,
          affectedRecordIds: exactAssignments.map((item) => item.recordId),
          applied: false,
          projectEdits: projectEdits.length,
          categoryEdits: categoryEdits.length,
          correctedOccurrences: assignments.length,
          awaitingOwnerReview: true,
        });
      },
    }),
  ];
}
