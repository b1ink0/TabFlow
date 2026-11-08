export function parseTagSelection(value: string | undefined): string[] {
  const parsed: unknown = JSON.parse(value || '[]');
  if (
    !Array.isArray(parsed) ||
    !parsed.every((tag) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 80)
  )
    throw new Error('Use nonempty tags, each at most 80 characters.');
  return [
    ...new Set(
      parsed.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()),
    ),
  ];
}
