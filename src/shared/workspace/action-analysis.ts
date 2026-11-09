import { z } from 'zod';
import { actionSchema } from '../model';

export const actionAnalysisSchema = z.object({
  decisionContract: z.string().max(80).optional(),
  sourceAnalysisId: z.string().max(200).optional(),
  id: z.string().min(1).max(200),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  revision: z.number().int().min(1),
  status: z.enum(['pending', 'complete']),
  instruction: z.string().min(1).max(1000),
  mode: z.enum(['generative', 'decision']),
  readOnly: z.boolean(),
  allowCrossWindowMove: z.boolean(),
  allowSleepWake: z.boolean(),
  scope: z
    .array(
      z.object({
        id: z.string().min(1),
        url: z.string(),
        navigationVersion: z.number().int().min(0),
        windowId: z.number().int(),
        groupId: z.number().int(),
      }),
    )
    .min(1)
    .max(1000),
  completedIds: z.array(z.string()).max(1000),
  actions: z.array(actionSchema).max(1000),
  matchIds: z.array(z.string()).max(1000),
  summaries: z
    .array(
      z.object({
        recordIds: z.array(z.string()).min(1).max(1000),
        text: z.string().max(2000),
        model: z.string().max(200),
      }),
    )
    .max(1000),
  failedBatch: z
    .object({
      recordIds: z.array(z.string()).min(1).max(1000),
      attempts: z.number().int().min(1).max(10),
      error: z.string().max(1000),
      failedAt: z.number().int().min(0),
    })
    .optional(),
});
