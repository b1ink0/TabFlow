import type { Settings } from '../shared/types';

/** Prompt only from an owner action; later tool callbacks can check existing access with false. */
export async function requestModelAccess(
  settings: Settings,
  roles: Array<'generative' | 'decision' | 'tags'>,
  requestPermission = true,
) {
  const origins = new Set<string>();
  for (const requestedRole of roles) {
    const role =
      requestedRole === 'tags'
        ? settings.tagModelRole === 'generative'
          ? 'generative'
          : 'small'
        : requestedRole;
    const model =
      role === 'generative'
        ? settings.aiModel
        : role === 'decision' && settings.useDedicatedDecisionModel
          ? settings.decisionModel
          : settings.smallModel;
    if (!model)
      throw new Error(
        `Choose the ${role === 'generative' ? 'generative' : settings.useDedicatedDecisionModel ? 'System One decision' : 'small chat'} model in Settings first.`,
      );
    const base =
      role === 'generative'
        ? settings.aiBase
        : role === 'decision' && settings.useDedicatedDecisionModel
          ? settings.decisionBase
          : settings.smallModelBase;
    origins.add(`${new URL(base).origin}/*`);
  }
  if (roles.includes('tags')) {
    const tagRole = settings.tagModelRole || 'small';
    const tagModel = tagRole === 'small' ? settings.smallModel : settings.aiModel;
    if (tagModel)
      origins.add(
        `${new URL(tagRole === 'small' ? settings.smallModelBase : settings.aiBase).origin}/*`,
      );
    if (settings.tagVerification === 'decision' && settings.decisionModel)
      origins.add(`${new URL(settings.decisionBase).origin}/*`);
  }
  const permission = { origins: [...origins] };
  if (permission.origins.length && !(await chrome.permissions.contains(permission))) {
    if (!requestPermission)
      throw new Error(
        'Model server access is needed. Grant access in Settings, then Retry. No model request was sent.',
      );
    if (!(await chrome.permissions.request(permission)))
      throw new Error('Model server access was declined. No model request was sent.');
  }
}
