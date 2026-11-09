import { z } from 'zod';
import Dexie from 'dexie';
import * as db from './db';
import type { CollectionProposal, ProposalRevision } from '../shared/types';
import { tagHash } from '../shared/organization/tag-analysis';

const contentHash = ({ updatedAt: _updatedAt, ...value }: CollectionProposal) => tagHash(value);

/** Draft history is separate from applied workspace/browser Undo. */
export async function saveProposalRevision(
  before: CollectionProposal,
  after: CollectionProposal,
  label: string,
) {
  const revision: ProposalRevision = {
    id: crypto.randomUUID(),
    proposalId: before.id,
    createdAt: Math.max(Date.now(), after.updatedAt || 0),
    label,
    before,
    after,
    status: 'saved',
  };
  await db.database.transaction(
    'rw',
    db.database.collectionProposals,
    db.database.proposalRevisions,
    async () => {
      const current = await db.get('collectionProposals', before.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(before))
        throw new Error('The draft changed before saving. Reload it.');
      await db.put('proposalRevisions', revision);
      await db.put('collectionProposals', after);
    },
  );
}

export async function listProposalRevisions(proposalId: string, offset = 0) {
  z.number().int().min(0).max(100000).parse(offset);
  const rows = await db.database.proposalRevisions
    .where('[proposalId+createdAt]')
    .between([proposalId, 0], [proposalId, Number.MAX_SAFE_INTEGER])
    .reverse()
    .offset(offset)
    .limit(20)
    .toArray();
  const current = await db.get('collectionProposals', proposalId);
  const hash =
    current && current.status === 'pending' && !current.copyState
      ? await contentHash(current)
      : undefined;
  return Promise.all(
    rows.map(async ({ before, after, ...row }) => ({
      ...row,
      canUndo: row.status === 'saved' && hash === (await contentHash(after)),
      canRedo: row.status === 'undone' && hash === (await contentHash(before)),
    })),
  );
}

export async function restoreProposalRevision(raw: unknown) {
  const input = z
    .object({
      id: z.string(),
      direction: z.enum(['undo', 'redo']),
      expectedFingerprint: z.string().length(64),
    })
    .parse(raw);
  return db.database.transaction(
    'rw',
    db.database.proposalRevisions,
    db.database.collectionProposals,
    async () => {
      const revision = await db.get('proposalRevisions', input.id);
      if (!revision) throw new Error('Draft revision not found.');
      const current = await db.get('collectionProposals', revision.proposalId);
      if (!current || current.status !== 'pending' || current.copyState)
        throw new Error(
          'Only pending drafts can be reverted. Applied organization has separate Undo.',
        );
      if ((await Dexie.waitFor(tagHash(current))) !== input.expectedFingerprint)
        throw new Error('The draft changed after review. Reload its history.');
      const undo = input.direction === 'undo';
      if (
        revision.status !== (undo ? 'saved' : 'undone') ||
        (await Dexie.waitFor(contentHash(current))) !==
          (await Dexie.waitFor(contentHash(undo ? revision.after : revision.before)))
      )
        throw new Error('Later draft changes must be reverted first.');
      const restored = {
        ...(undo ? revision.before : revision.after),
        updatedAt: Math.max(Date.now(), (current.updatedAt || current.createdAt) + 1),
      };
      await db.put('collectionProposals', restored);
      await db.put('proposalRevisions', { ...revision, status: undo ? 'undone' : 'saved' });
      return restored;
    },
  );
}
