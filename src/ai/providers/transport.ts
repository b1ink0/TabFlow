import { z } from 'zod';
import type { Settings } from '../../shared/types';

/** These responses require configuration/permission changes, not another identical request. */
export function throwPermanentModelFailure(error: unknown) {
  const result = z
    .object({ statusCode: z.number().optional(), status: z.number().optional() })
    .safeParse(error);
  const status = result.success ? (result.data.statusCode ?? result.data.status) : undefined;
  if (status && [401, 403, 404].includes(status))
    throw new Error(
      `Model request failed (HTTP ${status}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
}
/** No model-name heuristics: transport options are selected separately for each chat role. */
export function completionOptions(settings: Settings, role: 'generative' | 'small' = 'generative') {
  const effort = role === 'small' ? settings.smallReasoningEffort : settings.aiReasoningEffort;
  const budget = role === 'small' ? settings.smallCompletionTokens : settings.aiCompletionTokens;
  const field = role === 'small' ? settings.smallTokenField : settings.aiTokenField;
  return {
    ...(field === 'max_completion_tokens'
      ? { max_completion_tokens: budget }
      : { max_tokens: budget }),
    ...(effort === 'server' ? {} : { reasoning_effort: effort }),
  };
}
