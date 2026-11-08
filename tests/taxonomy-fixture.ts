import { vi } from 'vitest';
import { z } from 'zod';
// Older workflow fixtures use an identity reconciliation provider; dedicated tests exercise semantic merges.
export function stubFetch(
  name: 'fetch',
  provider: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: { taxonomy?: boolean; tags?: boolean } = {},
) {
  vi.stubGlobal(name, async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = z
      .object({
        response_format: z.object({ json_schema: z.object({ name: z.string() }) }).optional(),
        messages: z.array(z.object({ content: z.string().nullable().optional() })).optional(),
      })
      .passthrough()
      .safeParse(init?.body ? JSON.parse(String(init.body)) : {});
    if (
      parsed.success &&
      options.tags !== false &&
      parsed.data.response_format?.json_schema.name === 'tabflow_tag_verification'
    ) {
      const data = z
        .object({ labels: z.array(z.string()) })
        .parse(JSON.parse(parsed.data.messages?.at(-1)?.content || '{}'));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  Object.fromEntries(data.labels.map((label) => [label, 'accepted'])),
                ),
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (
      parsed.success &&
      options.tags !== false &&
      parsed.data.response_format?.json_schema.name === 'tabflow_tag_proposal'
    )
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ tags: [], newTags: [], uncertain: false }) },
              finish_reason: 'stop',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    if (
      parsed.success &&
      options.taxonomy !== false &&
      parsed.data.response_format?.json_schema.name === 'taxonomy_reconciliation'
    ) {
      const project = z.object({
        name: z.string(),
        purpose: z.string(),
        areaName: z.string(),
        categories: z.array(z.object({ name: z.string(), description: z.string() })),
      });
      const data = z
        .object({
          activity: project.optional(),
          catalog: z.array(z.object({ name: z.string() })).optional(),
          sourceCategories: z
            .array(z.object({ name: z.string(), description: z.string() }))
            .optional(),
        })
        .parse(JSON.parse(parsed.data.messages?.at(-1)?.content || '{}'));
      const activity = data.activity;
      const value = activity
        ? {
            existingProjectName:
              data.catalog?.find((item) => item.name === activity.name)?.name || null,
            reason: 'Identity workflow fixture',
            name: activity.name,
            purpose: activity.purpose,
            areaName: activity.areaName,
          }
        : {
            mappings: (data.sourceCategories || []).map((item) => ({ source: item.name, ...item })),
          };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return provider(input, init);
  });
}
