import { describe, expect, it } from 'vitest';
import { failureDiagnostics } from '../src/shared/assistant/failure-diagnostics';
import { assistantMessageSchema } from '../src/shared/assistant/assistant';
describe('failure diagnostics', () => {
  it('retains exact failed request evidence while excluding credentials and image payloads', () => {
    const result = failureDiagnostics({
      version: '0.1.0',
      message: assistantMessageSchema.parse({
        id: 'failed',
        role: 'assistant',
        content: 'Classifier failed',
        createdAt: 1,
        deliveryStatus: 'error',
      }),
      receipts: [
        {
          id: 'attempt',
          analysisId: 'analysis',
          model: 'fixture-model',
          contract: 'isolated-evidence-v2',
          stage: 'classification',
          startedAt: 1,
          finishedAt: 2,
          outcome: 'responded',
          request: JSON.stringify({
            messages: [
              {
                content: JSON.stringify({
                  id: '001',
                  url: 'https://example.test/reference',
                  authorization: 'secret',
                }),
              },
            ],
            apiKey: 'private-key',
            image: 'data:image/png;base64,private-image',
          }),
          response: JSON.stringify({ text: '{"choice":"c1"}' }),
        },
      ],
      models: {
        generative: 'fixture-model',
        classifier: 'fixture-model',
        tagVerification: 'chat',
        maxAttempts: 6,
      },
    });
    expect(result).toContain('https://example.test/reference');
    expect(result).toContain('001');
    expect(result).toContain('c1');
    expect(result).not.toContain('private-key');
    expect(result).not.toContain('private-image');
    expect(result).not.toContain('secret');
  });
});
