import { z } from 'zod';
import type { Settings } from '../types';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
function validImageData(value: string) {
  const [header, payload] = value.split(',');
  if (!payload) return false;
  const size =
    Math.floor((payload.length * 3) / 4) -
    (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (size > MAX_IMAGE_BYTES) return false;
  try {
    const bytes = atob(payload.slice(0, 32));
    return header === 'data:image/png;base64'
      ? bytes.startsWith('\x89PNG\r\n\x1a\n')
      : header === 'data:image/jpeg;base64'
        ? bytes.startsWith('\xff\xd8\xff')
        : header === 'data:image/webp;base64' &&
          bytes.startsWith('RIFF') &&
          bytes.slice(8, 12) === 'WEBP';
  } catch {
    return false;
  }
}
export const assistantImageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(240),
  dataUrl: z
    .string()
    .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 100)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
    .refine(validImageData, 'Choose a valid PNG, JPEG or WebP image of at most 4 MB.'),
});
export const assistantImagesSchema = z
  .array(assistantImageSchema)
  .max(4)
  .superRefine((images, ctx) => {
    const bytes = images.reduce(
      (total, image) => total + Math.floor(((image.dataUrl.split(',')[1]?.length || 0) * 3) / 4),
      0,
    );
    if (bytes > 8 * 1024 * 1024)
      ctx.addIssue({ code: 'custom', message: 'Attach up to 8 MB of images in one request.' });
  });
export type AssistantImage = z.infer<typeof assistantImageSchema>;
export const supportsImageInput = (settings: Settings) =>
  Boolean(
    settings.aiModel &&
    settings.imageModel === settings.aiModel &&
    settings.imageBase === settings.aiBase,
  );
export function imageMessageContent(text: string, images: readonly AssistantImage[]) {
  return images.length
    ? [
        { type: 'text' as const, text },
        ...images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: image.dataUrl },
        })),
      ]
    : text;
}
