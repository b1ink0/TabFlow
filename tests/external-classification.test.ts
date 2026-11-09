import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/shared/types';
import { DEFAULTS, newRecord } from '../src/shared/model';
import {
  externalClassification,
  externalClassificationScope,
} from '../src/shared/organization/external-classification';

describe('external classification packet', () => {
  it('exports only scoped open occurrences without cache or URL secrets and includes protection context', () => {
    const record = {
      ...newRecord('https://user:password@example.test/item?token=secret#fragment', 'one'),
      live: true,
      locked: true,
      note: 'Owner note',
      tags: ['reference'],
    };
    const app: AppState = {
      records: [record, { ...record, id: 'duplicate' }, { ...record, id: 'closed', live: false }],
      projects: [],
      areas: [],
      workItems: [],
      categories: [],
      memberships: [],
      proposals: [],
      collectionProposals: [],
      organizationJobs: [],
      windows: [],
      groups: [],
      snapshots: [],
      operations: [],
      jobs: [],
      settings: DEFAULTS,
      version: 'test',
    };
    const packet = externalClassification(app, ['one', 'closed']);
    expect(packet.data.tabs).toHaveLength(1);
    expect(packet.data.tabs[0]).toMatchObject({
      occurrenceId: 'one',
      protected: true,
      tags: ['reference'],
      url: 'https://example.test/item',
    });
    expect(JSON.stringify(packet.data)).not.toContain('password');
    expect(JSON.stringify(packet.data)).not.toContain('secret');
    expect(packet.instructions).toContain('Every supplied occurrence');
    expect(externalClassification(app, ['one', 'duplicate']).data.tabs).toHaveLength(2);
    expect(() => externalClassification(app, ['closed'])).toThrow('no open tabs');
    expect(packet.instructions).toContain('complete user request');
    expect(packet.instructions).toContain('No additional pasted prompt');
    expect(packet.instructions).toContain('tabflow-organization-proposal.json');
    expect(packet.data.scope.occurrenceIds).toEqual(['one']);
    expect(packet.instructions).toContain(JSON.stringify(packet.data.scope));

    app.windows = [
      { id: 10, focused: true, projectId: null },
      { id: 20, focused: false, projectId: null },
    ];
    app.records[0]!.windowId = 10;
    app.records[1]!.windowId = 20;
    expect(externalClassificationScope(app, 'all').ids).toEqual(['one', 'duplicate']);
    expect(externalClassificationScope(app, 'window:10')).toMatchObject({
      kind: 'window',
      ids: ['one'],
    });
    expect(
      externalClassificationScope(app, 'selection', ['duplicate', 'closed', 'unknown']).ids,
    ).toEqual(['duplicate']);
    expect(() => externalClassificationScope(app, 'window:999')).toThrow('no longer open');
    expect(() => externalClassificationScope(app, 'bad-scope')).toThrow('valid export scope');

    app.projects = [
      {
        id: 'p',
        name: 'My project',
        purpose: 'Work',
        revision: 1,
        updatedAt: 1,
        maintainReviewQueue: false,
      },
    ];
    app.records[0]!.projectId = 'p';
    app.memberships = [
      { recordId: 'one', projectId: null, categoryId: null, source: 'owner', updatedAt: 1 },
      {
        recordId: 'duplicate',
        projectId: 'p',
        categoryId: null,
        source: 'accepted-ai',
        updatedAt: 1,
      },
    ];
    const projectScope = externalClassificationScope(app, 'project:p');
    expect(projectScope.ids).toEqual(['duplicate']);
    const projectPacket = externalClassification(app, projectScope.ids, false, projectScope);
    expect(projectPacket.data.scope).toMatchObject({
      kind: 'project',
      label: 'Project: My project',
      occurrenceCount: 1,
    });
    expect(projectPacket.instructions).toContain('Do not claim this scope is the whole browser');
    expect(projectPacket.data.tabs[0]?.currentProject).toBe('My project');
  });
});
