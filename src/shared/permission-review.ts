import { z } from 'zod';
export const permissionPolicySchema = z.object({
  mode: z.enum(['ask', 'review', 'all']),
  revision: z.number().int().nonnegative(),
});
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;
export const permissionDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().trim().min(1).max(1000),
});
export const permissionReviewSchema = permissionDecisionSchema.extend({
  id: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(['pending', 'complete', 'interrupted']),
  model: z.string(),
  policyRevision: z.number(),
  oneOff: z.boolean(),
  fingerprint: z.string(),
  artifactKey: z.string(),
  artifact: z.unknown(),
  packet: z.string(),
  usedAt: z.number().optional(),
});
export type PermissionReview = z.infer<typeof permissionReviewSchema>;
export type PermissionReviewSummary = Omit<PermissionReview, 'artifact' | 'packet'>;
