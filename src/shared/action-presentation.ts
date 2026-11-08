import type { AssistantArtifact } from './assistant-actions';
import { actionCapabilities, capabilityLabels } from './assistant-actions';
import type { AppState } from './types';

type ActionContext = Pick<AppState, 'collectionProposals' | 'projects' | 'categories'>;
const countTabs = (count: number) => `${count} ${count === 1 ? 'tab' : 'tabs'}`;
interface ActionPresentation {
  label: string;
  description: string;
  denyLabel?: string;
  effect?: string;
}
export function actionPresentation(
  artifact: AssistantArtifact,
  app?: ActionContext,
): ActionPresentation {
  if (artifact.kind === 'collection') {
    const proposal = app?.collectionProposals.find((item) => item.id === artifact.proposalId);
    return {
      label: 'Apply organization',
      denyLabel: 'Keep draft',
      description: proposal
        ? `${proposal.name || `Proposal ${proposal.id}`} · ${proposal.assignments.filter((item) => !proposal.excludedRecordIds?.includes(item.recordId)).length} assigned · ${proposal.unresolvedRecordIds.filter((id) => !proposal.excludedRecordIds?.includes(id)).length} stay uncertain`
        : `Saved proposal ${artifact.proposalId}`,
      effect:
        'Saves project/category assignments and proposed tags on existing tabs; browser placement stays unchanged.',
    };
  }
  if (artifact.kind === 'project')
    return { label: 'Create project', description: artifact.project.name };
  if (artifact.kind === 'task')
    return { label: 'Save work item', description: artifact.task.title };
  if (artifact.kind === 'plan') {
    const counts = new Map<string, Set<string>>();
    const verbs = artifact.plan.actions.map((item) => {
      const verb =
        item.type === 'wake'
          ? 'Wake'
          : item.type === 'suspend'
            ? 'Suspend'
            : item.type === 'pin'
              ? item.enabled
                ? 'Pin'
                : 'Unpin'
              : item.type === 'mute'
                ? item.enabled
                  ? 'Mute'
                  : 'Unmute'
                : item.type === 'group'
                  ? 'Group'
                  : item.type === 'ungroup'
                    ? 'Ungroup'
                    : item.type === 'reorder'
                      ? 'Reorder'
                      : 'Move';
      const ids = counts.get(verb) || new Set<string>();
      item.recordIds.forEach((id) => ids.add(id));
      counts.set(verb, ids);
      return `${verb} ${countTabs(item.recordIds.length)}${item.name ? ` into ${item.name}` : ''}`;
    });
    return {
      label: verbs.length === 1 ? verbs[0]! : `Apply ${verbs.length} tab actions`,
      description:
        verbs.length === 1
          ? 'Changes browser tabs.'
          : [...counts].map(([verb, ids]) => `${verb} ${countTabs(ids.size)}`).join(' · '),
    };
  }
  const command = artifact.command;
  if (command.kind === 'workspace_edits') {
    const tabs = new Set(
      command.edits.flatMap(({ edit }) => ('recordId' in edit ? [edit.recordId] : [])),
    );
    const effects = actionCapabilities(artifact)
      .map((capability) => capabilityLabels[capability].toLowerCase())
      .join(', ');
    return {
      label: 'Save changes',
      description: `Save ${effects}${tabs.size ? ` for ${countTabs(tabs.size)}` : ''} · ${command.edits.length} changes`,
    };
  }
  if (command.kind === 'inspect')
    return {
      label: `Inspect ${countTabs(command.recordIds.length)}`,
      description: 'Reads page content; sleeping pages may be temporarily woken.',
    };
  if (command.kind === 'assign') {
    const project =
      app?.projects.find((item) => item.id === command.projectId)?.name || command.projectId;
    const category = app?.categories.find((item) => item.id === command.categoryId)?.name;
    return {
      label: `Assign ${countTabs(command.recordIds.length)}`,
      description: `Assign to ${project}${category ? ` / ${category}` : ''}`,
    };
  }
  if (command.kind === 'snapshot') return { label: 'Save snapshot', description: command.label };
  if (command.kind === 'restore')
    return {
      label: 'Restore snapshot',
      description: `Restore browser arrangement from snapshot ${command.snapshotId}`,
    };
  const redo = command.kind === 'redo' || command.kind === 'redo_assistant';
  const id = 'operationId' in command ? command.operationId : command.changeId;
  return {
    label: redo ? 'Redo change' : 'Undo change',
    description: `${redo ? 'Reapply' : 'Revert'} saved action ${id}`,
  };
}
