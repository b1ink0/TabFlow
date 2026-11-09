/** A router prediction cannot authorize an unrelated bulk tagging pipeline. */
export function allowsProposalTagShortcut(request: string): boolean {
  return (
    /\b(tags?|tagging)\b/i.test(request) &&
    !/\b(merge|combine|rename|remove|delete|categor(?:y|ies)|projects?)\b/i.test(request)
  );
}
