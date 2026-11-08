import Dexie, { type Table } from 'dexie';
import type { DatabaseEntities, StoreName } from '../shared/types';
import { assistantThreadSchema } from '../shared/assistant';

class TabFlowDatabase extends Dexie {
  assistantThreadSummaries!: Table<DatabaseEntities['assistantThreadSummaries'], string>;
  proposalRevisions!: Table<DatabaseEntities['proposalRevisions'], string>;
  permissionReviews!: Table<DatabaseEntities['permissionReviews'], string>;
  assistantChanges!: Table<DatabaseEntities['assistantChanges'], string>;
  tagAnalyses!: Table<DatabaseEntities['tagAnalyses'], string>;
  inferenceReceipts!: Table<DatabaseEntities['inferenceReceipts'], string>;
  assistantAudit!: Table<DatabaseEntities['assistantAudit'], string>;
  actionAnalyses!: Table<DatabaseEntities['actionAnalyses'], string>;
  collectionAnalyses!: Table<DatabaseEntities['collectionAnalyses'], string>;
  sessions!: Table<DatabaseEntities['sessions'], string>;
  previews!: Table<DatabaseEntities['previews'], string>;
  migrations!: Table<DatabaseEntities['migrations'], string>;
  assistantThreads!: Table<DatabaseEntities['assistantThreads'], string>;
  records!: Table<DatabaseEntities['records'], string>;
  projects!: Table<DatabaseEntities['projects'], string>;
  areas!: Table<DatabaseEntities['areas'], string>;
  workItems!: Table<DatabaseEntities['workItems'], string>;
  categories!: Table<DatabaseEntities['categories'], string>;
  memberships!: Table<DatabaseEntities['memberships'], string>;
  proposals!: Table<DatabaseEntities['proposals'], string>;
  collectionProposals!: Table<DatabaseEntities['collectionProposals'], string>;
  organizationJobs!: Table<DatabaseEntities['organizationJobs'], string>;
  snapshots!: Table<DatabaseEntities['snapshots'], string>;
  operations!: Table<DatabaseEntities['operations'], string>;
  jobs!: Table<DatabaseEntities['jobs'], string>;
  constructor() {
    super('tabloom');
    this.version(1).stores({
      records: 'id,url,projectId,lastAccessed,tabId',
      projects: 'id,name',
      snapshots: 'id,createdAt',
      operations: 'id,createdAt,status',
      jobs: 'id,createdAt,status',
    });
    this.version(2)
      .stores({
        records: 'id,url,projectId,lastAccessed,tabId',
        projects: 'id,name',
        categories: 'id,projectId,[projectId+name]',
        memberships: 'recordId,projectId,categoryId,[projectId+categoryId]',
        snapshots: 'id,createdAt',
        operations: 'id,createdAt,status',
        jobs: 'id,createdAt,status',
      })
      .upgrade(async (tx) => {
        await tx
          .table('projects')
          .toCollection()
          .modify(
            (project: { purpose?: string; revision?: number; maintainReviewQueue?: boolean }) => {
              project.purpose ??= '';
              project.revision ??= 1;
              project.maintainReviewQueue ??= false;
            },
          );
      });
    this.version(3).stores({
      records: 'id,url,projectId,lastAccessed,tabId',
      projects: 'id,name',
      categories: 'id,projectId,[projectId+name]',
      memberships: 'recordId,projectId,categoryId,[projectId+categoryId]',
      proposals: 'id,projectId,status,createdAt',
      snapshots: 'id,createdAt',
      operations: 'id,createdAt,status',
      jobs: 'id,createdAt,status',
    });
    this.version(4).stores({
      records: 'id,url,projectId,lastAccessed,tabId',
      projects: 'id,name',
      categories: 'id,projectId,[projectId+name]',
      memberships: 'recordId,projectId,categoryId,[projectId+categoryId]',
      proposals: 'id,projectId,status,createdAt',
      organizationJobs:
        'id,projectId,recordId,status,createdAt,leaseUntil,[recordId+url+navigationVersion]',
      snapshots: 'id,createdAt',
      operations: 'id,createdAt,status',
      jobs: 'id,createdAt,status',
    });
    this.version(5).stores({
      records: 'id,url,projectId,lastAccessed,tabId',
      projects: 'id,name',
      areas: 'id,name,updatedAt',
      workItems: 'id,status,priority,dueAt,areaId,projectId,recordId,updatedAt',
      categories: 'id,projectId,[projectId+name]',
      memberships: 'recordId,projectId,categoryId,[projectId+categoryId]',
      proposals: 'id,projectId,status,createdAt',
      organizationJobs:
        'id,projectId,recordId,status,createdAt,leaseUntil,[recordId+url+navigationVersion]',
      snapshots: 'id,createdAt',
      operations: 'id,createdAt,status',
      jobs: 'id,createdAt,status',
    });
    this.version(6)
      .stores({
        records: 'id,url,projectId,lastAccessed,tabId',
        projects: 'id,name,areaId',
        areas: 'id,name,updatedAt',
        workItems: 'id,status,priority,dueAt,areaId,projectId,recordId,updatedAt',
        categories: 'id,projectId,[projectId+name]',
        memberships: 'recordId,projectId,categoryId,[projectId+categoryId]',
        proposals: 'id,projectId,status,createdAt',
        collectionProposals: 'id,status,createdAt',
        organizationJobs:
          'id,projectId,recordId,status,createdAt,leaseUntil,[recordId+url+navigationVersion]',
        snapshots: 'id,createdAt',
        operations: 'id,createdAt,status',
        jobs: 'id,createdAt,status',
      })
      .upgrade(async (tx) => {
        await tx
          .table('projects')
          .toCollection()
          .modify((project: { areaId?: string | null }) => {
            project.areaId ??= null;
          });
      });
    this.version(7).stores({ assistantThreads: 'id,updatedAt,projectId,status' });
    this.version(8).stores({ previews: 'id,capturedAt', migrations: 'id,createdAt,status' });
    this.version(9).stores({ sessions: 'id' });
    this.version(10).stores({ collectionAnalyses: 'id,updatedAt' });
    this.version(11).stores({ actionAnalyses: 'id,updatedAt,status' });
    this.version(12).stores({
      assistantAudit: 'id,messageId,[messageId+sequence]',
      inferenceReceipts: 'id,analysisId,[analysisId+startedAt]',
    });
    this.version(13).stores({ tagAnalyses: 'id,analysisId,[analysisId+recordId]' });
    this.version(14).stores({ assistantChanges: 'id,threadId,messageId,createdAt,status' });
    this.version(15).stores({
      permissionReviews: 'id,threadId,messageId,[messageId+createdAt],createdAt,status',
    });
    this.version(16).stores({
      proposalRevisions: 'id,proposalId,createdAt,[proposalId+createdAt]',
    });
    this.version(17)
      .stores({ assistantThreadSummaries: 'id,updatedAt,projectId,status' })
      .upgrade(async (tx) => {
        await tx.table('assistantThreads').each((raw: unknown) => {
          const parsed = assistantThreadSchema.safeParse(raw);
          if (parsed.success) {
            const { messages: _messages, ...summary } = parsed.data;
            void tx.table('assistantThreadSummaries').put(summary);
          }
        });
      });
  }
}
export const database = new TabFlowDatabase();
function table<K extends StoreName>(name: K): Table<DatabaseEntities[K], string> {
  return database.table(name);
}
export const all = <K extends StoreName>(name: K) => table(name).toArray();
export const get = <K extends StoreName>(name: K, id: string | null | undefined) =>
  id ? table(name).get(id) : Promise.resolve(undefined);
export const put = <K extends StoreName>(name: K, value: DatabaseEntities[K]) => {
  if (name === 'assistantThreads') {
    const { messages: _messages, ...summary } = assistantThreadSchema.parse(value);
    return database.transaction(
      'rw',
      database.assistantThreads,
      database.assistantThreadSummaries,
      async () => {
        await database.assistantThreadSummaries.put(summary);
        return table(name).put(value);
      },
    );
  }
  return table(name).put(value);
};
export const remove = <K extends StoreName>(name: K, id: string) => table(name).delete(id);
