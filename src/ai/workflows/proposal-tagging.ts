import { analyzeTags } from './tagging';
import { editableProposal, activeProposalScopeIds } from '../../shared/organization/proposal-edits';
import { canonicalTags, tagHash, type TagStorage } from '../../shared/organization/tag-analysis';
import type { AppState, CollectionAnalysis, CollectionProposal } from '../../shared/types';
import type { ReceiptWriter } from '../../shared/inference/inference-receipt';

export interface ProposalTagCheckpoint {
  id: string;
  tags?: TagStorage;
  receipt?: ReceiptWriter;
  load: () => Promise<CollectionAnalysis | undefined>;
  save: (analysis: CollectionAnalysis) => Promise<CollectionAnalysis>;
}

/** Tag the frozen proposal scope without rerunning discovery or category decisions. */
export async function tagSavedProposal(
  app: AppState,
  proposal: CollectionProposal,
  options: {
    checkpoint: ProposalTagCheckpoint;
    targetKind?: 'workspace';
    recordIds?: string[];
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  },
) {
  if (proposal.status !== 'pending' || proposal.copyState)
    throw new Error('Choose a pending proposal without window creation in progress.');
  if (!options.checkpoint.tags) throw new Error('Durable tag storage is unavailable.');
  if (options.checkpoint.tags.analysisId !== options.checkpoint.id)
    throw new Error('Tag storage must belong to this saved analysis.');
  const fingerprint = await tagHash(proposal);
  let checkpoint = await options.checkpoint.load();
  if (
    checkpoint &&
    (checkpoint.tagTarget?.proposalId !== proposal.id ||
      checkpoint.tagTarget.proposalFingerprint !== fingerprint)
  )
    throw new Error(
      'The saved tag run belongs to a different draft revision. Its progress was retained; start a new tag request for the updated proposal.',
    );
  const scope = new Set(activeProposalScopeIds(proposal));
  const requested =
    checkpoint?.scope.map((item) => item.id) ||
    (options.recordIds?.length ? options.recordIds : [...scope]);
  if (new Set(requested).size !== requested.length || requested.some((id) => !scope.has(id)))
    throw new Error('Use occurrence IDs from this proposal, or [] for its entire scope.');
  const selected = new Set(requested);
  const records = app.records.filter(
    (record) => selected.has(record.id) && record.live && !record.locked,
  );
  if (!records.length) throw new Error('No eligible open tabs in this proposal scope.');
  const ids = new Set(records.map((record) => record.id));
  for (const item of [
    ...proposal.assignments,
    ...(proposal.unresolvedTagSuggestions || []),
    ...(checkpoint?.scope.map((item) => ({ recordId: item.id, ...item })) || []),
  ]) {
    const record = records.find((record) => record.id === item.recordId);
    if (record && (record.url !== item.url || record.navigationVersion !== item.navigationVersion))
      throw new Error(
        'A proposal tab changed. Sync the draft before analyzing tags. Saved progress was retained.',
      );
  }
  if (checkpoint && records.length !== checkpoint.scope.length)
    throw new Error(
      'The saved tag scope changed. Progress was retained; review closed or protected tabs before retrying.',
    );
  const assignments = proposal.assignments.filter((item) => ids.has(item.recordId));
  const assigned = new Set(assignments.map((item) => item.recordId));
  const vocabulary = canonicalTags([
    ...(app.tagVocabulary || []),
    ...app.records.flatMap((record) => record.tags),
  ]);
  if (!checkpoint) {
    checkpoint = await options.checkpoint.save({
      id: options.checkpoint.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      purpose: 'scoped',
      instruction: 'Analyze independent tags; preserve saved organization and do not apply.',
      taggingRequested: true,
      decisionContract: 'isolated-evidence-v2',
      reuseAcceptedTaxonomyOnly: true,
      tagTarget: {
        kind: options.targetKind,
        proposalId: proposal.id,
        proposalFingerprint: fingerprint,
        skippedCount: requested.length - records.length,
      },
      scope: records.map(({ id, url, navigationVersion }) => ({ id, url, navigationVersion })),
      discoveredIds: [...ids],
      classifiedIds: [...ids],
      projects: editableProposal(proposal).projects,
      tagVocabulary: vocabulary,
      assignments,
      unresolvedRecordIds: [...ids].filter((id) => !assigned.has(id)),
      summaries: [],
    });
  }
  const tagged = await analyzeTags(app, records, assignments, {
    vocabulary: checkpoint.tagVocabulary || [],
    storage: options.checkpoint.tags,
    skipRecordIds: checkpoint.skippedTagRecordIds,
    signal: options.signal,
    onProgress: options.onProgress,
    onReceipt: options.checkpoint.receipt,
    onFailure: async (failedBatch) => {
      checkpoint = await options.checkpoint.save({
        ...checkpoint!,
        failedBatch,
        updatedAt: Date.now(),
        revision: checkpoint!.revision + 1,
      });
    },
  });
  const skippedIds = new Set(checkpoint.skippedTagRecordIds || []);
  const completedRecords = records.filter((record) => !skippedIds.has(record.id));
  const draft = editableProposal(proposal);
  const selections = new Map(
    [...tagged.assignments, ...(tagged.unresolvedTagSuggestions || [])].map((item) => [
      item.recordId,
      item.suggestedTags || [],
    ]),
  );
  for (const item of draft.assignments)
    if (ids.has(item.recordId))
      item.suggestedTags = canonicalTags([
        ...(item.suggestedTags || []),
        ...(selections.get(item.recordId) || []),
      ]);
  const independent = new Map(
    (draft.unresolvedTagSuggestions || []).map((item) => [item.recordId, item]),
  );
  for (const item of tagged.unresolvedTagSuggestions || [])
    independent.set(item.recordId, {
      ...item,
      suggestedTags: canonicalTags([
        ...(independent.get(item.recordId)?.suggestedTags || []),
        ...item.suggestedTags,
      ]),
    });
  draft.unresolvedTagSuggestions = [...independent.values()];
  const reviews = new Map((draft.tagReview || []).map((item) => [item.recordId, item]));
  for (const decision of tagged.decisions) {
    const resolved = new Set(
      [...decision.accepted, ...decision.rejected].map((name) => name.toLowerCase()),
    );
    const prior = reviews.get(decision.recordId);
    const rejected = new Set(decision.rejected.map((name) => name.toLowerCase()));
    // Only replace machine-review choices. Unrelated/owner-confirmed labels are retained.
    const rejectedReview = new Set(
      prior?.tags
        .filter((tag) => rejected.has(tag.name.toLowerCase()))
        .map((tag) => tag.name.toLowerCase()) || [],
    );
    const target =
      draft.assignments.find((item) => item.recordId === decision.recordId) ||
      independent.get(decision.recordId);
    if (target)
      target.suggestedTags = target.suggestedTags?.filter(
        (name) => !rejectedReview.has(name.toLowerCase()),
      );
    if (prior) {
      const tags = prior.tags.filter((tag) => !resolved.has(tag.name.toLowerCase()));
      if (tags.length) reviews.set(decision.recordId, { recordId: decision.recordId, tags });
      else reviews.delete(decision.recordId);
    }
  }
  for (const item of tagged.tagReview || []) {
    const labels = new Map(
      (reviews.get(item.recordId)?.tags || []).map((tag) => [tag.name.toLowerCase(), tag]),
    );
    for (const tag of item.tags)
      if (!labels.has(tag.name.toLowerCase())) labels.set(tag.name.toLowerCase(), tag);
    reviews.set(item.recordId, { recordId: item.recordId, tags: [...labels.values()] });
  }
  draft.tagReview = [...reviews.values()];
  return {
    draft,
    fingerprint,
    processed: completedRecords.length,
    skipped:
      (checkpoint.tagTarget?.skippedCount ?? requested.length - records.length) + skippedIds.size,
    tagged: completedRecords.filter(
      (record) =>
        (
          draft.assignments.find((item) => item.recordId === record.id)?.suggestedTags ||
          independent.get(record.id)?.suggestedTags ||
          []
        ).length > 0,
    ).length,
    needsReview: draft.tagReview.filter(
      (item) => ids.has(item.recordId) && !skippedIds.has(item.recordId),
    ).length,
    patches: completedRecords.map((record) => ({
      recordId: record.id,
      url: record.url,
      navigationVersion: record.navigationVersion,
      suggestedTags:
        draft.assignments.find((item) => item.recordId === record.id)?.suggestedTags ||
        draft.unresolvedTagSuggestions?.find((item) => item.recordId === record.id)
          ?.suggestedTags ||
        [],
      review: draft.tagReview?.find((item) => item.recordId === record.id)?.tags || [],
    })),
  };
}
