import { z } from 'zod';
import { reviewTool } from './review-tool';

interface CatalogTool {
  function: { name: string; description?: string; parameters?: unknown };
  $callback?: unknown;
  $parseRaw?: unknown;
}
export const compactToolNames = new Set([
  'search_workspace_tools',
  'run_workspace_tool',
  'read_workspace',
  'list_tabs',
  'list_tags',
  'read_tab_evidence',
  'search_work',
  'search_workspace_entities',
  'read_entity_tabs',
  'read_tab_branch',
  'read_project_context',
  'analyze_proposal_tags',
  'analyze_workspace_tags',
  'read_tab_metadata',
  'prepare_organization_application',
]);

/** Keep every capability callable without sending every schema in a constrained context. */
export function discoverableTools<T extends CatalogTool>(tools: T[]) {
  const seen = new Set<string>();
  const search = reviewTool({
    name: 'search_workspace_tools',
    description: `Find validated tool schemas for a task. Read the returned schema, then invoke run_workspace_tool with its name and a JSON arguments string. All capabilities remain available: ${tools.map((tool) => tool.function.name).join(', ')}.`,
    parameters: z.object({
      query: z.string().max(300),
      offset: z.number().int().min(0).max(100000),
    }),
    function: ({ query, offset }) => {
      const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const matches = tools
        .filter((tool) =>
          words.every((word) =>
            `${tool.function.name.replaceAll('_', ' ')} ${tool.function.name} ${tool.function.description}`
              .toLowerCase()
              .includes(word),
          ),
        )
        .sort((left, right) => {
          const score = (tool: T) =>
            words.reduce(
              (total, word) =>
                total +
                (tool.function.name.replaceAll('_', ' ').includes(word) ||
                tool.function.name.includes(word)
                  ? 10
                  : 1),
              0,
            );
          return score(right) - score(left);
        });
      const page = matches.slice(offset, offset + 2);
      for (const tool of page) seen.add(tool.function.name);
      return JSON.stringify({
        total: matches.length,
        nextOffset: offset + 2 < matches.length ? offset + 2 : null,
        tools: page.map((tool) => tool.function),
      });
    },
  });
  const execute = reviewTool({
    name: 'run_workspace_tool',
    fatalOnFailure: true,
    description:
      'Invoke one discovered workspace tool. Use the exact returned name and a JSON object encoded as argumentsJson. The original tool parser, scope, permission and persistence checks still apply. Search its schema before invoking it. This is not permission to apply actions.',
    parameters: z.object({
      name: z.string().min(1).max(200),
      argumentsJson: z.string().min(2).max(250000),
    }),
    function: async ({ name, argumentsJson }) => {
      const tool = tools.find((item) => item.function.name === name);
      if (!tool || !seen.has(name))
        return JSON.stringify({
          ok: false,
          tool: name,
          error: 'Search workspace tools for this exact tool schema before invoking it.',
          applied: false,
        });
      const parse = z.function({ input: [z.string()], output: z.unknown() }).parse(tool.$parseRaw);
      const callback = z
        .function({ input: [z.unknown()], output: z.unknown() })
        .parse(tool.$callback);
      let args: unknown;
      try {
        args = parse(argumentsJson);
      } catch (error) {
        return JSON.stringify({
          ok: false,
          tool: name,
          error: error instanceof Error ? error.message : 'Invalid tool arguments',
          applied: false,
        });
      }
      return await callback(args);
    },
  });
  return [search, execute];
}
