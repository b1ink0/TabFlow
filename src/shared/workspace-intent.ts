import { z } from 'zod';
export const workspaceIntentSchema = z.object({
  id: z.string(),
  at: z.number(),
  targetTabId: z.number().int(),
  kind: z.enum(['reveal', 'ask', 'find-link']),
  recordId: z.string().optional(),
  query: z.string().max(10000).optional(),
  notice: z.string().max(1000).optional(),
});
export type WorkspaceIntent = z.infer<typeof workspaceIntentSchema>;
