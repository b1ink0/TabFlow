import { z } from 'zod';
import { errorMessage } from '../../shared/types';

export interface ExecutableTool {
  name: string;
  description: string;
  parameters: z.ZodType;
  effect: 'read' | 'change' | 'delegate';
  execute: (input: unknown) => Promise<unknown>;
}

export function defineTool<Schema extends z.ZodType>(
  options: Parameters<typeof createToolExecutor<Schema>>[0],
): ExecutableTool {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    effect: options.effect ?? 'change',
    execute: createToolExecutor(options),
  };
}

/** Validate tool input independently of a provider. Each run owns its failure counter. */
export function createToolExecutor<Parameters extends z.ZodType>(options: {
  name: string;
  description: string;
  parameters: Parameters;
  fatalOnFailure?: boolean;
  effect?: ExecutableTool['effect'];
  function: (args: z.infer<Parameters>) => unknown | Promise<unknown>;
}) {
  const { fatalOnFailure } = options;
  let consecutiveFailures = 0;
  return async (args: unknown) => {
    try {
      const result = await options.function(options.parameters.parse(args));
      consecutiveFailures = 0;
      return result;
    } catch (error) {
      if (error instanceof Error && ['AbortError', 'APIUserAbortError'].includes(error.name))
        throw error;
      if (fatalOnFailure) throw error;
      if (++consecutiveFailures >= 3)
        throw new Error(
          `${options.name} failed three consecutive times: ${errorMessage(error)} Saved results were retained. Retry the turn after correcting its scope or settings.`,
          { cause: error },
        );
      return JSON.stringify({
        ok: false,
        tool: options.name,
        error: errorMessage(error),
        applied: false,
        automaticRetry: false,
      });
    }
  };
}
