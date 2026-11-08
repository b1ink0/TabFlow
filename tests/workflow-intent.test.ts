import { describe, it, expect } from 'vitest';
import { allowsProposalTagShortcut } from '../src/ai/workflow-intent';
describe('proposal workflow intent', () => {
  it('never turns structural edits into automatic tagging even after a router false positive', () => {
    expect(
      allowsProposalTagShortcut(
        'Frappe Component Library and rtCamp React UI Library are same so merge them',
      ),
    ).toBe(false);
    expect(allowsProposalTagShortcut('Rename the project')).toBe(false);
    expect(allowsProposalTagShortcut('Merge the categories and review tags')).toBe(false);
  });
  it('allows explicit tagging shortcuts while leaving ambiguous requests to tools', () => {
    expect(allowsProposalTagShortcut('assign tags to all tabs now')).toBe(true);
    expect(allowsProposalTagShortcut('fix this draft')).toBe(false);
  });
});
