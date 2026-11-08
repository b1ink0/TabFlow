import { z } from 'zod';

// Bodies contain evidence and candidate definitions, never HTTP headers or API keys.
export const inferenceReceiptSchema = z.object({
  id: z.string().min(1),
  analysisId: z.string().min(1),
  occurrenceIds: z.array(z.string().min(1)).optional(),
  contract: z.string().min(1),
  stage: z.enum(['discovery', 'taxonomy', 'project', 'classification', 'tagging']),
  model: z.string().min(1),
  startedAt: z.number().finite(),
  finishedAt: z.number().finite(),
  outcome: z.enum(['responded', 'failed']),
  request: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
});
export type InferenceReceipt = z.infer<typeof inferenceReceiptSchema>;
export type ReceiptWriter = (receipt: Omit<InferenceReceipt, 'analysisId'>) => Promise<void>;
