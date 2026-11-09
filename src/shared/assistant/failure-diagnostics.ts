import type { AssistantMessage } from './assistant';
import type { InferenceReceipt } from '../inference/inference-receipt';

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|api[-_]?key|aiKey|smallModelKey|decisionKey|access[-_]?token|refresh[-_]?token)$/i.test(
          key,
        )
          ? '[redacted]'
          : scrub(item),
      ]),
    );
  if (typeof value === 'string') {
    try {
      if (/^\s*(?:\[|\{)/.test(value)) return scrub(JSON.parse(value));
    } catch {
      /* Retain non-JSON text below. */
    }
    return value.replace(/data:image\/[^\s"']+/gi, '[image data excluded]');
  }
  return value;
}

export function failureDiagnostics(input: {
  version: string;
  message: AssistantMessage;
  question?: string;
  receipts: InferenceReceipt[];
  progress?: unknown;
  tools?: unknown;
  models: { generative: string; classifier: string; tagVerification: string; maxAttempts: number };
  warnings?: string[];
}) {
  const { images, ...request } = input.message.request || {};
  return JSON.stringify(
    scrub({
      product: 'TabFlow',
      version: input.version,
      copiedAt: new Date().toISOString(),
      question: input.question,
      failure: {
        messageId: input.message.id,
        status: input.message.deliveryStatus,
        error: input.message.content,
        outcome: input.message.outcome,
        recentProgress: input.message.activity.slice(-20),
        analysisFailure: input.message.analysisFailure,
      },
      scope: { ...request, attachedImages: images?.length || 0 },
      models: input.models,
      progress: input.progress,
      recentToolActivity: input.tools,
      relevantInferenceAttempts: input.receipts,
      warnings: input.warnings,
    }),
    null,
    2,
  );
}
