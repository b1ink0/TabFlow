import { describe, it, expect } from 'vitest';
import { assistantImagesSchema, supportsImageInput } from '../src/shared/assistant-images';
import { assistantRequestSchema } from '../src/shared/assistant';
import { retryTurn } from '../src/shared/assistant-retry';
import { assistantThreadSchema } from '../src/shared/assistant';
import { DEFAULTS } from '../src/shared/model';
import { boundOrchestratorRequest } from '../src/ai/request-context';
const image = {
  id: 'image',
  name: 'reference.png',
  dataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
};
describe('image request continuity', () => {
  it('rejects wrong data, remote URLs and too many images and binds support to the exact model and endpoint', () => {
    expect(assistantImagesSchema.parse([image])).toEqual([image]);
    expect(() =>
      assistantImagesSchema.parse([{ ...image, dataUrl: 'https://example.test/image.png' }]),
    ).toThrow();
    expect(() =>
      assistantImagesSchema.parse([
        { ...image, dataUrl: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' },
      ]),
    ).toThrow();
    expect(() => assistantImagesSchema.parse(Array.from({ length: 5 }, () => image))).toThrow();
    expect(
      supportsImageInput({
        ...DEFAULTS,
        aiModel: 'vision',
        imageModel: 'vision',
        imageBase: DEFAULTS.aiBase,
      }),
    ).toBe(true);
    expect(
      supportsImageInput({
        ...DEFAULTS,
        aiModel: 'other',
        imageModel: 'vision',
        imageBase: DEFAULTS.aiBase,
      }),
    ).toBe(false);
  });
  it('retains images on the saved original request when retrying an answer', () => {
    const request = assistantRequestSchema.parse({
      task: 'work',
      images: [image],
      recordIds: [],
      selectedRecordIds: [],
      projectId: null,
      allowCrossWindowMove: false,
      allowSleepWake: false,
    });
    const thread = assistantThreadSchema.parse({
      id: 'chat',
      title: 'Image',
      createdAt: 1,
      updatedAt: 1,
      projectId: null,
      status: 'ready',
      messages: [
        { id: 'user', role: 'user', content: 'What is here?', request, createdAt: 1 },
        {
          id: 'answer',
          role: 'assistant',
          content: 'Answer',
          request,
          requestMessageId: 'user',
          parentMessageId: 'user',
          deliveryStatus: 'error',
          createdAt: 2,
        },
      ],
    });
    expect(retryTurn(thread, 'answer', true).request.images).toEqual([image]);
  });
  it('retains image bytes while bounding text context instead of treating base64 as prose tokens', () => {
    const imageUrl = 'data:image/png;base64,' + 'A'.repeat(30000);
    const request = {
      messages: [
        { role: 'system', content: 'Follow owner instructions' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the image' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    };
    expect(boundOrchestratorRequest(request, 4000)).toEqual(request);
  });
});
