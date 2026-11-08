import { zodFunction } from 'openai/helpers/zod';
import { z } from 'zod';
import { errorMessage } from '../shared/types';

/** Keep recoverable tool failures in the SDK conversation; cancellation still ends the run. */
export function reviewTool<Parameters extends z.ZodType>(options: {
  name: string;
  description: string;
  parameters: Parameters;
  fatalOnFailure?: boolean;
  function: (args: z.infer<Parameters>) => unknown | Promise<unknown>;
}) {
  const { fatalOnFailure, ...tool } = options;
  let consecutiveFailures = 0;
  return zodFunction({
    ...tool,
    function: async (args) => {
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
    },
  });
}
