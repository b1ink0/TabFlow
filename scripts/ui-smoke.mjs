import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { documentationState, documentationIcon } from './docs-fixture.mjs';

const chromiumPath = process.env.TABFLOW_CHROMIUM_PATH || process.env.TABLOOM_CHROMIUM_PATH;
const chromiumChannel =
  process.env.TABFLOW_CHROMIUM_CHANNEL || process.env.TABLOOM_CHROMIUM_CHANNEL;

const root = path.resolve('.output/chrome-mv3');
const { version: applicationVersion } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
async function settingsSection(page, label) {
  const back = page.getByRole('button', { name: 'Back to settings', exact: true });
  if (await back.count()) await back.click();
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: label, exact: true })
    .click();
}
async function activateWorkspaceAction(page, name) {
  const button = page.getByRole('button', { name, exact: true });
  if (await button.count()) {
    await button.first().click();
    return;
  }
  const menu = page.getByRole('button', {
    name: ['Select tabs', 'Reveal current tab'].includes(name)
      ? 'Tab list actions'
      : (await page.getByRole('button', { name: 'Workspace menu', exact: true }).count())
        ? 'Workspace menu'
        : 'Assistant menu',
    exact: true,
  });
  await menu.click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
// Entirely fictional public demo collection, independent of any browsing history.
const fixtures = [
  [
    'Harbor Library - The Glass Orchard catalog',
    'https://example.test/library/projects',
    1,
    10,
    false,
  ],
  ['Reading notes: The Glass Orchard', 'https://example.test/library/reading/notes', 1, 10, true],
  [
    'Discussion evening: reader reservations',
    'https://example.test/library/events/evening',
    1,
    10,
    true,
  ],
  ['Harbor Library catalog help', 'https://example.test/library/help/catalog', 1, 11, true],
  ['Harbor Library membership guide', 'https://example.test/library/help/membership', 1, 11, true],
  [
    'Field notes - Espa\u00f1ol / Fran\u00e7ais / English - full titles remain visible',
    'https://example.test/garden/field-notes',
    1,
    -1,
    true,
  ],
  [
    'Canyon Garden - Seasonal planting calendar',
    'https://example.test/garden/calendar',
    2,
    20,
    false,
  ],
  ['Canyon Garden seed inventory', 'https://example.test/garden/seeds', 2, 20, true],
  ['Canyon Garden watering reference', 'https://example.test/garden/watering', 2, 20, true],
  ['Canyon Garden compost guide', 'https://example.test/garden/compost', 2, 21, true],
];
const records = fixtures.map(([title, url, windowId, groupId, suspended], i) => ({
  id: `record-${i}`,
  url,
  title,
  createdAt: Date.now(),
  navigationVersion: 0,
  tabId: i + 10,
  windowId,
  index: i,
  groupId,
  pinned: false,
  suspended,
  foreignSuspended: false,
  active: !suspended,
  audible: false,
  lastAccessed: Date.now() - i * 3600000,
  lastSeen: Date.now(),
  live: true,
  wasOpen: true,
  projectId: windowId === 1 ? 'library' : 'garden',
  locked: i === 3,
  note: '',
  tags: [],
  scroll: 0,
  activations: 15 - i,
  focusedMs: 120000 * i,
  content:
    i % 2 === 0
      ? {
          description: 'Cached page context',
          headings: ['Project documentation'],
          text: 'Useful research',
          capturedAt: Date.now(),
          url,
          scroll: 0,
          dirty: false,
          playing: false,
        }
      : null,
}));
const state = {
  records,
  areas: [],
  workItems: [],
  categories: [],
  memberships: [],
  proposals: [],
  collectionProposals: [
    {
      id: 'partial-review-fixture',
      createdAt: Date.now(),
      status: 'pending',
      summary: 'Partial organization awaiting remaining tabs.',
      tagReview: [
        {
          recordId: 'record-0',
          tags: [
            { name: 'Book club', outcome: 'new' },
            { name: 'Reference', outcome: 'uncertain' },
          ],
        },
      ],
      projects: [
        {
          name: 'Research',
          purpose: 'Sources',
          areaName: 'Personal',
          categories: [{ name: 'Sources', description: 'References' }],
        },
        {
          name: 'Reading',
          purpose: 'Articles and guides',
          areaName: 'Personal',
          categories: [{ name: 'Articles', description: 'Reading list' }],
        },
      ],
      assignments: [],
      unresolvedRecordIds: ['record-0', 'record-1'],
      scopeRecordIds: ['record-0', 'record-1'],
    },
    {
      id: 'second-review-fixture',
      createdAt: Date.now() - 1000,
      status: 'pending',
      summary: 'Independent personal references proposal.',
      projects: [
        {
          name: 'Personal references',
          purpose: 'Daily reading',
          areaName: 'Personal',
          categories: [{ name: 'Reading', description: 'Articles' }],
        },
      ],
      assignments: [],
      unresolvedRecordIds: ['record-6'],
      scopeRecordIds: ['record-6'],
    },
  ],
  organizationJobs: [],
  projects: [
    { id: 'library', name: 'Harbor Library', updatedAt: 1 },
    { id: 'garden', name: 'Canyon Garden', updatedAt: 1 },
    { id: 'personal', name: 'Personal research', updatedAt: 1 },
  ],
  windows: [
    { id: 1, focused: true, projectId: 'library' },
    { id: 2, focused: false, projectId: 'garden' },
  ],
  groups: [
    { id: 10, windowId: 1, title: 'Catalog', color: 'blue', collapsed: false },
    { id: 11, windowId: 1, title: 'Reading', color: 'green', collapsed: false },
    { id: 20, windowId: 2, title: 'Plant care', color: 'purple', collapsed: false },
    { id: 21, windowId: 2, title: 'Resources', color: 'cyan', collapsed: false },
  ],
  snapshots: [],
  operations: [],
  jobs: [],
  settings: {
    autoSuspend: false,
    suspendMinutes: 60,
    protectPinned: true,
    protectAudio: true,
    protectForms: true,
    protectGrouped: false,
    neverSuspendSites: '',
    pauseSuspensionOffline: true,
    wakeOnFocus: false,
    restoreScroll: true,
    capturePreviews: false,
    previewExcludedSites: '',
    discardPlaceholders: false,
    autoIndex: true,
    textLimit: 10000,
    snapshotRetention: 100,
    backupEnabled: false,
    backupHours: 24,
    aiProvider: 'lmstudio',
    aiBase: 'http://127.0.0.1:1234/v1',
    aiModel: 'local-instruct/demo-chat-12b-with-a-long-local-provider-identifier',
    aiKey: '',
    budBase: 'http://127.0.0.1:8420',
    budModel: 'laya',
    aiBatchSize: 35,
    aiEvidenceCharacters: 64000,
  },
  version: applicationVersion,
};
if (process.env.TABFLOW_PERF === '1') {
  const sample = records[0];
  records.push(
    ...Array.from({ length: 500 }, (_, index) => ({
      ...sample,
      id: `performance-${index}`,
      title: `Performance tab ${index}`,
      url: `https://example.test/performance/${index}`,
      index: index + 10,
    })),
  );
  const snapshotWindows = [{ ...state.windows[0], tabs: records.slice(0, 10) }];
  state.snapshots = Array.from({ length: 500 }, (_, index) => ({
    id: `snapshot-${index}`,
    label: `Performance snapshot ${index}`,
    automatic: false,
    createdAt: Date.now() - index * 1000,
    windows: snapshotWindows,
    windowCount: 1,
    tabCount: 10,
  }));
  state.operations = Array.from({ length: 500 }, (_, index) => ({
    id: `operation-${index}`,
    snapshotId: `snapshot-${index}`,
    createdAt: Date.now() - index * 1000,
    summary: `Performance operation ${index}`,
    status: 'complete',
    actionCount: 0,
    affectedOccurrences: 0,
    successfulActions: 30,
    failedActions: 0,
    errors: [],
    actions: [],
    results: Array.from({ length: 30 }, () => ({
      action: { type: 'suspend', recordIds: [] },
      ok: true,
    })),
  }));
}
const completionRequests = [];
if (process.env.TABFLOW_UI_FOCUS === 'docs') documentationState(state);
const server = createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'fixture-chat-fast', object: 'model' },
            { id: 'fixture-chat-large', object: 'model' },
          ],
        }),
      );
      return;
    }
    if (pathname === '/v1/chat/completions') {
      let requestBody = '';
      for await (const chunk of req) requestBody += chunk;
      const parsedRequest = JSON.parse(requestBody);
      completionRequests.push(parsedRequest);
      res.setHeader('Content-Type', 'application/json');
      if (
        parsedRequest.messages.at(-1)?.role === 'user' &&
        ['Prepare synthetic workspace edits', 'Apply synthetic workspace edits'].includes(
          parsedRequest.messages.at(-1)?.content,
        )
      ) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1500));
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'synthetic-edit-call',
                      type: 'function',
                      function: {
                        name: 'prepare_workspace_edits',
                        arguments: JSON.stringify({
                          summary: 'Label this reference and save a note',
                          edits: [
                            {
                              kind: 'tags',
                              recordId: 'record-0',
                              mode: 'add',
                              tags: ['reference'],
                            },
                            {
                              kind: 'note',
                              recordId: 'record-0',
                              note: 'Read the catalog introduction',
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Recovered the saved synthetic request.',
                reasoning_content: 'Synthetic provider reasoning for this test only.',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    if (pathname.startsWith('/_favicon/') && process.env.TABFLOW_UI_FOCUS === 'docs') {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(
        documentationIcon(
          new URL(req.url, 'http://fixture.test').searchParams.get('pageUrl') ||
            'https://example.test',
        ),
      );
      return;
    }
    if (pathname.startsWith('/_favicon/')) pathname = '/icons/16.png';
    const file = path.join(root, pathname);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    const body = await readFile(file);
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.png')
            ? 'image/png'
            : file.endsWith('.svg')
              ? 'image/svg+xml'
              : file.endsWith('.woff2')
                ? 'font/woff2'
                : 'text/html',
    );
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
state.settings.aiBase = `${base}/v1`;
state.settings.aiStreamResponses = false;
if (process.env.TABFLOW_UI_FOCUS === 'compact-ui') {
  state.settings.imageModel = state.settings.aiModel;
  state.settings.imageBase = state.settings.aiBase;
}
const browser = await chromium.launch({
  channel: chromiumChannel || undefined,
  executablePath: chromiumPath || undefined,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
await mkdir('artifacts', { recursive: true });
const errors = [];
try {
  for (const [width, height, label] of [
    [1440, 1000, 'desktop'],
    [1100, 900, 'compact'],
    [420, 900, 'mobile'],
  ].filter(
    (entry) =>
      (process.env.TABFLOW_PERF !== '1' && !process.env.TABFLOW_UI_FOCUS) || entry[2] === 'desktop',
  )) {
    const fixtureContext = await browser.newContext({ viewport: { width, height } });
    const remoteIconRequests = [];
    await fixtureContext.route(
      /https:\/\/(?:api\.iconify\.design|api\.simplesvg\.com|api\.unisvg\.com)\//,
      (route) => {
        remoteIconRequests.push(route.request().url());
        return route.abort();
      },
    );
    const page = await fixtureContext.newPage();
    page.on('pageerror', (e) => {
      errors.push(e.message);
      console.error('UI runtime error:', e.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
        errors.push(message.text());
        console.error('Browser error:', message.text());
      }
    });
    await page.addInitScript(() => {
      window.__routeLongTasks = [];
      new window.PerformanceObserver((entries) =>
        window.__routeLongTasks.push(...entries.getEntries().map((entry) => entry.duration)),
      ).observe({ type: 'longtask', buffered: true });
    });
    await page.addInitScript(
      ({ state, base }) => {
        const local = { chat: [] };
        if (window.sessionStorage.getItem('testCollectionAnalysis') === 'true') {
          Object.assign(state.settings, {
            useDedicatedDecisionModel: false,
            smallModel: 'fixture-small',
            smallModelBase: base + '/v1',
            smallContextTokens: 32768,
            smallCompletionTokens: 1024,
            aiContextTokens: 32768,
            aiCompletionTokens: 4096,
          });
          local.collectionAnalysis = {
            id:
              window.localStorage.getItem('tabflow.collection.analysisId') ||
              'projects:whole-collection',
            createdAt: 1,
            updatedAt: 1,
            revision: 1,
            purpose: 'proposal',
            instruction: '',
            reuseAcceptedTaxonomyOnly: false,
            scope: state.records.map(({ id, url, navigationVersion }) => ({
              id,
              url,
              navigationVersion,
            })),
            discoveredIds: state.records.map((record) => record.id),
            classifiedIds: [],
            projects: [],
            summaries: [],
            assignments: [],
            unresolvedRecordIds: [],
            tagVocabulary: ['research'],
            tagChecks: [],
          };
        }

        window.__collectionAnalysisFixture = () => local.collectionAnalysis;
        window.__completedCollectionAnalysisFixture = async () => {
          const record = state.records.find(
            (record) =>
              record.live &&
              !record.locked &&
              !state.memberships.some(
                (item) => item.recordId === record.id && item.source === 'owner',
              ),
          );
          local.collectionAnalysis = {
            ...local.collectionAnalysis,
            decisionContract: 'isolated-evidence-v2',
            reuseAcceptedTaxonomyOnly: true,
            scope: [
              { id: record.id, url: record.url, navigationVersion: record.navigationVersion },
            ],
            discoveredIds: [record.id],
            classifiedIds: [record.id],
            projects: [
              {
                name: 'Synthetic project',
                purpose: 'Fixture references',
                areaName: 'Personal',
                categories: [{ name: 'Sources', description: 'Reference pages' }],
              },
            ],
            assignments: [],
            unresolvedRecordIds: [record.id],
            tagVocabulary: [],
            tagChecks: [],
          };
          const digest = async (value) =>
            [
              ...new Uint8Array(
                await window.crypto.subtle.digest(
                  'SHA-256',
                  new window.TextEncoder().encode(JSON.stringify(value)),
                ),
              ),
            ]
              .map((value) => value.toString(16).padStart(2, '0'))
              .join('');
          const cached = record.content?.url === record.url ? record.content : undefined;
          const evidenceKey = await digest({
            title: record.title.slice(0, 500),
            url: record.url.slice(0, 2000),
            note: record.note.slice(0, 500),
            text: cached
              ? [cached.description, ...cached.headings, cached.text].join('\n').slice(0, 10000)
              : '',
            existingTags: record.tags,
            navigationVersion: record.navigationVersion,
          });
          const catalogKey = await digest([]);
          local.tagRows = [
            {
              id: JSON.stringify([local.collectionAnalysis.id, record.id, evidenceKey, catalogKey]),
              analysisId: local.collectionAnalysis.id,
              recordId: record.id,
              url: record.url,
              navigationVersion: record.navigationVersion,
              evidenceKey,
              catalogKey,
              contract: 'bounded-tags-v1',
              revision: 1,
              updatedAt: Date.now(),
              cursor: 0,
              status: 'complete',
              proposalModel: 'fixture',
              tags: [],
              newTags: [],
              uncertain: false,
              decisions: [],
            },
          ];
          await new Promise((resolve, reject) => {
            const open = window.indexedDB.open('tabloom');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction(
                ['collectionAnalyses', 'tagAnalyses'],
                'readwrite',
              );
              tx.objectStore('collectionAnalyses').put(local.collectionAnalysis);
              tx.objectStore('tagAnalyses').put(local.tagRows[0]);
              tx.oncomplete = () => {
                open.result.close();
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
          });
        };

        window.__pendingUpdateFixture = () => {
          state.update = {
            total: 10,
            remaining: 3,
            processed: 7,
            stage: 'interrupted',
            errors: [],
          };
          state.session = { savedAt: Date.now(), windowCount: 2, tabCount: 10, missingTabs: 1 };
        };
        window.__missingSessionFixture = () => {
          state.update = null;
          state.session = { savedAt: 1, windowCount: 2, tabCount: 12, missingTabs: 2 };
        };
        window.__projectAnalysisFixture = () => {
          const project = state.projects[0];
          const record = state.records[0];
          local.projectAnalysis = {
            id: `project-analysis:${project.id}`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            revision: 1,
            purpose: 'project',
            instruction: `project:${project.id}:${project.revision}`,
            reuseAcceptedTaxonomyOnly: false,
            scope: [
              { id: record.id, url: record.url, navigationVersion: record.navigationVersion },
            ],
            discoveredIds: [record.id],
            classifiedIds: [],
            projects: [
              { name: project.name, purpose: project.purpose, areaName: 'General', categories: [] },
            ],
            summaries: ['Project context saved'],
            assignments: [],
            unresolvedRecordIds: [],
          };
        };
        window.__tagFilterFixture = (enabled) => {
          window.sessionStorage.setItem('testTagFixture', String(enabled));
          state.records[0].tags = enabled ? ['Vue', 'accessibility'] : [];
          state.records[1].tags = enabled ? ['Vue'] : [];
        };
        if (window.sessionStorage.getItem('testTagFixture') === 'true')
          window.__tagFilterFixture(true);
        window.__largeProposalFixture = () => {
          const added = Array.from({ length: 330 }, (_, index) => ({
            ...state.records[0],
            id: `large-${index}`,
            tabId: 1000 + index,
            title: `Synthetic tab ${index}`,
            url: `https://example.test/reference/${index}`,
            projectId: null,
            locked: false,
            tags: index % 2 ? ['research'] : [],
          }));
          state.records.push(...added);
          state.collectionProposals.unshift({
            id: 'large-review-fixture',
            createdAt: Date.now() + 1000,
            status: 'pending',
            summary: 'Synthetic 330 tab review. '.repeat(60),
            projects: Array.from({ length: 16 }, (_, index) => ({
              name: `Project ${index + 1}`,
              purpose: 'Review references',
              areaName: 'Work',
              categories: [
                { name: 'Research', description: 'References' },
                { name: 'Implementation', description: 'Work' },
              ],
            })),
            assignments: added.slice(0, 247).map((record, index) => ({
              recordId: record.id,
              url: record.url,
              navigationVersion: record.navigationVersion,
              projectName: `Project ${(index % 16) + 1}`,
              categoryName: index % 2 ? 'Research' : 'Implementation',
              reason: 'Synthetic fixture',
              confidence: 0.8,
            })),
            unresolvedRecordIds: added.slice(247).map((record) => record.id),
            scopeRecordIds: added.map((record) => record.id),
          });
        };
        window.__largeWorkspaceFixture = () => {
          window.__largeProposalFixture();
          const added = state.records.filter((record) => record.id.startsWith('large-'));
          added[0].tags = Array.from({ length: 24 }, (_, index) => `merged-${index}`);
          for (let index = 0; index < 16; index++) {
            state.projects.push({
              id: `workspace-${index}`,
              name: `Workspace project ${index + 1}`,
              updatedAt: 1,
            });
            state.categories.push({
              id: `category-${index}`,
              projectId: `workspace-${index}`,
              name: 'References',
              description: '',
              order: 0,
            });
            if (index === 0)
              state.categories.push({
                id: 'category-0-implementation',
                projectId: 'workspace-0',
                name: 'Implementation',
                description: '',
                order: 1,
                color: 'purple',
              });
          }
          added.forEach((record, index) => {
            record.windowId = index % 2 ? 1 : 2;
            record.index = index + 10;
            if (index < 247) {
              record.projectId = `workspace-${index % 16}`;
              state.memberships.push({
                recordId: record.id,
                projectId: `workspace-${index % 16}`,
                categoryId:
                  index % 16 === 0 && index % 32 === 0
                    ? 'category-0-implementation'
                    : `category-${index % 16}`,
                source: 'accepted-ai',
                updatedAt: 1,
              });
            }
          });
        };
        window.__tabTreeFixture = () => {
          state.records = state.records.slice(0, 5).map((record, index) => ({
            ...record,
            title: `Branch level ${index + 1}`,
            windowId: 1,
            groupId: -1,
            projectId: 'library',
            locked: false,
            parentRecordId: index ? `record-${index - 1}` : null,
            branchName: index === 0 ? 'Research branch' : '',
          }));
          state.memberships = state.records.map((record) => ({
            recordId: record.id,
            projectId: 'library',
            categoryId: null,
            source: 'owner',
            updatedAt: 1,
          }));
        };
        window.__activateFixtureTab = (id) => {
          const target = state.records.find((record) => record.id === id);
          for (const record of state.records)
            if (record.windowId === target.windowId) record.active = record.id === id;
          return window.__activationListener?.({ tabId: target.tabId, windowId: target.windowId });
        };
        window.__branchingTreeFixture = () => {
          window.__tabTreeFixture();
          state.records[2].parentRecordId = 'record-0';
          state.records[3].parentRecordId = 'record-2';
          state.records[4].parentRecordId = 'record-0';
        };
        window.__dragDestinationFixture = () => {
          state.categories.push({
            id: 'empty-drop-category',
            projectId: 'library',
            name: 'Empty destination',
            description: '',
            color: 'blue',
            order: 0,
            revision: 1,
            updatedAt: 1,
          });
        };
        window.__dragStressFixture = () => {
          window.__branchingTreeFixture();
          for (let index = 0; index < 500; index++) {
            state.records.push({
              ...state.records[4],
              id: `stress-${index}`,
              title: `Reference ${index}`,
              parentRecordId: null,
              index: index + 5,
              tabId: index + 1000,
            });
            state.memberships.push({
              recordId: `stress-${index}`,
              projectId: 'library',
              categoryId: null,
              source: 'owner',
              updatedAt: 1,
            });
          }
        };
        window.__maintenanceState = () => JSON.parse(JSON.stringify(state));
        window.__orderingFixture = () => {
          window.sessionStorage.setItem('testOrderingFixture', 'true');
          const saved = JSON.parse(window.sessionStorage.getItem('testCategoryOrder') || '[]');
          state.categories = ['References', 'Notes', 'Tools'].map((name, order) => ({
            id: `order-${order}`,
            projectId: 'library',
            name,
            description: '',
            order: saved.find((item) => item.id === `order-${order}`)?.order ?? order,
            revision: 1,
            updatedAt: 1,
          }));
          state.memberships = state.records.map((record, index) => ({
            recordId: record.id,
            projectId: record.projectId,
            categoryId: record.projectId === 'library' ? `order-${index % 3}` : null,
            source: 'owner',
            updatedAt: 1,
          }));
        };
        if (window.sessionStorage.getItem('testOrderingFixture') === 'true')
          window.__orderingFixture();
        window.__olderChangesFixture = () => {
          state.assistantChanges = Array.from({ length: 105 }, (_, index) => ({
            id: `older-edit-${index}`,
            threadId: 'workspace',
            messageId: `owner-${index}`,
            source: 'owner',
            mode: 'once',
            createdAt: index,
            summary: `Saved edit ${index}`,
            status: 'complete',
            outcome: 'Saved metadata',
            capabilities: ['tags'],
            deltas: [
              {
                table: 'records',
                field: 'tags',
                id: 'large-0',
                url: state.records.find((record) => record.id === 'large-0').url,
                navigationVersion: 0,
                before: '[]',
                after: '["reading"]',
              },
            ],
          }));
        };
        window.__approvalRequests = [];
        window.__proposalStatuses = () =>
          state.collectionProposals.map(({ id, status }) => ({ id, status }));
        window.__detailRequests = [];
        window.__sidebarRequests = [];
        window.__sidebarCurrentFixture = () => {
          state.records.forEach((record) => {
            record.active = record.id === 'large-241';
          });
        };
        window.__actionPlanFixture = () => {
          window.sessionStorage.setItem('uiActionPlan', '1');
        };
        local.actionPlans =
          window.sessionStorage.getItem('uiActionPlan') === '1'
            ? [
                {
                  id: 'saved-action-fixture',
                  instruction: 'Review selected tabs',
                  scope: [{ id: 'record-0' }, { id: 'record-1' }],
                  completedIds: ['record-0'],
                  failedBatch: { recordIds: ['record-1'] },
                },
              ]
            : [];
        window.chrome = {
          sidePanel: { getLayout: async () => ({ side: window.__panelSide || 'right' }) },
          tabs: {
            onActivated: {
              addListener: (listener) => {
                window.__activationListener = listener;
              },
              removeListener: () => {
                window.__activationListener = undefined;
              },
            },
          },
          windows: { getCurrent: async () => ({ id: 1 }) },
          runtime: {
            onMessage: { addListener: () => {}, removeListener: () => {} },
            getURL: (path) => `${base}/${path}`,
            sendMessage: async (request) => {
              if (request.type === 'saveSession') {
                window.__sessionSaveRequests ||= [];
                window.__sessionSaveRequests.push(request);
                state.session = { ...state.session, missingTabs: 0, savedAt: Date.now() };
                return { ok: true, value: structuredClone(state.session) };
              }
              if (request.type === 'openBrowserAppearance') {
                window.__appearanceOpened = true;
                return { ok: true };
              }
              if (
                [
                  'executeAssistantAction',
                  'denyAssistantAction',
                  'dismissCollection',
                  'preparePermissionReview',
                ].includes(request.type)
              )
                window.__approvalRequests.push(JSON.parse(JSON.stringify(request)));
              const p =
                request.payload === undefined
                  ? undefined
                  : JSON.parse(JSON.stringify(request.payload));
              if (request.type === 'focus') {
                window.__sidebarRequests.push(request);
                return { ok: true };
              }
              if (request.type === 'apply') {
                window.__sidebarRequests.push(request);
                for (const action of p.actions)
                  for (const id of action.recordIds) {
                    const record = state.records.find((item) => item.id === id);
                    if (action.type === 'pin') record.pinned = action.enabled;
                    if (action.type === 'mute') record.muted = action.enabled;
                  }
                return {
                  ok: true,
                  value: {
                    results: p.actions.map((action) => ({
                      action,
                      ok: true,
                      outcomes: [{ done: true }],
                    })),
                  },
                };
              }
              if (request.type === 'listTagAnalyses')
                return { ok: true, value: structuredClone(local.tagRows || []) };
              if (request.type === 'saveTagAnalysis') {
                local.tagRows ||= [];
                local.tagRows = [...local.tagRows.filter((row) => row.id !== p.id), p];
                return { ok: true };
              }
              if (request.type === 'permissionPolicy')
                return {
                  ok: true,
                  value: local.permissionPolicies?.[p.threadId] || { mode: 'ask', revision: 0 },
                };
              if (request.type === 'setPermissionPolicy') {
                local.permissionPolicies ||= {};
                const policy = {
                  mode: p.mode,
                  revision: (local.permissionPolicies[p.threadId]?.revision || 0) + 1,
                };
                local.permissionPolicies[p.threadId] = policy;
                return { ok: true, value: policy };
              }
              if (request.type === 'preparePermissionReview') {
                local.permissionReviews ||= [];
                const review = {
                  ...p,
                  id: `review-${local.permissionReviews.length}`,
                  status: 'pending',
                  decision: 'ask',
                  reason: 'Reviewing this exact action.',
                  model: 'synthetic-reviewer',
                  createdAt: Date.now(),
                  expiresAt: Date.now() + 300000,
                  policyRevision: 1,
                  fingerprint: 'fixture',
                  artifactKey: 'fixture',
                  packet: JSON.stringify({ effects: p.artifact }),
                };
                local.permissionReviews.push(review);
                return { ok: true, value: structuredClone(review) };
              }
              if (request.type === 'resolvePermissionReview') {
                const review = local.permissionReviews.find((item) => item.id === p.id);
                review.status = 'complete';
                review.decision = window.__permissionVerdict || 'deny';
                review.reason =
                  review.decision === 'deny'
                    ? 'The user requested a draft, not application.'
                    : 'This exact change was requested by the user.';
                return { ok: true, value: structuredClone(review) };
              }
              if (request.type === 'listPermissionReviews')
                return {
                  ok: true,
                  value: (local.permissionReviews || []).filter(
                    (item) => item.messageId === p.messageId,
                  ),
                };
              if (request.type === 'permissionReviewDetails')
                return {
                  ok: true,
                  value: local.permissionReviews.find((item) => item.id === p.id),
                };
              if (request.type === 'state') {
                window.__stateReplyCount = (window.__stateReplyCount || 0) + 1;
                if (window.__stateReplyDelay)
                  await new Promise((resolve) => setTimeout(resolve, window.__stateReplyDelay));
                return {
                  ok: true,
                  value: structuredClone({
                    ...state,
                    assistantChanges: [...(state.assistantChanges || [])]
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .slice(0, 100),
                  }),
                };
              }
              if (request.type === 'listAssistantChanges')
                return {
                  ok: true,
                  value: [...(state.assistantChanges || [])]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .filter((item) => !p.messageId || item.messageId === p.messageId)
                    .slice(p.offset || 0, (p.offset || 0) + 100),
                };
              if (request.type === 'assistantChangeDetails')
                return {
                  ok: true,
                  value: state.assistantChanges?.find((item) => item.id === p.id),
                };
              if (request.type === 'revokeAssistantApprovals') {
                state.assistantApprovalRules = p.threadId
                  ? (state.assistantApprovalRules || []).filter(
                      (item) => item.threadId !== p.threadId,
                    )
                  : [];
                return { ok: true };
              }
              if (request.type === 'executeWorkspaceEdit') {
                const tables = ['records', 'memberships', 'projects', 'categories'];
                const before = new Map(
                  tables.flatMap((table) =>
                    (state[table] || []).map((row) => [
                      `${table}:${row.id || row.recordId}`,
                      { table, id: row.id || row.recordId, value: JSON.stringify(row) },
                    ]),
                  ),
                );
                for (const { edit } of p.edits) {
                  if (edit.kind === 'tab_parent') {
                    state.records.find((record) => record.id === edit.recordId).parentRecordId =
                      edit.parentRecordId;
                  } else if (edit.kind === 'membership') {
                    state.memberships = state.memberships.filter(
                      (item) => item.recordId !== edit.recordId,
                    );
                    state.memberships.push({
                      recordId: edit.recordId,
                      projectId: edit.projectId,
                      categoryId: edit.categoryId,
                      source: 'owner',
                      updatedAt: Date.now(),
                    });
                    state.records.find((record) => record.id === edit.recordId).projectId =
                      edit.projectId;
                  } else if (edit.kind === 'delete_category') {
                    state.memberships = state.memberships.map((item) =>
                      item.categoryId === edit.categoryId ? { ...item, categoryId: null } : item,
                    );
                    state.categories = state.categories.filter(
                      (item) => item.id !== edit.categoryId,
                    );
                  } else if (edit.kind === 'category_order') {
                    state.categories = state.categories.map((item) =>
                      item.projectId === edit.projectId
                        ? { ...item, order: edit.categoryIds.indexOf(item.id) }
                        : item,
                    );
                    window.sessionStorage.setItem(
                      'testCategoryOrder',
                      JSON.stringify(state.categories),
                    );
                  } else if (edit.kind === 'tags') {
                    const record = state.records.find((item) => item.id === edit.recordId);
                    record.tags =
                      edit.mode === 'replace'
                        ? edit.tags
                        : edit.mode === 'add'
                          ? [...new Set([...record.tags, ...edit.tags])]
                          : record.tags.filter((tag) => !edit.tags.includes(tag));
                  }
                }
                const after = new Map(
                  tables.flatMap((table) =>
                    (state[table] || []).map((row) => [
                      `${table}:${row.id || row.recordId}`,
                      { table, id: row.id || row.recordId, value: JSON.stringify(row) },
                    ]),
                  ),
                );
                const id = `manual-${Date.now()}`;
                const trace = {
                  id,
                  threadId: 'workspace',
                  messageId: id,
                  source: 'owner',
                  createdAt: Date.now(),
                  summary: p.summary,
                  mode: 'once',
                  capabilities: ['categories'],
                  status: 'complete',
                  outcome: p.summary,
                  deltas: [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
                    const old = before.get(key),
                      next = after.get(key);
                    return old?.value === next?.value
                      ? []
                      : [
                          {
                            table: (next || old).table,
                            id: (next || old).id,
                            field: 'entity',
                            before: old?.value || null,
                            after: next?.value || null,
                          },
                        ];
                  }),
                };
                state.assistantChanges ||= [];
                state.assistantChanges.unshift(trace);
                return { ok: true, value: trace };
              }
              if (
                request.type === 'executeAssistantAction' ||
                request.type === 'denyAssistantAction'
              ) {
                const edits = p.artifact.command?.edits || [];
                const denied = request.type === 'denyAssistantAction';
                const trace = {
                  id: `fixture-change-${p.messageId}`,
                  threadId: p.threadId,
                  messageId: p.messageId,
                  createdAt: Date.now(),
                  summary: p.artifact.command?.summary || 'Assistant action',
                  mode: p.mode,
                  ...(p.permissionReviewId
                    ? {
                        permissionReview: {
                          id: p.permissionReviewId,
                          model: 'synthetic-reviewer',
                          reason: 'This exact change was requested by the user.',
                        },
                      }
                    : {}),
                  capabilities: [
                    ...new Set(edits.map(({ edit }) => (edit.kind === 'tags' ? 'tags' : 'notes'))),
                  ],
                  status: denied ? 'denied' : 'complete',
                  outcome: denied
                    ? 'Denied by you. No action was executed.'
                    : `Applied ${edits.length} workspace edits`,
                  deltas: [],
                };
                if (!denied)
                  for (const { edit } of edits) {
                    const record = state.records.find((item) => item.id === edit.recordId);
                    const field = edit.kind === 'tags' ? 'tags' : 'note';
                    const before = JSON.stringify(record[field]);
                    record[field] =
                      field === 'tags' ? [...new Set([...record.tags, ...edit.tags])] : edit.note;
                    trace.deltas.push({
                      table: 'records',
                      field,
                      id: record.id,
                      before,
                      after: JSON.stringify(record[field]),
                    });
                  }
                if (!denied && ['chat', 'always'].includes(p.mode))
                  state.assistantApprovalRules = [
                    ...(state.assistantApprovalRules || []),
                    ...trace.capabilities.map((capability) => ({
                      capability,
                      threadId: p.mode === 'chat' ? p.threadId : null,
                    })),
                  ];
                state.assistantChanges ||= [];
                state.assistantChanges.unshift(trace);
                return { ok: true, value: trace };
              }
              if (
                request.type === 'undoAssistantChange' ||
                request.type === 'redoAssistantChange'
              ) {
                const trace = state.assistantChanges.find((item) => item.id === p.id);
                for (const delta of trace.deltas) {
                  const value = request.type === 'undoAssistantChange' ? delta.before : delta.after;
                  if (delta.field === 'entity') {
                    const rows = state[delta.table] || [];
                    state[delta.table] = rows.filter(
                      (item) => (item.id || item.recordId) !== delta.id,
                    );
                    if (value) state[delta.table].push(JSON.parse(value));
                  } else
                    state.records.find((item) => item.id === delta.id)[delta.field] =
                      JSON.parse(value);
                }
                trace.status = request.type === 'undoAssistantChange' ? 'undone' : 'complete';
                trace.outcome =
                  trace.source === 'owner'
                    ? 'Saved metadata restored'
                    : 'Undo: 2 restored; 0 later/changed values retained';
                return { ok: true, value: trace };
              }
              if (request.type === 'workItem') {
                const item = {
                  ...p,
                  id: p.id || `work-${state.workItems.length}`,
                  createdAt: p.createdAt || Date.now(),
                  updatedAt: Date.now(),
                  url: state.records.find((record) => record.id === p.recordId)?.url || null,
                };
                const index = state.workItems.findIndex((entry) => entry.id === item.id);
                if (index < 0) state.workItems.push(item);
                else state.workItems[index] = item;
                return { ok: true, value: item };
              }
              if (request.type === 'proposeCollection') {
                const proposal = {
                  ...p,
                  id: `imported-${Date.now()}`,
                  status: 'pending',
                  createdAt: Date.now(),
                };
                state.collectionProposals.push(proposal);
                return { ok: true, value: structuredClone(proposal) };
              }
              if (request.type === 'getCollectionProposal')
                return {
                  ok: true,
                  value: structuredClone(
                    state.collectionProposals.find((item) => item.id === p.id),
                  ),
                };
              if (request.type === 'listProposalRevisions') return { ok: true, value: [] };
              if (
                request.type === 'updateCollectionDraft' ||
                request.type === 'extendCollectionDraft'
              ) {
                const proposal = state.collectionProposals.find((item) => item.id === p.id);
                Object.assign(proposal, p.draft, {
                  updatedAt: Math.max(Date.now(), (proposal.updatedAt || proposal.createdAt) + 1),
                });
                return { ok: true, value: structuredClone(proposal) };
              }
              if (request.type === 'listActionAnalyses')
                return { ok: true, value: structuredClone(local.actionPlans || []) };
              if (request.type === 'repairCollectionAnalysis') {
                const source = local.collectionAnalysis;
                const branch = {
                  ...source,
                  id: window.crypto.randomUUID(),
                  sourceAnalysisId: source.id,
                  revision: 1,
                  discoveredIds: p.stage === 'discovery' ? [] : source.discoveredIds,
                  projects: p.stage === 'discovery' ? [] : source.projects,
                  classifiedIds: [],
                  assignments: [],
                  tagChecks: [],
                };
                await new Promise((resolve, reject) => {
                  const open = window.indexedDB.open('tabloom');
                  open.onerror = () => reject(open.error);
                  open.onsuccess = () => {
                    const tx = open.result.transaction('collectionAnalyses', 'readwrite');
                    tx.objectStore('collectionAnalyses').put(branch);
                    tx.oncomplete = () => {
                      open.result.close();
                      resolve();
                    };
                    tx.onerror = () => reject(tx.error);
                  };
                });
                local.collectionAnalysis = branch;
                return { ok: true, value: structuredClone(branch) };
              }
              if (request.type === 'getCollectionAnalysis')
                return {
                  ok: true,
                  value:
                    local.collectionAnalysis?.id === p.id
                      ? local.collectionAnalysis
                      : local.projectAnalysis?.id === p.id
                        ? local.projectAnalysis
                        : undefined,
                };
              if (request.type === 'clearCollectionAnalysis') {
                if (local.collectionAnalysis?.id === p.id) {
                  local.collectionAnalysis = undefined;
                  await new Promise((resolve, reject) => {
                    const open = window.indexedDB.open('tabloom');
                    open.onerror = () => reject(open.error);
                    open.onsuccess = () => {
                      const tx = open.result.transaction('collectionAnalyses', 'readwrite');
                      tx.objectStore('collectionAnalyses').delete(p.id);
                      tx.oncomplete = () => {
                        open.result.close();
                        resolve();
                      };
                      tx.onerror = () => reject(tx.error);
                    };
                  });
                }
                local.projectAnalysis = undefined;
                return { ok: true };
              }
              if (request.type === 'finishUpdate') {
                state.update = null;
                return { ok: true };
              }
              if (request.type === 'operationDetails') {
                window.__detailRequests.push(p.id);
                return {
                  ok: true,
                  value: state.operations.find((operation) => operation.id === p.id),
                };
              }
              if (request.type === 'settings') {
                window.__settingsRequests ||= [];
                window.__settingsRequests.push(p);
                if (window.__settingsDelay)
                  await new Promise((resolve) => setTimeout(resolve, window.__settingsDelay));
                if (window.__settingsFailures) {
                  window.__settingsFailures--;
                  return { ok: false, error: 'Synthetic save failure' };
                }
                state.settings = p;
                return { ok: true, value: p };
              }
              if (request.type === 'assignMembership') {
                window.__sidebarRequests.push(request);
                for (const id of p.recordIds) {
                  const record = state.records.find((item) => item.id === id);
                  record.projectId = p.projectId;
                  state.memberships = state.memberships.filter((item) => item.recordId !== id);
                  state.memberships.push({
                    recordId: id,
                    projectId: p.projectId,
                    categoryId: p.categoryId,
                    source: 'owner',
                    updatedAt: Date.now(),
                  });
                }
                return { ok: true };
              }
              if (request.type === 'record') {
                Object.assign(
                  state.records.find((r) => r.id === p.id),
                  p.patch,
                );
                return { ok: true, value: state.records.find((r) => r.id === p.id) };
              }
              if (request.type === 'project' || request.type === 'category') {
                const value = {
                  ...p,
                  id: `${request.type}-${Date.now()}`,
                  updatedAt: Date.now(),
                  revision: 1,
                  order: 0,
                  purpose: '',
                  description: '',
                };
                (request.type === 'project' ? state.projects : state.categories).push(value);
                return { ok: true, value };
              }
              if (request.type === 'snapshot') {
                const value = {
                  id: `snapshot-${Date.now()}`,
                  createdAt: Date.now(),
                  label: p.label,
                  automatic: false,
                  windows: [],
                  windowCount: 0,
                  tabCount: 0,
                };
                state.snapshots.push(value);
                return { ok: true, value };
              }
              return { ok: true, value: undefined };
            },
          },
          storage: {
            session: {
              get: async () => ({}),
              remove: async () => {},
            },
            local: {
              get: async (key) => ({ [key]: local[key] }),
              set: async (value) => Object.assign(local, value),
              remove: async (key) => {
                delete local[key];
              },
            },
          },
          permissions: {
            contains: async () => true,
            request: async () => true,
            getAll: async () => ({ permissions: [], origins: ['http://127.0.0.1/*'] }),
          },
        };
      },
      { state, base },
    );
    await page.goto(`${base}/dashboard.html#tabs`);
    await page.getByRole('heading', { name: 'Windows & tabs', exact: true }).waitFor();
    if (process.env.TABFLOW_UI_FOCUS === 'docs') {
      await fixtureContext.route('**/*', (route) =>
        route.request().url().startsWith(base) || route.request().url().startsWith('data:')
          ? route.continue()
          : route.abort(),
      );
      const theme = async (value) => {
        await page.evaluate((value) => {
          const oldValue = window.localStorage.getItem('tabflow-theme');
          window.localStorage.setItem('tabflow-theme', value);
          window.dispatchEvent(
            new window.StorageEvent('storage', {
              key: 'tabflow-theme',
              oldValue,
              newValue: value,
              storageArea: window.localStorage,
            }),
          );
        }, value);
        await page.waitForFunction(
          (value) => document.documentElement.classList.contains(value),
          value,
        );
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
            ),
        );
      };
      const capture = async (name) => {
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
        });
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `artifacts/docs-${name}.png`, animations: 'disabled' });
      };
      const assertTreeJoins = async () => {
        await page
          .waitForFunction(
            () => {
              let edges = 0;
              const fail = (reason) => {
                window.__connectorFailure = reason;
                return false;
              };
              for (const svg of document.querySelectorAll('[data-tab-parent-connectors]')) {
                if (!svg.getBoundingClientRect().width || !svg.getBoundingClientRect().height)
                  continue;
                const rows = [...svg.parentElement.querySelectorAll('[data-tab-tree-id]')];
                const boxes = new Map(
                  rows.map((row) => [
                    row.dataset.tabTreeId,
                    row.querySelector('[data-tab-tree-icon]')?.getBoundingClientRect(),
                  ]),
                );
                const paths = [...svg.querySelectorAll('path')];
                for (const row of rows.filter((row) =>
                  row.hasAttribute('data-tab-row-separator'),
                )) {
                  const rule = window.getComputedStyle(row, '::after');
                  const title = row.querySelector('[data-tab-tree-title]').getBoundingClientRect();
                  if (
                    Math.abs(
                      row.getBoundingClientRect().left + Number.parseFloat(rule.left) - title.left,
                    ) > 0.5 ||
                    rule.height !== '1px'
                  )
                    return fail('row separator must start at title column');
                }
                const expected = rows.filter((row) => boxes.has(row.dataset.tabTreeParent)).length;
                if (paths.length !== expected) return fail('visible relationship count');
                const matrix = svg.getScreenCTM();
                if (!matrix) return fail('missing SVG screen transform');
                const point = (path, distance) => {
                  const p = path.getPointAtLength(distance);
                  return new window.DOMPoint(p.x, p.y).matrixTransform(matrix);
                };
                const obstacles = [
                  ...rows.flatMap((row) => [
                    ...row.querySelectorAll('[role=checkbox], [data-tab-tree-icon]'),
                  ]),
                ].map((node) => node.getBoundingClientRect());
                for (const path of paths) {
                  const parent = boxes.get(path.dataset.parentId),
                    child = boxes.get(path.dataset.childId);
                  if (!parent || !child) return fail('missing icon anchor');
                  const family = paths.filter(
                    (sibling) => sibling.dataset.parentId === path.dataset.parentId,
                  );
                  const trunk = family.find((sibling) => {
                    const start = point(sibling, 0);
                    return (
                      Math.abs(start.x - parent.left - parent.width / 2) < 0.5 &&
                      Math.abs(start.y - parent.bottom) < 0.5
                    );
                  });
                  if (!trunk)
                    return fail(
                      JSON.stringify({
                        parentId: path.dataset.parentId,
                        parent: {
                          left: parent.left,
                          top: parent.top,
                          bottom: parent.bottom,
                          width: parent.width,
                        },
                        starts: family.map((p) => point(p, 0)),
                        svg: svg.getAttribute('viewBox'),
                      }),
                    );
                  if (path !== trunk) {
                    const start = point(path, 0);
                    let connected = false;
                    for (let d = 0; d <= trunk.getTotalLength(); d += 0.5) {
                      const p = point(trunk, d);
                      if (Math.hypot(start.x - p.x, start.y - p.y) < 0.75) {
                        connected = true;
                        break;
                      }
                    }
                    if (!connected) return fail('branch not joined to trunk');
                  }
                  const end = point(path, path.getTotalLength());
                  const endX = family.length > 1 ? child.left : child.left + child.width / 2;
                  const endY = family.length > 1 ? child.top + child.height / 2 : child.top;
                  if (Math.abs(end.x - endX) > 0.5 || Math.abs(end.y - endY) > 0.5)
                    return fail('child endpoint mismatch');
                  for (let d = 0; d < path.getTotalLength(); d += 1) {
                    const p = point(path, d);
                    if (
                      obstacles.some(
                        (box) =>
                          p.x > box.left + 0.5 &&
                          p.x < box.right - 0.5 &&
                          p.y > box.top + 0.5 &&
                          p.y < box.bottom - 0.5,
                      )
                    )
                      return fail('connector crosses a control');
                  }
                  edges++;
                }
              }
              return edges > 0;
            },
            undefined,
            { timeout: 5000 },
          )
          .catch(async (error) => {
            await writeFile(
              'artifacts/connector-failure.json',
              JSON.stringify(
                await page.evaluate(() => ({
                  reason: window.__connectorFailure,
                  paths: [...document.querySelectorAll('[data-tab-parent-connectors] path')].map(
                    (path) => ({
                      parent: path.dataset.parentId,
                      child: path.dataset.childId,
                      d: path.getAttribute('d'),
                    }),
                  ),
                })),
                null,
                2,
              ),
            );
            throw error;
          });
      };
      await page.setViewportSize({ width: 1360, height: 850 });
      await theme('dark');
      await capture('workspace');
      await assertTreeJoins();
      await page.goto(`${base}/dashboard.html#timeline`);
      await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
      await page.getByText('Atlas: before launch review', { exact: true }).waitFor();
      await capture('sessions');
      await page.goto(`${base}/sidepanel.html#tabs`);
      await page.setViewportSize({ width: 440, height: 920 });
      await page.getByRole('button', { name: 'Projects', exact: true }).waitFor();
      await theme('dark');
      const atlas = page
        .locator('[data-project-order-id="library"] .project-reorder-trigger button')
        .first();
      if ((await atlas.getAttribute('aria-expanded')) !== 'true') await atlas.click();
      for (const id of ['design', 'accessibility']) {
        const category = page
          .locator(`[data-category-order-id="${id}"] .category-reorder-trigger button`)
          .first();
        if ((await category.getAttribute('aria-expanded')) === 'true') await category.click();
      }
      await page.getByText('Build the workspace', { exact: true }).waitFor();
      await page.evaluate(() => {
        for (const viewport of document.querySelectorAll('[data-reka-scroll-area-viewport]'))
          viewport.scrollTop = 0;
      });
      await capture('sidebar');
      await assertTreeJoins();
      const assertEmptyAlignment = async () => {
        assert.equal(
          await page.locator('[data-category-empty]').evaluateAll((nodes) =>
            nodes.every((node) => {
              const label = node.closest('[data-disclosure]').querySelector('[data-reorder-label]');
              return (
                Math.abs(
                  node.getBoundingClientRect().left +
                    Number.parseFloat(window.getComputedStyle(node).paddingLeft) -
                    label.getBoundingClientRect().left,
                ) < 1
              );
            }),
          ),
          true,
          'Empty category text aligns with its category label',
        );
      };
      await assertEmptyAlignment();
      await page
        .locator('[data-workspace-record-id="record-0"]')
        .locator('[data-tab-tree-content] button')
        .last()
        .hover();
      await page.locator('[data-tab-hover-card]').waitFor();
      await assertTreeJoins();
      await page.screenshot({ path: 'artifacts/docs-tags.png', animations: 'disabled' });
      await page.mouse.move(0, 0);
      for (const value of ['light', 'dark']) {
        await theme(value);
        for (const width of [320, 440]) {
          await page.setViewportSize({ width, height: 920 });
          await assertTreeJoins();
          await assertEmptyAlignment();
          await page.screenshot({
            path: `artifacts/connectors-${value}-${width}.png`,
            animations: 'disabled',
          });
        }
      }
      const branch = page.locator('[data-workspace-record-id="record-0"]');
      await branch.getByRole('button', { name: 'Collapse tab branch', exact: true }).click();
      await page.locator('[data-workspace-record-id="record-1"]').waitFor({ state: 'hidden' });
      await branch.getByRole('button', { name: 'Expand tab branch', exact: true }).click();
      await page.locator('[data-workspace-record-id="record-1"]').waitFor();
      await assertTreeJoins();
      await page.goto(`${base}/dashboard.html#projects`);
      await page.setViewportSize({ width: 1280, height: 850 });
      await theme('dark');
      await page.getByRole('tab', { name: 'Tabs', exact: true }).waitFor();
      await capture('projects');
      await assertTreeJoins();
      const projectPicker = page.getByRole('button', { name: 'Choose project', exact: true });
      assert.equal(
        await page
          .locator('header')
          .getByRole('button', { name: 'Choose project', exact: true })
          .count(),
        1,
      );
      assert.equal(await page.getByRole('button', { name: 'New project', exact: true }).count(), 1);
      assert.equal(
        await page.locator('[data-project-order-id="library"][aria-current="page"]').count(),
        1,
      );
      await projectPicker.click();
      await page.getByRole('option', { name: 'Field notes', exact: true }).click();
      await page.locator('[data-project-order-id="garden"][aria-current="page"]').waitFor();
      assert.equal(
        await page.locator('[data-project-order-id="library"][aria-current="page"]').count(),
        0,
      );
      await page.locator('[data-project-order-id="library"]').click();
      await page.locator('[data-project-order-id="library"][aria-current="page"]').waitFor();
      assert.match(await projectPicker.innerText(), /Atlas redesign/);
      for (const value of ['light', 'dark']) {
        await theme(value);
        await page.setViewportSize({ width: 440, height: 920 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
          false,
        );
        assert.equal(await projectPicker.isVisible(), true);
        await page.screenshot({
          path: `artifacts/project-header-${value}-440.png`,
          animations: 'disabled',
        });
      }
      await page.setViewportSize({ width: 1280, height: 850 });
      await theme('dark');
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page.getByRole('heading', { name: 'Review organization', exact: true }).waitFor();
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page
        .getByRole('heading', { name: 'Review organization', exact: true })
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await capture('proposal');
      await page.evaluate(async () => {
        const now = Date.now();
        const thread = {
          id: 'docs-chat',
          title: 'Organize the Atlas launch',
          createdAt: now - 120000,
          updatedAt: now,
          projectId: null,
          status: 'ready',
          messages: [
            {
              id: 'docs-user',
              role: 'user',
              content:
                'Organize the Atlas redesign references into projects and categories. Keep the research branches and suggest useful tags. Save a draft; do not apply it.',
              createdAt: now - 60000,
              toolEvents: [],
              sources: [],
              activity: [],
              completedArtifacts: [],
            },
            {
              id: 'docs-answer',
              role: 'assistant',
              content:
                'I prepared **Atlas launch workspace** for review. Your browser windows are unchanged.\n\n### Atlas redesign\n- **Implementation**: Nuxt, Vue, TypeScript and component references.\n- **Design system**: Figma, Inter and color guidelines.\n- **Accessibility**: WAI-ARIA patterns and accessible interaction guides.\n\nThe draft includes 12 references. Suggested tags such as `reference`, `components` and `accessibility` connect related tabs across categories. Existing research branches stay intact.\n\nYou can rename or merge categories, remove tabs from the draft, or ask me to refine it before applying.',
              createdAt: now - 45000,
              completedAt: now - 30000,
              deliveryStatus: 'complete',
              requestMessageId: 'docs-user',
              collectionProposalId: 'docs-organization',
              toolEvents: [],
              sources: [],
              activity: [],
              completedArtifacts: ['collection'],
            },
          ],
        };
        await new Promise((resolve, reject) => {
          const request = window.indexedDB.open('tabloom');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const tx = request.result.transaction('assistantThreads', 'readwrite');
            tx.objectStore('assistantThreads').put(thread);
            tx.oncomplete = () => {
              request.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      });
      await page.goto(`${base}/dashboard.html#assistant`);
      await page.reload();
      await page.setViewportSize({ width: 1280, height: 1050 });
      await theme('dark');
      await page.getByText('Existing research branches stay intact.', { exact: false }).waitFor();
      await page.evaluate(() => {
        for (const viewport of document.querySelectorAll('[data-reka-scroll-area-viewport]'))
          viewport.scrollTop = 0;
      });
      await capture('assistant');
      await page.goto(`${base}/dashboard.html#tabs`);
      await page.evaluate(() => window.__tabTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.locator('[data-tabloom-id="record-4"]').waitFor();
      await assertTreeJoins();
      await theme('dark');
      await page.screenshot({
        path: 'artifacts/connectors-five-levels.png',
        animations: 'disabled',
      });
      await page.evaluate(() => window.__branchingTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await assertTreeJoins();
      await page
        .locator('[data-tabloom-id="record-0"]')
        .getByRole('button', { name: 'Collapse tab branch', exact: true })
        .hover();
      await assertTreeJoins();
      await page.screenshot({
        path: 'artifacts/connectors-siblings-hover.png',
        animations: 'disabled',
      });
      assert.deepEqual(errors, []);
      await writeFile(
        'artifacts/docs-capture-manifest.json',
        JSON.stringify(
          {
            createdAt: Date.now(),
            captures: [
              'workspace',
              'sessions',
              'sidebar',
              'tags',
              'projects',
              'proposal',
              'assistant',
            ],
          },
          null,
          2,
        ),
      );
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'attachment-picker') {
      await page.setViewportSize({ width: 360, height: 700 });
      await page.goto(`${base}/sidepanel.html#assistant`);
      await page.getByRole('button', { name: 'Add attachments', exact: true }).click();
      const search = page.getByPlaceholder('Search tabs, projects, tags…');
      await search.waitFor();
      const popup = page.locator('[role=listbox]').first();
      const searchBox = await search.boundingBox();
      const popupBox = await popup.boundingBox();
      assert(searchBox.x - popupBox.x >= 8, 'Search has an inset from the popup edge');
      assert(popupBox.height <= 330 && popupBox.width <= 336, 'Picker stays compact');
      const viewport = popup.locator('[data-slot=viewport]');
      assert.equal(
        await viewport.evaluate((el) => window.getComputedStyle(el).scrollbarWidth),
        'none',
      );
      await page.waitForFunction(() =>
        document.querySelector('[role=listbox] [data-scroll-fade="bottom"]'),
      );
      await viewport.evaluate((el) => {
        el.scrollTop = 50;
      });
      await page.waitForFunction(() =>
        document.querySelector('[role=listbox] [data-scroll-fade="top bottom"]'),
      );
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: 'artifacts/ui-attachment-picker-compact-dark.png',
        animations: 'disabled',
      });
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      });
      await page.screenshot({
        path: 'artifacts/ui-attachment-picker-compact-light.png',
        animations: 'disabled',
      });
      await search.fill('Glass Orchard catalog');
      await page
        .getByRole('option', { name: /tab.*Harbor Library - The Glass Orchard catalog/ })
        .click();
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', {
          name: /Remove attachment: Harbor Library - The Glass Orchard catalog/,
        })
        .waitFor();
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'scroll-fade') {
      await page.setViewportSize({ width: 360, height: 600 });
      await page.goto(`${base}/sidepanel.html#tabs`);
      await page.getByRole('button', { name: 'Projects', exact: true }).waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-reka-scroll-area-viewport]')].some(
          (el) => el.clientHeight > 0 && el.style.maskImage === 'none',
        ),
      );
      await page.evaluate(() => window.__dragStressFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('button', { name: 'All tabs', exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-reka-scroll-area-viewport]')].some(
          (el) => el.dataset.scrollFade === 'bottom',
        ),
      );
      const vertical = await page.locator('[data-scroll-fade="bottom"]').first().elementHandle();
      await vertical.evaluate((el) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      });
      await page.waitForFunction(() => document.querySelector('[data-scroll-fade="top bottom"]'));
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: 'artifacts/ui-scroll-fade-vertical-middle.png',
        animations: 'disabled',
      });
      await vertical.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-scroll-fade]')].some(
          (el) => el.dataset.scrollFade === 'top',
        ),
      );
      await page.goto(`${base}/dashboard.html#projects`);
      await page.getByRole('tab', { name: 'Details', exact: true }).waitFor();
      const horizontal = page.getByRole('tab', { name: 'Details', exact: true }).locator('..');
      await page.waitForFunction(() =>
        document.querySelector('[data-horizontal-tabs] [data-scroll-fade="right"]'),
      );
      await horizontal.evaluate((el) => {
        el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      });
      await page.waitForFunction(() =>
        document.querySelector('[data-horizontal-tabs] [data-scroll-fade="left right"]'),
      );
      await page.screenshot({
        path: 'artifacts/ui-scroll-fade-horizontal-middle.png',
        animations: 'disabled',
      });
      const themeClasses = await page.evaluate(() => document.documentElement.className);
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      });
      await page.screenshot({
        path: 'artifacts/ui-scroll-fade-horizontal-light.png',
        animations: 'disabled',
      });
      await page.evaluate((classes) => {
        document.documentElement.className = classes;
      }, themeClasses);
      await horizontal.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await page.waitForFunction(() =>
        document.querySelector('[data-horizontal-tabs] [data-scroll-fade="left"]'),
      );
      await horizontal.evaluate((el) => {
        el.scrollLeft = 0;
      });
      await page.waitForFunction(() =>
        document.querySelector('[data-horizontal-tabs] [data-scroll-fade="right"]'),
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-horizontal-tabs] [role=tablist]')?.style.maskImage ===
          'none',
      );
      await page.goto(`${base}/dashboard.html#tabs`);
      await page.evaluate(() => window.__dragStressFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      const tabViewport = await page
        .locator('main [data-reka-scroll-area-viewport]')
        .elementHandle();
      await tabViewport.evaluate((el) => {
        el.scrollTop = 200;
      });
      await page.waitForFunction(() => {
        const viewport = document.querySelector('main [data-reka-scroll-area-viewport]');
        const header = viewport?.querySelector('[data-scroll-fade-header]');
        if (!header || !viewport) return false;
        const inset = Math.max(
          0,
          header.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top,
        );
        return inset > 0 && viewport.style.maskImage.includes(`transparent ${inset}px`);
      });
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      });
      await page.screenshot({
        path: 'artifacts/ui-tabs-fade-below-toolbar.png',
        animations: 'disabled',
      });
      const crossings = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('[data-tab-tree-id] [role=checkbox]')].map(
          (el) => el.getBoundingClientRect(),
        );
        let hits = 0;
        for (const path of document.querySelectorAll('[data-tab-parent-connectors] path')) {
          const svg = path.ownerSVGElement.getBoundingClientRect();
          for (let distance = 0; distance <= path.getTotalLength(); distance += 2) {
            const point = path.getPointAtLength(distance);
            if (
              boxes.some(
                (box) =>
                  point.x + svg.left >= box.left - 1 &&
                  point.x + svg.left <= box.right + 1 &&
                  point.y + svg.top >= box.top - 1 &&
                  point.y + svg.top <= box.bottom + 1,
              )
            )
              hits++;
          }
        }
        return hits;
      });
      assert.equal(crossings, 0, 'Branch connectors must stay outside checkbox hit boxes');
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'ordering') {
      await page.evaluate(() => window.__orderingFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Projects', exact: true })
        .click();
      await page.getByRole('tab', { name: 'Categories', exact: true }).click();
      const dragNow = async (source, target, after = false, horizontal = false) => {
        const categoryDrag = await source.evaluate((el) =>
          Boolean(el.closest('[data-category-order-id]')),
        );
        await source.scrollIntoViewIfNeeded();
        await target.scrollIntoViewIfNeeded();
        const from = await source.boundingBox(),
          to = await target.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 3 });
        await page.locator('.sortable-chosen').first().waitFor({ state: 'visible' });
        await page.mouse.move(
          to.x + (horizontal ? (after ? to.width - 3 : 3) : to.width / 2),
          to.y + (horizontal ? to.height / 2 : after ? to.height - 3 : 3),
          {
            steps: 15,
          },
        );
        if (categoryDrag) {
          await page.locator('.tab-drag-preview').waitFor();
          assert(
            Math.abs(
              (await page.locator('.tab-drag-preview').boundingBox()).height - from.height,
            ) <= 1,
            'Lifted header keeps its original height without extra padding',
          );
          await page.screenshot({
            path: 'artifacts/ui-category-pointer-preview.png',
            animations: 'disabled',
          });
        }
        await page.mouse.up();
      };
      await dragNow(
        page.locator('[data-category-id="order-0"] span').first(),
        page.locator('[data-category-id="order-2"]'),
        true,
      );
      await page.waitForFunction(
        () =>
          window.__maintenanceState().categories.find((item) => item.id === 'order-0').order === 2,
      );
      await page.goto(`${base}/sidepanel.html#tabs`);
      await page.setViewportSize({ width: 360, height: 800 });
      await page.getByRole('button', { name: 'Projects', exact: true }).waitFor();
      const project = page
        .locator('[data-project-order-id="library"] .project-reorder-trigger button')
        .first();
      if ((await project.getAttribute('aria-expanded')) !== 'true') await project.click();
      await page.locator('[data-category-order-id="order-0"]').waitFor();
      for (const trigger of await page
        .locator('[data-category-order-id] .category-reorder-trigger button')
        .all()) {
        if ((await trigger.getAttribute('aria-expanded')) === 'true') await trigger.click();
      }
      await dragNow(
        page.locator('[data-category-order-id="order-2"] .category-reorder-trigger button').first(),
        page.locator('[data-category-order-id="order-1"] .category-reorder-trigger').first(),
      );
      await page.waitForFunction(
        () =>
          window.__maintenanceState().categories.find((item) => item.id === 'order-2').order === 0,
      );
      assert.equal(
        await project.getAttribute('aria-expanded'),
        'true',
        'Dragging a category must not collapse its project',
      );
      await page.reload();
      await page.locator('[data-category-order-id="order-2"]').waitFor();
      assert.equal(
        await page
          .locator('[data-category-order-id]')
          .first()
          .getAttribute('data-category-order-id'),
        'order-2',
      );
      const categoryTrigger = page
        .locator('[data-category-order-id="order-2"] .category-reorder-trigger button')
        .first();
      await categoryTrigger.click();
      assert.equal(await categoryTrigger.getAttribute('aria-expanded'), 'true');
      await categoryTrigger.click();
      const cancelledOrder = await page.evaluate(() =>
        window.__maintenanceState().categories.map((item) => [item.id, item.order]),
      );
      const categoryBox = await categoryTrigger.boundingBox();
      await page.mouse.move(categoryBox.x + 80, categoryBox.y + 20);
      await page.mouse.down();
      await page.mouse.move(categoryBox.x + 100, categoryBox.y + 25, { steps: 3 });
      await page.locator('.tab-drag-preview').waitFor();
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert.equal(await page.locator('.tab-drag-preview').count(), 0);
      assert.deepEqual(
        await page.evaluate(() =>
          window.__maintenanceState().categories.map((item) => [item.id, item.order]),
        ),
        cancelledOrder,
      );
      const garden = page
        .locator('[data-project-order-id="garden"] .project-reorder-trigger button')
        .first();
      const library = page
        .locator('[data-project-order-id="library"] .project-reorder-trigger')
        .first();
      await dragNow(garden, library);
      await page.waitForFunction(
        () =>
          JSON.parse(window.localStorage.getItem('tabflow.projects.order') || '[]')[0] === 'garden',
      );
      await page.reload();
      await page.locator('div[data-project-order-id="garden"]').waitFor();
      assert.equal(
        await page
          .locator('div[data-project-order-id]')
          .first()
          .getAttribute('data-project-order-id'),
        'garden',
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Tab list actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Project layout', exact: true }).hover();
      await page
        .getByRole('menuitemcheckbox', { name: 'Horizontal project tabs', exact: true })
        .click();
      await page.keyboard.press('Escape');
      await dragNow(
        page.getByRole('tab', { name: /^Canyon Garden/ }),
        page.getByRole('tab', { name: /^Personal research/ }),
        true,
        true,
      );
      await page.waitForFunction(
        () => JSON.parse(window.localStorage.getItem('tabflow.projects.order')).at(-1) === 'garden',
      );
      await page.reload();
      await page.getByRole('tab', { name: /^Harbor Library/ }).waitFor();
      assert.match(await page.getByRole('tab').last().innerText(), /^Canyon Garden/);
      await page.goto(`${base}/dashboard.html#tabs`);
      await page.getByRole('heading', { name: 'Windows & tabs', exact: true }).waitFor();
      await dragNow(
        page.locator('button[data-project-order-id="garden"]'),
        page.locator('button[data-project-order-id="library"]'),
      );
      await page.waitForFunction(
        () => JSON.parse(window.localStorage.getItem('tabflow.projects.order'))[0] === 'garden',
      );
      await page.reload();
      await page.locator('button[data-project-order-id="garden"]').waitFor();
      assert.equal(
        await page
          .locator('button[data-project-order-id]')
          .first()
          .getAttribute('data-project-order-id'),
        'garden',
      );
      await page.goto(`${base}/sidepanel.html#tabs`);
      await page.evaluate(() => window.__missingSessionFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('button', { name: 'Keep current changes', exact: true }).waitFor();
      for (const width of [320, 420]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(50);
        const create = await page
          .getByRole('button', { name: 'Create project', exact: true })
          .boundingBox();
        const save = await page
          .getByRole('button', { name: 'Save current session', exact: true })
          .boundingBox();
        assert(
          create.x <= 20 && save.x + save.width >= width - 20,
          'Footer actions distribute from left to right',
        );
        assert(Math.abs(create.y - save.y) < 2);
        assert(
          (await page.locator('[data-tabflow-sticky-footer]').last().boundingBox()).height <= 60,
        );
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: `artifacts/ui-ordering-footer-${width}.png`,
          animations: 'disabled',
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page
        .locator('[data-tabflow-sticky-footer]')
        .getByText(/10 tabs · 2 windows · 3 projects/)
        .waitFor();
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'compact-ui') {
      await page.getByRole('button', { name: 'Sort tabs', exact: true }).click();
      const option = page.getByRole('option', { name: 'Browser order', exact: true });
      await option.waitFor();
      await page.waitForFunction(
        () => document.querySelector('[role="option"]')?.getBoundingClientRect().width >= 180,
      );
      const optionBox = await option.boundingBox();
      await page.screenshot({
        path: 'artifacts/ui-compact-sort-desktop.png',
        animations: 'disabled',
      });
      assert(optionBox.width >= 180, 'Icon trigger must not constrain sort popup width');
      assert.equal(await option.locator('[data-slot="itemLabel"]').innerText(), 'Browser order');
      await page.screenshot({
        path: 'artifacts/ui-compact-sort-desktop.png',
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Projects', exact: true })
        .click();
      await page.getByRole('button', { name: 'Choose project', exact: true }).click();
      const selectedProject = page.getByRole('option', { name: 'Harbor Library', exact: true });
      await selectedProject.waitFor();
      const centers = await selectedProject.evaluate((node) =>
        ['[data-select-color]', '[data-slot="itemLabel"]', '[data-slot="itemTrailingIcon"]'].map(
          (selector) => {
            const box = node.querySelector(selector).getBoundingClientRect();
            return box.y + box.height / 2;
          },
        ),
      );
      assert(
        Math.max(...centers) - Math.min(...centers) <= 2,
        'Color, label and check share the same center line',
      );
      await page.screenshot({
        path: 'artifacts/ui-project-select-alignment.png',
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name: 'Backups & privacy', exact: true })
        .click();
      const retention = page.getByLabel('Snapshots to keep', { exact: true });
      const backupToggle = page.getByRole('switch', {
        name: 'Scheduled JSON backup downloads',
        exact: true,
      });
      const toggleBox = await backupToggle.boundingBox();
      const toggleLabelBox = await page
        .getByText('Scheduled JSON backup downloads', { exact: true })
        .boundingBox();
      assert(
        toggleBox.x > toggleLabelBox.x + toggleLabelBox.width,
        'Settings switches align to the trailing edge',
      );
      await page.evaluate(() => {
        window.__settingsDelay = 650;
      });
      await retention.fill('160');
      await page.waitForFunction(() => window.__settingsRequests?.length === 1);
      await retention.fill('150');
      await page.waitForFunction(
        () =>
          window.__maintenanceState().settings.snapshotRetention === 150 &&
          window.__settingsRequests.length >= 2,
      );
      await page.evaluate(() => {
        window.__settingsDelay = 0;
        window.__settingsFailures = 1;
      });
      await retention.fill('180');
      await page.getByRole('alert').filter({ hasText: 'Synthetic save failure' }).waitFor();
      await page.getByRole('button', { name: 'Retry save', exact: true }).click();
      await page.waitForFunction(
        () => window.__maintenanceState().settings.snapshotRetention === 180,
      );
      await page.evaluate(() => {
        window.__settingsFailures = 10;
      });
      await retention.fill('190');
      await page.getByRole('alert').filter({ hasText: 'Synthetic save failure' }).waitFor();
      await page.evaluate(() => {
        window.location.hash = 'review';
      });
      await page.getByRole('heading', { name: 'Suspender migration', exact: true }).waitFor();
      await page.evaluate(() => {
        window.location.hash = 'settings';
      });
      await settingsSection(page, 'Backups & privacy');
      assert.equal(
        await retention.inputValue(),
        '190',
        'Unsaved settings survive leaving and reopening the view',
      );
      await page.getByRole('alert').filter({ hasText: 'Synthetic save failure' }).waitFor();
      await page.evaluate(() => {
        window.__settingsFailures = 0;
      });
      await page.getByRole('button', { name: 'Retry save', exact: true }).click();
      await page.waitForFunction(
        () => window.__maintenanceState().settings.snapshotRetention === 190,
      );
      await page.screenshot({
        path: 'artifacts/ui-settings-list-detail-desktop.png',
        animations: 'disabled',
      });
      assert.equal(
        await page.getByRole('button', { name: 'Save preferences', exact: true }).count(),
        0,
      );
      await page.setViewportSize({ width: 320, height: 900 });
      await page.getByRole('button', { name: 'Back to settings', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Search settings', exact: true }).fill('Side');
      await page
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name: 'Side panel', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Browser side panel' }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-settings-detail-320.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Back to settings', exact: true }).click();
      await page.screenshot({ path: 'artifacts/ui-settings-list-320.png', animations: 'disabled' });
      await page.evaluate(() => {
        window.location.hash = 'update';
      });
      await page.getByRole('button', { name: 'Save & reload', exact: true }).click();
      const confirm = page.getByRole('dialog', {
        name: 'Reload TabFlow with the new build?',
        exact: true,
      });
      await confirm.waitFor();
      assert.equal(
        await confirm.locator('[data-slot="body"]').count(),
        0,
        'No empty body between description and confirmation actions',
      );
      assert((await confirm.boundingBox()).height < 280);
      await page.screenshot({
        path: 'artifacts/ui-confirmation-compact-320.png',
        animations: 'disabled',
      });
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.evaluate(() => {
        window.location.hash = 'review';
      });
      await page.getByRole('heading', { name: 'Suspender migration', exact: true }).waitFor();
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle('light', theme === 'light');
          document.documentElement.classList.toggle('dark', theme === 'dark');
        }, theme);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({
          path: `artifacts/ui-review-compact-${theme}.png`,
          animations: 'disabled',
        });
      }
      await page.evaluate(() => {
        window.location.hash = 'assistant';
      });
      await page
        .getByRole('textbox', { name: 'Message to workspace assistant', exact: true })
        .waitFor();
      const add = page.getByRole('button', { name: 'Add attachments', exact: true });
      const tools = page.getByRole('button', { name: 'Tools and scope', exact: true });
      assert(Math.abs((await add.boundingBox()).y - (await tools.boundingBox()).y) <= 4);
      await add.click();
      await page.getByRole('button', { name: 'Attach images', exact: true }).waitFor();
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Attach images', exact: true }).click();
      await (
        await chooser
      ).setFiles({
        name: 'fixture.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYd8AAAAASUVORK5CYII=',
          'base64',
        ),
      });
      await page.getByAltText('fixture.png', { exact: true }).waitFor();
      await add.click();
      await page
        .getByRole('option')
        .filter({ hasText: 'project · Harbor Library' })
        .first()
        .click();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: 'artifacts/ui-composer-plus-320.png', animations: 'disabled' });
      assert.equal(await page.getByText('Local chat', { exact: false }).count(), 0);
      await page.goto(`${base}/sidepanel.html#tabs`);
      await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Save session now', exact: true }).waitFor();
      const footer = page.locator('[data-tabflow-sticky-footer]').last();
      assert((await footer.boundingBox()).height <= 60, 'Footer stays a single compact row');
      await page.evaluate(() => window.__missingSessionFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('button', { name: 'Keep current changes', exact: true }).waitFor();
      assert(
        (await footer.boundingBox()).height <= 60,
        'Missing-tab actions do not add a footer row',
      );
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: 'artifacts/ui-footer-compact-320.png',
        animations: 'disabled',
      });
      await page.evaluate(() => window.__branchingTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      const compactProject = page.getByRole('button', { name: /^Harbor Library\b/ });
      if ((await compactProject.getAttribute('aria-expanded')) !== 'true')
        await compactProject.click();
      const branchAnimated = await page.evaluate(async () => {
        document
          .querySelector(
            '[data-workspace-record-id="record-0"] button[aria-label="Collapse tab branch"]',
          )
          .click();
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        return document
          .getAnimations()
          .some(
            (animation) =>
              animation.effect?.target?.dataset?.tabTreeId &&
              animation.effect.getKeyframes().some((frame) => frame.height === '0px'),
          );
      });
      assert.equal(
        branchAnimated,
        true,
        'Branch collapse animates row height instead of disappearing instantly',
      );
      await page.locator('[data-workspace-record-id="record-4"]').waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () =>
          !document
            .getAnimations()
            .some(
              (animation) =>
                animation.effect?.target?.dataset?.tabTreeId &&
                animation.effect.getKeyframes().some((frame) => frame.height === '0px'),
            ),
      );
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByRole('button', { name: 'Expand tab branch', exact: true }).first().click();
      await page.locator('[data-workspace-record-id="record-4"]').waitFor();
      assert.equal(
        await page.evaluate(() =>
          document
            .getAnimations()
            .some(
              (animation) =>
                animation.effect?.target?.dataset?.tabTreeId &&
                animation.effect.getKeyframes().some((frame) => frame.height === '0px'),
            ),
        ),
        false,
        'Reduced motion skips row transitions',
      );
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.getByRole('button', { name: 'Tab list actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Project layout', exact: true }).hover();
      await page
        .getByRole('menuitemcheckbox', { name: 'Horizontal project tabs', exact: true })
        .click();
      await page.keyboard.press('Escape');
      const projectViewport = page.locator(
        '[data-reka-scroll-area-viewport][aria-label="Project tabs"]',
      );
      await projectViewport.waitFor();
      assert.equal(
        await projectViewport.evaluate(
          (element) => window.getComputedStyle(element).scrollbarWidth,
        ),
        'none',
      );
      await projectViewport.hover();
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-reka-scroll-area-viewport][aria-label="Project tabs"]')
            .scrollLeft > 0,
      );
      await page.evaluate(() => {
        const content = document.querySelector('[data-workspace-scope-content]');
        const animate = content.animate.bind(content);
        window.__scopeAnimations = 0;
        content.animate = (...args) => {
          window.__scopeAnimations++;
          return animate(...args);
        };
      });
      await page.getByRole('tab', { name: /^Canyon Garden/ }).click();
      await page.waitForFunction(() => window.__scopeAnimations > 0);
      await page.screenshot({
        path: 'artifacts/ui-horizontal-tabs-hidden-scrollbar.png',
        animations: 'disabled',
      });
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'layout') {
      // Old layout values must no longer swap internal panes or move browser navigation.
      await page.evaluate(() => {
        window.localStorage.setItem('tabflow.layout.navigationSide', 'right');
        window.localStorage.setItem('tabflow.layout.assistantSide', 'left');
      });
      await page.reload();
      await page.getByRole('heading', { name: 'Windows & tabs', exact: true }).waitFor();
      await page
        .locator('#workspace')
        .getByRole('button', { name: 'Assistant', exact: true })
        .click();
      const composer = page.getByRole('textbox', {
        name: 'Message to workspace assistant',
        exact: true,
      });
      await composer.fill('Keep this unfinished message while opening settings.');
      const assistantBox = await page
        .getByLabel('Workspace assistant', { exact: true })
        .boundingBox();
      assert(assistantBox && assistantBox.x > 900, 'Contextual assistant remains on the right');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await settingsSection(page, 'Models');
      await page.getByRole('heading', { name: 'Generative orchestrator' }).waitFor();
      await composer.waitFor({ state: 'hidden' });
      await settingsSection(page, 'Side panel');
      await page.getByRole('heading', { name: 'Browser side panel' }).waitFor();
      await page.getByText('Current position: Right', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Change in browser settings', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__appearanceOpened), true);
      await page.evaluate(() => {
        window.__panelSide = 'left';
        window.dispatchEvent(new window.Event('focus'));
      });
      await page.getByText('Current position: Left', { exact: true }).waitFor();
      await page
        .locator('#workspace')
        .getByRole('button', { name: 'Assistant', exact: true })
        .click();
      await composer.waitFor();
      assert.equal(
        await composer.inputValue(),
        'Keep this unfinished message while opening settings.',
      );
      // Changing routes while a narrow modal is open must dismiss it without unmounting chat.
      await page.setViewportSize({ width: 420, height: 900 });
      await page.evaluate(() => {
        window.location.hash = 'tabs';
      });
      await composer.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: 'Windows & tabs', exact: true }).waitFor();
      await page
        .locator('#workspace')
        .getByRole('button', { name: 'Assistant', exact: true })
        .click();
      await composer.waitFor();
      assert.equal(
        await composer.inputValue(),
        'Keep this unfinished message while opening settings.',
      );
      await page.evaluate(() => {
        window.location.hash = 'settings';
      });
      await composer.waitFor({ state: 'hidden' });
      await settingsSection(page, 'Models');
      await page.getByRole('heading', { name: 'Generative orchestrator' }).waitFor();
      for (const width of [420, 320, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        if (width < 768) {
          await settingsSection(page, 'Side panel');
        } else {
          await settingsSection(page, 'Side panel');
        }
        await page.getByRole('heading', { name: 'Browser side panel' }).waitFor();
        for (const theme of ['dark', 'light']) {
          await page.evaluate((theme) => {
            document.documentElement.classList.toggle('light', theme === 'light');
            document.documentElement.classList.toggle('dark', theme === 'dark');
          }, theme);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          const button = await page
            .getByRole('button', { name: 'Change in browser settings', exact: true })
            .boundingBox();
          assert(button && button.x >= 0 && button.x + button.width <= width);
          await page.screenshot({
            path: `artifacts/ui-browser-panel-${theme}-${width}.png`,
            animations: 'disabled',
          });
        }
      }
      await page.evaluate(() => {
        window.chrome.sidePanel = undefined;
        window.dispatchEvent(new window.Event('focus'));
      });
      await page.getByText('Position managed by your browser', { exact: true }).waitFor();
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(`${base}/sidepanel.html#tabs`);
      await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Open contextual assistant', exact: true }).click();
      await composer.fill('Side panel draft survives navigation.');
      await page.evaluate(() => {
        window.location.hash = 'settings';
      });
      await composer.waitFor({ state: 'hidden' });
      await settingsSection(page, 'Models');
      await page.getByRole('heading', { name: 'Generative orchestrator' }).waitFor();
      await settingsSection(page, 'Side panel');
      await page.getByRole('heading', { name: 'Browser side panel' }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: 'artifacts/ui-browser-panel-native-surface-320.png',
        animations: 'disabled',
      });
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'drag') {
      await page.setViewportSize({ width: 420, height: 900 });
      await page.goto(`${base}/sidepanel.html#tabs`);
      await page.getByRole('button', { name: 'Projects', exact: true }).waitFor();
      await page.evaluate(() => window.__branchingTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      const project = page.getByRole('button', { name: /^Harbor Library\b/ });
      if ((await project.getAttribute('aria-expanded')) !== 'true') await project.click();
      const row = (id) => page.locator(`[data-workspace-record-id="record-${id}"]`);
      await row(4).waitFor();
      await row(4).locator('button').first().hover();
      await page.locator('[data-tab-hover-card]').waitFor();
      await page.mouse.move(410, 870);
      await page.locator('[data-tab-hover-card]').waitFor({ state: 'hidden' });
      const drag = async (source, target, position, capture) => {
        const from = await row(source).boundingBox(),
          to = await row(target).boundingBox();
        const icon = await row(target).locator('[data-tab-tree-icon]').boundingBox();
        const x = position === 'root' ? icon.x - 12 : to.x + to.width * 0.55;
        const y =
          to.y + to.height * (position === 'before' ? 0.12 : position === 'after' ? 0.88 : 0.5);
        await page.mouse.move(from.x + from.width * 0.55, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width * 0.55 + 8, from.y + from.height / 2, {
          steps: 3,
        });
        await page.mouse.move(x, y, { steps: 15 });
        await page.screenshot({ path: 'artifacts/ui-drag-debug.png', animations: 'disabled' });
        await page.locator(`[data-tree-drop="${position}"]`).waitFor();
        await page.locator('[data-drag-feedback]').waitFor();
        const feedback = await page.locator('[data-drag-feedback]').boundingBox();
        const lifted = await page.locator('.tab-drag-preview').boundingBox();
        assert(
          feedback.y >= lifted.y + lifted.height || feedback.y + feedback.height <= lifted.y,
          'Drop clue stays outside lifted row text',
        );
        assert.match(
          await page.locator('[data-drag-feedback]').innerText(),
          new RegExp(
            position === 'inside'
              ? 'Nest inside'
              : position === 'root'
                ? 'Move to root'
                : position === 'before'
                  ? 'Move above'
                  : 'Move below',
          ),
        );
        await page.screenshot({
          path: capture || `artifacts/ui-drag-${position}-feedback.png`,
          animations: 'disabled',
        });
        await page.mouse.up();
      };
      await drag(4, 2, 'inside', 'artifacts/ui-drag-nest.png');
      await page.waitForFunction(
        () =>
          window.__maintenanceState().records.find((item) => item.id === 'record-4')
            .parentRecordId === 'record-2',
      );
      await drag(2, 1, 'before');
      assert.deepEqual(
        await page
          .locator('[data-section-id="library:none"] [data-workspace-record-id]')
          .evaluateAll((elements) => elements.map((element) => element.dataset.workspaceRecordId)),
        ['record-0', 'record-2', 'record-3', 'record-4', 'record-1'],
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__maintenanceState().records.find((item) => item.id === 'record-3')
              .parentRecordId,
        ),
        'record-2',
      );
      await drag(4, 1, 'root', 'artifacts/ui-drag-root.png');
      await page.waitForFunction(
        () =>
          window.__maintenanceState().records.find((item) => item.id === 'record-4')
            .parentRecordId === null,
      );
      await page.evaluate(() => window.__dragDestinationFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      const empty = page.locator('[data-section-id="empty-drop-category"]');
      await empty.waitFor();
      const fromBranch = await row(2).boundingBox(),
        emptyBox = await empty.boundingBox();
      await page.mouse.move(
        fromBranch.x + fromBranch.width * 0.55,
        fromBranch.y + fromBranch.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(emptyBox.x + emptyBox.width * 0.55, emptyBox.y + emptyBox.height / 2, {
        steps: 20,
      });
      await page
        .locator('[data-section-id="empty-drop-category"][data-tree-drop="inside"]')
        .waitFor();
      await page.screenshot({
        path: 'artifacts/ui-drag-empty-category.png',
        animations: 'disabled',
      });
      await page.mouse.up();
      await page.waitForFunction(() =>
        ['record-2', 'record-3'].every(
          (id) =>
            window.__maintenanceState().memberships.find((item) => item.recordId === id)
              .categoryId === 'empty-drop-category',
        ),
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__maintenanceState().records.find((item) => item.id === 'record-3')
              .parentRecordId,
        ),
        'record-2',
      );
      const lastChange = await page.evaluate(
        () => window.__maintenanceState().assistantChanges[0].id,
      );
      await page.evaluate(
        (id) => window.chrome.runtime.sendMessage({ type: 'undoAssistantChange', payload: { id } }),
        lastChange,
      );
      await activateWorkspaceAction(page, 'Refresh workspace');
      assert.equal(
        await page.evaluate(
          () =>
            window.__maintenanceState().memberships.find((item) => item.recordId === 'record-3')
              .categoryId,
        ),
        null,
      );
      assert.equal(
        await page.evaluate(
          () =>
            (window.__sidebarRequests || []).filter((request) => request.type === 'focus').length,
        ),
        0,
        'Dragging titles must never activate or wake tabs',
      );
      await page.waitForTimeout(450);
      await row(4).locator('button').first().click();
      assert.equal(
        await page.evaluate(
          () => window.__sidebarRequests.filter((request) => request.type === 'focus').length,
        ),
        1,
        'Normal title clicks still focus the tab',
      );
      await page.getByRole('button', { name: 'All tabs', exact: true }).click();
      await page.getByRole('button', { name: 'Tab list actions', exact: true }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Nested tabs', exact: true }).click();
      const flatSource = await row(4).boundingBox(),
        flatTarget = await row(0).boundingBox();
      await page.mouse.move(
        flatSource.x + flatSource.width * 0.55,
        flatSource.y + flatSource.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(flatTarget.x + flatTarget.width * 0.55, flatTarget.y + 2, {
        steps: 20,
      });
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          JSON.parse(window.localStorage.getItem('tabflow.workspace.semanticOrder'))[
            'workspace:all'
          ]?.[0] === 'record-4',
      );
      assert.equal(
        await page
          .locator('[data-workspace-record-id]')
          .first()
          .getAttribute('data-workspace-record-id'),
        'record-4',
      );
      await page.getByRole('button', { name: 'Tab list actions', exact: true }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Nested tabs', exact: true }).click();
      await page.evaluate(() => window.__dragStressFixture());
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Workspace menu', exact: true }).waitFor();
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await row(0).scrollIntoViewIfNeeded();
      const stressSource = await row(0).boundingBox();
      const stickyFooter = await page.locator('[data-tabflow-sticky-footer]').last().boundingBox();
      await page.evaluate(() => {
        window.__routeLongTasks = [];
      });
      await page.mouse.move(
        stressSource.x + stressSource.width / 2,
        stressSource.y + stressSource.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        stressSource.x + stressSource.width / 2 + 8,
        stressSource.y + stressSource.height / 2,
        { steps: 3 },
      );
      await page.mouse.move(200, stickyFooter.y + 12, { steps: 15 });
      await page.waitForFunction(
        () => {
          const source = document.querySelector('[data-workspace-record-id="record-0"]');
          return source?.closest('[data-reka-scroll-area-viewport]')?.scrollTop > 40;
        },
        undefined,
        { timeout: 4000 },
      );
      await page.mouse.up();
      const largestDragTask = await page.evaluate(() => Math.max(0, ...window.__routeLongTasks));
      assert(largestDragTask < 250, `Drag produced a ${largestDragTask}ms main-thread task`);
      console.log(
        `500-tab drag largest main-thread task: ${largestDragTask}ms; footer-edge autoscroll passed.`,
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/dashboard.html#tabs`);
      await page.evaluate(() => window.__branchingTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      });
      const desktopSource = page.locator('[data-tabloom-id="record-4"]');
      const desktopTarget = page.locator('[data-tabloom-id="record-2"]');
      await desktopSource.scrollIntoViewIfNeeded();
      const desktopFrom = await desktopSource.boundingBox(),
        desktopTo = await desktopTarget.boundingBox();
      await page.mouse.move(
        desktopFrom.x + desktopFrom.width * 0.55,
        desktopFrom.y + desktopFrom.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        desktopFrom.x + desktopFrom.width * 0.55 + 8,
        desktopFrom.y + desktopFrom.height / 2,
        { steps: 3 },
      );
      await page.mouse.move(
        desktopTo.x + desktopTo.width * 0.55,
        desktopTo.y + desktopTo.height * 0.88,
        { steps: 15 },
      );
      await page.locator('[data-drag-feedback]').filter({ hasText: 'Move below' }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-drag-desktop-light-feedback.png',
        animations: 'disabled',
      });
      await page.mouse.up();
      await page.locator('[data-drag-feedback]').waitFor({ state: 'hidden' });
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'trees') {
      const assertConnectors = async () => {
        await page.waitForFunction(() => {
          const paths = [...document.querySelectorAll('[data-tab-parent-connectors] path')];
          if (paths.length !== 4) return false;
          return paths.every((path) => {
            const nodes = [...document.querySelectorAll('[data-tab-tree-id]')];
            const parent = nodes
              .find((node) => node.dataset.tabTreeId === path.dataset.parentId)
              ?.querySelector('[data-tab-tree-icon]');
            const child = nodes
              .find((node) => node.dataset.tabTreeId === path.dataset.childId)
              ?.querySelector('[data-tab-tree-icon]');
            const matrix = path.ownerSVGElement.getScreenCTM();
            if (!parent || !child || !matrix) return false;
            const parentBox = parent.getBoundingClientRect(),
              childBox = child.getBoundingClientRect();
            const start = path.getPointAtLength(0),
              end = path.getPointAtLength(path.getTotalLength());
            const first = new window.DOMPoint(start.x, start.y).matrixTransform(matrix),
              last = new window.DOMPoint(end.x, end.y).matrixTransform(matrix);
            return (
              Math.abs(first.x - parentBox.left - parentBox.width / 2) < 1 &&
              Math.abs(first.y - parentBox.bottom) < 1 &&
              Math.abs(last.x - childBox.left - childBox.width / 2) < 1 &&
              Math.abs(last.y - childBox.top) < 1 &&
              path.getAttribute('d').includes(' Q ')
            );
          });
        });
      };
      await page.evaluate(() => window.__tabTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      const root = page.locator('[data-tabloom-id="record-0"]');
      const leaf = page.locator('[data-tabloom-id="record-4"]');
      await leaf.waitFor();
      await assertConnectors();
      assert.equal(
        await leaf
          .locator('[data-tab-tree-content]')
          .evaluate((node) => node.style.paddingInlineStart),
        '16px',
      );
      await page.locator('[data-tabloom-id="record-1"]').getByRole('checkbox').check();
      assert.equal(
        await page
          .getByRole('checkbox', { name: 'Select Ungrouped tabs', exact: true })
          .getAttribute('aria-checked'),
        'mixed',
      );
      await page.getByRole('checkbox', { name: 'Select Ungrouped tabs', exact: true }).check();
      assert.equal(await leaf.getByRole('checkbox').isChecked(), true);
      await page.getByRole('checkbox', { name: 'Select Ungrouped tabs', exact: true }).uncheck();
      assert.equal(await leaf.getByRole('checkbox').isChecked(), false);
      await root.getByRole('button', { name: 'Collapse tab branch', exact: true }).click();
      await leaf.waitFor({ state: 'hidden' });
      await activateWorkspaceAction(page, 'Refresh workspace');
      await leaf.waitFor({ state: 'hidden' });
      await root.getByRole('button', { name: 'Expand tab branch', exact: true }).click();
      await leaf.waitFor();
      await root.getByRole('button').filter({ hasText: 'Research branch' }).hover();
      await page.locator('[data-tab-hover-card]').waitFor();
      await root.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Duplicate tab', exact: true }).waitFor();
      await page.locator('[data-tab-hover-card]').waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await root.getByRole('button').filter({ hasText: 'Research branch' }).hover();
      await page.locator('[data-tab-hover-card]').waitFor();
      await root.getByRole('button', { name: 'Actions for Branch level 1', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Duplicate tab', exact: true }).waitFor();
      await page.locator('[data-tab-hover-card]').waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      for (const theme of ['dark', 'light']) {
        const toggle = page.getByRole('button', {
          name: theme === 'dark' ? 'Switch to dark mode' : 'Switch to light mode',
          exact: true,
        });
        if (await toggle.count()) await toggle.click();
        for (const width of [1440, 420]) {
          await page.setViewportSize({ width, height: 900 });
          await assertConnectors();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          await page.screenshot({
            path: `artifacts/ui-tab-tree-${theme}-${width}.png`,
            animations: 'disabled',
          });
        }
      }
      await page.getByRole('searchbox').first().fill('Branch level 5');
      await leaf.waitFor();
      await root.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-tab-parent-connectors] path').length === 0,
      );
      assert.equal(await leaf.evaluate((node) => node.style.paddingInlineStart), '8px');
      await page.goto(`${base}/sidepanel.html`);
      await page.getByRole('button', { name: 'Projects', exact: true }).waitFor();
      await page.evaluate(() => window.__tabTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      const project = page.getByRole('button', { name: /^Harbor Library\b/ });
      if ((await project.getAttribute('aria-expanded')) !== 'true') await project.click();
      await page.locator('[data-workspace-record-id="record-4"]').waitFor();
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle('light', theme === 'light');
          document.documentElement.classList.toggle('dark', theme === 'dark');
        }, theme);
        for (const width of [320, 420]) {
          await page.setViewportSize({ width, height: 900 });
          await assertConnectors();
          const search = await page
            .getByRole('searchbox', { name: 'Search tabs', exact: true })
            .boundingBox();
          assert.ok(search.width > width * 0.55);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          await page.getByRole('button', { name: 'Save session now', exact: true }).waitFor();
          const leafTitle = page.locator('[data-workspace-record-id="record-4"] .text-ink').first();
          assert.ok((await leafTitle.boundingBox()).width > width * 0.45);
          await page.mouse.move(0, 0);
          await page.evaluate(() => document.activeElement?.blur());
          await page.screenshot({
            path: `artifacts/ui-sidebar-nesting-${theme}-${width}.png`,
            animations: 'disabled',
          });
          await page.locator('[data-workspace-project="library"]').screenshot({
            path: `artifacts/ui-nested-svg-${theme}-${width}.png`,
            animations: 'disabled',
          });
        }
      }
      const sidebarRoot = page.locator('[data-workspace-record-id="record-0"]');
      const sidebarLeaf = page.locator('[data-workspace-record-id="record-4"]');
      await sidebarRoot.getByRole('button', { name: 'Collapse tab branch', exact: true }).click();
      await sidebarLeaf.waitFor({ state: 'hidden' });
      await page.evaluate(() => window.__activateFixtureTab('record-4'));
      await sidebarLeaf.locator('button[aria-current=page]').waitFor();
      const beforeActivation = await page.evaluate(() => window.__stateReplyCount);
      await page
        .getByRole('searchbox', { name: 'Search tabs', exact: true })
        .fill('no matching branch');
      await page.evaluate(() => window.__activateFixtureTab('record-0'));
      await page.waitForFunction((before) => window.__stateReplyCount > before, beforeActivation);
      assert.equal(
        await page.getByRole('searchbox', { name: 'Search tabs', exact: true }).inputValue(),
        'no matching branch',
      );
      await page.getByRole('searchbox', { name: 'Search tabs', exact: true }).fill('');
      await sidebarRoot.waitFor();
      await sidebarRoot.getByRole('button', { name: 'Collapse tab branch', exact: true }).click();
      await page.getByRole('button', { name: /^No category/ }).click();
      await project.click();
      await page.reload();
      await page.getByRole('button', { name: 'Projects', exact: true }).waitFor();
      await page.evaluate(() => window.__tabTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      assert.equal(await project.getAttribute('aria-expanded'), 'false');
      await project.click();
      const category = page.getByRole('button', { name: /^No category/ });
      assert.equal(await category.getAttribute('aria-expanded'), 'false');
      await category.click();
      await sidebarRoot.getByRole('button', { name: 'Expand tab branch', exact: true }).waitFor();
      await sidebarLeaf.waitFor({ state: 'hidden' });
      await sidebarRoot.getByRole('button', { name: 'Expand tab branch', exact: true }).click();
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.getByRole('button', { name: 'Tab list actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Project layout', exact: true }).hover();
      await page
        .getByRole('menuitemcheckbox', { name: 'Horizontal project tabs', exact: true })
        .click();
      const firstTab = page.getByRole('tab', { name: /^Harbor Library/ });
      const nextTab = page.getByRole('tab', { name: /^Canyon Garden/ });
      const from = await firstTab.boundingBox(),
        to = await nextTab.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 12 });
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          JSON.parse(window.localStorage.getItem('tabflow.projects.order') || '[]')[0] === 'garden',
      );
      await page.setViewportSize({ width: 320, height: 900 });
      const footerSave = await page
        .getByRole('button', { name: 'Save session now', exact: true })
        .boundingBox();
      assert.ok(
        footerSave.y >= 0 && footerSave.y + footerSave.height <= 900,
        JSON.stringify(footerSave),
      );
      assert.ok(
        footerSave.x >= 0 && footerSave.x + footerSave.width <= 320,
        JSON.stringify(footerSave),
      );
      await page.screenshot({
        path: 'artifacts/ui-sidebar-horizontal-projects.png',
        animations: 'disabled',
      });
      await page.reload();
      await page.getByRole('tab', { name: /^Canyon Garden/ }).waitFor();
      assert.match(await page.getByRole('tab').first().innerText(), /^Canyon Garden/);
      await page.evaluate(() => window.__missingSessionFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      const saveCurrent = page.getByRole('button', { name: 'Save current session', exact: true });
      const saveBox = await saveCurrent.boundingBox();
      assert.ok(
        saveBox.y >= 0 && saveBox.y + saveBox.height <= 900 && saveBox.x + saveBox.width <= 320,
      );
      await saveCurrent.click();
      await page.getByRole('dialog', { name: 'Keep the current session?', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Resume missing tabs', exact: true }).waitFor();
      const keepChanges = page.getByRole('button', { name: 'Keep current changes', exact: true });
      const keepBox = await keepChanges.boundingBox();
      assert(
        keepBox &&
          keepBox.x >= 0 &&
          keepBox.x + keepBox.width <= 320 &&
          keepBox.y + keepBox.height <= 900,
      );
      await keepChanges.click();
      await page.getByRole('dialog', { name: 'Keep the current session?', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__sessionSaveRequests?.length || 0), 0);
      await page.getByRole('button', { name: 'Resume missing tabs', exact: true }).waitFor();
      await saveCurrent.hover();
      const saveTooltip = page
        .locator('[data-slot="content"]')
        .filter({ hasText: 'Save tabs, groups and organization before quitting.' });
      await saveTooltip.waitFor();
      const tooltipBox = await saveTooltip.boundingBox();
      assert.ok(tooltipBox.x >= 0 && tooltipBox.x + tooltipBox.width <= 320);
      assert.ok(tooltipBox.height > 30);
      await page.screenshot({
        path: 'artifacts/ui-sidebar-missing-session.png',
        animations: 'disabled',
      });
      await keepChanges.click();
      await page
        .getByRole('dialog', { name: 'Keep the current session?', exact: true })
        .getByRole('button', { name: 'Keep current changes', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Resume missing tabs', exact: true })
        .waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.__sessionSaveRequests), [
        { type: 'saveSession', payload: { replaceMissing: true } },
      ]);
      await page
        .getByRole('dialog', { name: 'Keep the current session?', exact: true })
        .waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Workspace menu', exact: true }).waitFor();
      await page.evaluate(() => window.__branchingTreeFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-tab-parent-connectors] path[data-child-id="record-2"]')
            ?.dataset.parentId === 'record-0',
      );
      assert.equal(
        await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-tab-tree-id]')];
          return [...document.querySelectorAll('[data-tab-parent-connectors] path')].every(
            (path) => {
              const otherIcons = rows
                .filter(
                  (row) =>
                    ![path.dataset.parentId, path.dataset.childId].includes(row.dataset.tabTreeId),
                )
                .map((row) => row.querySelector('[data-tab-tree-icon]')?.getBoundingClientRect())
                .filter(Boolean);
              const matrix = path.ownerSVGElement.getScreenCTM();
              for (let sample = 0; sample <= 40; sample++) {
                const point = path.getPointAtLength((path.getTotalLength() * sample) / 40);
                const screen = new window.DOMPoint(point.x, point.y).matrixTransform(matrix);
                if (
                  otherIcons.some(
                    (box) =>
                      screen.x > box.left + 1 &&
                      screen.x < box.right - 1 &&
                      screen.y > box.top + 1 &&
                      screen.y < box.bottom - 1,
                  )
                )
                  return false;
              }
              return true;
            },
          );
        }),
        true,
      );
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle('light', theme === 'light');
          document.documentElement.classList.toggle('dark', theme === 'dark');
        }, theme);
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.activeElement?.blur());
        await page.locator('[data-workspace-project="library"]').screenshot({
          path: `artifacts/ui-nested-svg-branching-${theme}.png`,
          animations: 'disabled',
        });
        const nestedControl = page
          .locator('[data-workspace-record-id="record-3"]')
          .getByRole('button')
          .filter({ hasText: 'Branch level 4' });
        await nestedControl.focus();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-tab-parent-connectors] path[data-parent-id="record-2"]')
              ?.getAttribute('stroke') === 'var(--text-muted)',
        );
        await page.evaluate(() => document.activeElement?.blur());
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-tab-parent-connectors] path[data-parent-id="record-2"]')
              ?.getAttribute('stroke') === 'currentColor',
        );
      }
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'refresh') {
      await page.getByRole('searchbox').first().fill('catalog');
      await page.locator('[data-tabloom-id="record-0"]').waitFor();
      await page.getByText('Searching tabs?', { exact: true }).waitFor({ state: 'hidden' });
      await page.evaluate(() => {
        window.__stateReplyDelay = 250;
        window.__pollStart = window.__stateReplyCount;
        window.__stableSearchRow = document.querySelector('[data-tabloom-id="record-0"]');
        window.__stableRowTop = window.__stableSearchRow.getBoundingClientRect().top;
        window.__disabledDuringPoll = false;
        const enabledControls = new Set(
          [...document.querySelectorAll('button, input, select, textarea, [role=button]')].filter(
            (node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true',
          ),
        );
        window.__pollObserver = new window.MutationObserver((mutations) => {
          if (
            mutations.some(
              ({ target }) =>
                enabledControls.has(target) &&
                (target.disabled || target.getAttribute('aria-disabled') === 'true'),
            )
          )
            window.__disabledDuringPoll = true;
        });
        window.__pollObserver.observe(document.body, {
          attributes: true,
          subtree: true,
          attributeFilter: ['disabled', 'aria-disabled'],
        });
        window.__searchFlashes = false;
        window.__searchObserver = new window.MutationObserver(() => {
          if (
            [...document.querySelectorAll('[role=status]')].some(
              (node) => node.textContent === 'Searching tabs?',
            )
          )
            window.__searchFlashes = true;
        });
        window.__searchObserver.observe(document.body, { childList: true, subtree: true });
      });
      await page.waitForFunction(() => window.__stateReplyCount >= window.__pollStart + 3, {
        timeout: 22000,
      });
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => window.__disabledDuringPoll), false);
      assert.equal(await page.evaluate(() => window.__searchFlashes), false);
      assert.equal(
        await page.evaluate(
          () => window.__stableSearchRow.getBoundingClientRect().top === window.__stableRowTop,
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => window.__stableSearchRow === document.querySelector('[data-tabloom-id="record-0"]'),
        ),
        true,
      );
      await page.screenshot({
        path: 'artifacts/ui-stable-background-refresh.png',
        animations: 'disabled',
      });
      await page.close();
      continue;
    }
    if (process.env.TABFLOW_UI_FOCUS === 'maintenance') {
      await page.evaluate(() => window.__largeWorkspaceFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Projects', exact: true })
        .click();
      await page.getByRole('button', { name: 'Choose project', exact: true }).click();
      await page.getByRole('option', { name: 'Workspace project 1', exact: true }).click();
      await page.getByRole('tab', { name: 'Categories', exact: true }).click();
      await page
        .getByRole('button', { name: 'Category actions for References', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Delete category', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Delete category', exact: true })
        .click();
      await page.getByRole('button', { name: 'Undo category change', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() =>
          window.__maintenanceState().categories.some((item) => item.id === 'category-0'),
        ),
        false,
      );
      assert(
        await page.evaluate(
          () =>
            window
              .__maintenanceState()
              .memberships.filter(
                (item) => item.projectId === 'workspace-0' && item.categoryId === null,
              ).length > 0,
        ),
      );
      await page.getByRole('button', { name: 'Undo category change', exact: true }).click();
      await page
        .getByRole('button', { name: 'Category actions for References', exact: true })
        .waitFor();
      assert(
        await page.evaluate(() =>
          window.__maintenanceState().memberships.some((item) => item.categoryId === 'category-0'),
        ),
      );
      await page.getByRole('button', { name: 'Redo category change', exact: true }).click();
      await page.getByRole('button', { name: 'Undo category change', exact: true }).click();
      await page
        .getByRole('button', { name: 'Category actions for References', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Move category down', exact: true }).click();
      await page.waitForFunction(
        () =>
          window.__maintenanceState().categories.find((item) => item.id === 'category-0').order ===
          1,
      );
      await page.getByRole('button', { name: 'Undo category change', exact: true }).click();
      await page.waitForFunction(
        () =>
          window.__maintenanceState().categories.find((item) => item.id === 'category-0').order ===
          0,
      );
      const categorySource = await page
        .locator('[data-category-id="category-0"] span')
        .first()
        .boundingBox();
      const categoryTarget = await page
        .locator('[data-category-id="category-0-implementation"]')
        .boundingBox();
      assert(categorySource && categoryTarget, 'Both category drag targets are visible');
      await page.mouse.move(categorySource.x + 20, categorySource.y + categorySource.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(categoryTarget.x + 30, categoryTarget.y + categoryTarget.height - 3, {
        steps: 20,
      });
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          window.__maintenanceState().categories.find((item) => item.id === 'category-0').order ===
          1,
      );
      await page.getByRole('button', { name: 'Undo category change', exact: true }).click();
      const projectSource = await page
        .locator('aside [data-project-order-id="workspace-0"]')
        .boundingBox();
      const projectTarget = await page
        .locator('aside [data-project-order-id]')
        .first()
        .boundingBox();
      assert(projectSource && projectTarget);
      await page.mouse.move(projectSource.x + 30, projectSource.y + projectSource.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(projectTarget.x + 30, projectTarget.y + 2, { steps: 20 });
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          document
            .querySelector('aside [data-project-order-id]')
            ?.getAttribute('data-project-order-id') === 'workspace-0',
      );
      for (const theme of ['dark', 'light']) {
        const toggle = page.getByRole('button', {
          name: theme === 'dark' ? 'Switch to dark mode' : 'Switch to light mode',
          exact: true,
        });
        if (await toggle.count()) await toggle.click();
        for (const width of [1440, 420]) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          await page.screenshot({
            path: `artifacts/ui-maintenance-categories-${theme}-${width}.png`,
            animations: 'disabled',
          });
        }
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Settings', exact: true })
        .click();
      await page
        .getByRole('tab', { name: 'Tags', exact: true })
        .click()
        .catch(async (error) => {
          console.error('Maintenance settings body:', await page.locator('body').innerText());
          await page.screenshot({ path: 'artifacts/ui-maintenance-settings-failure.png' });
          throw error;
        });
      const tagRow = () => page.getByText('merged-0', { exact: true }).locator('..');
      await tagRow().getByRole('button', { name: 'Rename', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'New tag name', exact: true })
        .fill('renamed-fixture-label');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Rename tag', exact: true })
        .click();
      await page.getByText('renamed-fixture-label', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Undo tag change', exact: true }).click();
      await tagRow().getByRole('button', { name: 'Delete', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Delete tag', exact: true })
        .click();
      await page.getByText('merged-0', { exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Undo tag change', exact: true }).click();
      await page.getByText('merged-0', { exact: true }).waitFor();
      for (const width of [1440, 420]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({
          path: `artifacts/ui-maintenance-tags-${width}.png`,
          animations: 'disabled',
        });
      }
      await page.evaluate(() => window.__olderChangesFixture());
      await page.setViewportSize({ width: 1440, height: 900 });
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Snapshots & history', exact: true })
        .click();
      await page.getByRole('button', { name: 'Older actions', exact: true }).click();
      const olderTrace = page
        .getByLabel('Assistant action trace', { exact: true })
        .locator('article')
        .filter({ has: page.getByText('Saved edit 4', { exact: true }) });
      await olderTrace.getByRole('button', { name: 'Undo action', exact: true }).click();
      await olderTrace.getByRole('button', { name: 'Redo action', exact: true }).waitFor();
      await olderTrace.getByRole('button', { name: 'Redo action', exact: true }).click();
      await olderTrace.getByRole('button', { name: 'Undo action', exact: true }).waitFor();
      await page.close();
      continue;
    }
    await page
      .locator('[data-tabloom-id="record-0"]')
      .waitFor({ timeout: 10000 })
      .catch(async (error) => {
        console.error('Route body:', (await page.locator('body').innerText()).slice(0, 1800));
        await page.screenshot({ path: 'artifacts/ui-route-failure.png' });
        throw error;
      });
    await page.waitForFunction(() => {
      const mark = document.querySelector('img[src="/icons/mark.svg"]');
      return mark?.complete && mark.naturalWidth > 0;
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page
      .getByRole('searchbox', { name: 'Search tabs', exact: true })
      .locator('..')
      .locator('svg')
      .first()
      .waitFor();
    assert.deepEqual(remoteIconRequests, [], `${label}: icons must render from local bundles`);
    assert.equal(overflow, false, `${label}: horizontal page overflow`);
    await page.screenshot({
      path: `artifacts/ui-${label}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    if (label === 'desktop') {
      await page.getByRole('checkbox', { name: 'Select Catalog', exact: true }).check();
      assert(
        (await page.getByRole('checkbox', { checked: true }).count()) > 0,
        'Group selection checks its tabs',
      );
      await page.getByRole('checkbox', { name: 'Select Catalog', exact: true }).uncheck();
      assert.equal(
        await page.getByRole('checkbox', { checked: true }).count(),
        0,
        'Repeating group selection deselects its tabs',
      );
      await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
      await page.waitForFunction(() => {
        const sidebar = document
          .querySelector('[aria-label="Application navigation"]')
          ?.closest('aside');
        return sidebar && Math.abs(sidebar.getBoundingClientRect().width - 64) < 1;
      });
      const assistantAction = await page
        .getByRole('button', { name: 'Assistant', exact: true })
        .last()
        .boundingBox();
      assert(
        assistantAction && assistantAction.x + assistantAction.width <= width,
        'Collapsed navigation keeps header actions in the viewport',
      );
      await page.getByRole('button', { name: 'Create project', exact: true }).hover();
      await page.screenshot({ path: 'artifacts/ui-sidebar-collapsed.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await page.getByRole('dialog', { name: 'Create a project', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
      await page
        .getByRole('button', { name: 'Classify this window externally', exact: true })
        .first()
        .click();
      await page.getByRole('button', { name: 'Prepare files', exact: true }).click();
      const [windowDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download tab data (.json)', exact: true }).click(),
      ]);
      const windowData = JSON.parse(await readFile(await windowDownload.path(), 'utf8'));
      assert.equal(windowData.scope.kind, 'window');
      assert.equal(windowData.scope.occurrenceCount, 6);
      assert.ok(windowData.tabs.every((tab) => tab.windowId === 1));
      await page.screenshot({ path: 'artifacts/ui-external-window.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      for (const id of ['record-0', 'record-1'])
        await page.locator(`[data-tabloom-id="${id}"]`).getByRole('checkbox').check();
      await page
        .getByLabel('Selected tab actions', { exact: true })
        .getByRole('button', { name: 'Actions', exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: 'Classify selected tabs externally', exact: true })
        .click();
      await page.getByRole('button', { name: 'Prepare files', exact: true }).click();
      const [selectionDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download tab data (.json)', exact: true }).click(),
      ]);
      const selectedData = JSON.parse(await readFile(await selectionDownload.path(), 'utf8'));
      assert.equal(selectedData.scope.kind, 'selection');
      assert.deepEqual(selectedData.scope.occurrenceIds, ['record-0', 'record-1']);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      for (const id of ['record-0', 'record-1'])
        await page.locator(`[data-tabloom-id="${id}"]`).getByRole('checkbox').uncheck();
      await page.evaluate(() => window.__tagFilterFixture(true));
      await activateWorkspaceAction(page, 'Refresh workspace');
      const focusCalls = await page.evaluate(
        () => window.__sidebarRequests.filter((request) => request.type === 'focus').length,
      );
      await page
        .locator('[data-tabloom-id="record-0"]')
        .getByRole('button', { name: /^Harbor Library/ })
        .hover();
      await page
        .getByRole('button', { name: 'Filter tabs tagged Vue', exact: true })
        .first()
        .click();
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.get('tag') === 'Vue',
      );
      assert.equal(await page.locator('[data-tabloom-id]').count(), 2);
      assert.equal(
        await page.evaluate(
          () => window.__sidebarRequests.filter((request) => request.type === 'focus').length,
        ),
        focusCalls,
      );
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.getByRole('button', { name: /^Tags\b/ }).click();
      await page.getByRole('checkbox', { name: 'Filter tag accessibility', exact: true }).check();
      await page.getByRole('button', { name: 'Tag matching', exact: true }).click();
      await page.getByRole('option', { name: 'Match all selected tags', exact: true }).click();
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.get('tagMatch') === 'all',
      );
      assert.equal(await page.locator('[data-tabloom-id]').count(), 1);
      await page.screenshot({ path: 'artifacts/ui-multi-tag-filters.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Save view', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'View name', exact: true })
        .fill('Accessible Vue references');
      await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
      await page.waitForFunction(
        () => JSON.parse(window.localStorage.getItem('tabflow.savedTabViews') || '[]').length === 1,
      );
      await page.reload();
      await page.locator('[data-tabloom-id="record-0"]').waitFor();
      assert.equal(await page.locator('[data-tabloom-id]').count(), 1);
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page
        .getByRole('button', { name: 'Clear filters', exact: true })
        .waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.getByRole('button', { name: /^Saved views\b/ }).click();
      await page.getByRole('button', { name: 'Saved tab views', exact: true }).click();
      await page.getByRole('option', { name: 'Accessible Vue references', exact: true }).click();
      await page.waitForFunction(
        () => new URL(window.location.href).searchParams.get('tagMatch') === 'all',
      );
      assert.equal(await page.locator('[data-tabloom-id]').count(), 1);
      await page.getByRole('button', { name: 'Delete view', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__tagFilterFixture(false));
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('searchbox', { name: 'Search tabs' }).focus();
      assert.equal(
        await page
          .getByRole('searchbox', { name: 'Search tabs' })
          .evaluate((input) => window.getComputedStyle(input).outlineStyle),
        'none',
      );
      await page.screenshot({ path: 'artifacts/ui-search-focus.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Sort tabs', exact: true }).click();
      assert.ok(
        (await page.getByRole('button', { name: 'Sort tabs', exact: true }).boundingBox()).width <=
          40,
      );
      await page.screenshot({ path: 'artifacts/ui-select-focus.png', animations: 'disabled' });
      await page.getByRole('option', { name: 'Recently used', exact: true }).hover();
      await page.screenshot({ path: 'artifacts/ui-select-hover-dark.png', animations: 'disabled' });
      await page.keyboard.press('Escape');
      await activateWorkspaceAction(page, 'Switch to light mode');
      await page.waitForFunction(() => document.documentElement.classList.contains('light'));
      await page.waitForFunction(() => !document.documentElement.dataset.themeTransition);
      assert.equal(
        await page.evaluate(() => window.localStorage.getItem('tabflow-theme')),
        'light',
      );
      await page.screenshot({ path: 'artifacts/ui-light-tabs.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Sort tabs', exact: true }).click();
      await page.getByRole('option', { name: 'Recently used', exact: true }).hover();
      await page.screenshot({
        path: 'artifacts/ui-select-hover-light.png',
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await page
        .locator('[data-tabloom-id="record-0"]')
        .locator('button')
        .filter({ hasText: 'Harbor Library' })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Organize', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Edit tags and note', exact: true }).waitFor();
      await page.screenshot({ path: 'artifacts/ui-menu-hover-light.png', animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const startupPage = await page.context().newPage();
      await startupPage.route('**/chunks/*.js', (route) => route.abort());
      await startupPage.goto(`${base}/sidepanel.html`, { waitUntil: 'load' });
      assert.equal(
        await startupPage.evaluate(() => document.documentElement.classList.contains('light')),
        true,
        'Saved light mode initializes even when all application modules are blocked',
      );
      assert.equal(
        await startupPage.locator('#app').innerHTML(),
        '',
        'Bootstrap test must not mount Vue',
      );
      // Reload must retain the chosen root theme rather than reset to dark.
      await page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(
        await page.evaluate(() => document.documentElement.classList.contains('light')),
        true,
      );
      await page.getByRole('heading', { name: 'Windows & tabs', exact: true }).waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await activateWorkspaceAction(page, 'Switch to dark mode');
      assert.equal(
        await page.evaluate(() => document.documentElement.classList.contains('dark')),
        true,
      );
      await startupPage.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await startupPage.close();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const activation = page
        .locator('[data-tabloom-id="record-0"]')
        .locator('button')
        .filter({ hasText: 'Harbor Library' });
      await activation.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Duplicate tab', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: 'Organize', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Edit tags and note', exact: true }).waitFor();
      const hoveredMenu = page.getByRole('menuitem', { name: 'Organize', exact: true });
      assert.notEqual(
        await hoveredMenu.evaluate((element) => window.getComputedStyle(element).backgroundColor),
        await hoveredMenu.evaluate(
          (element) => window.getComputedStyle(element.closest('[role="menu"]')).backgroundColor,
        ),
      );
      await page.screenshot({ path: 'artifacts/ui-tab-context-menu.png', animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const secondContextPrevented = await activation.evaluate((element) => {
        const event = new window.MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
      assert.equal(
        secondContextPrevented,
        false,
        'A second right-click on the same row permits the native page menu',
      );
      await activation.hover();
      await page.locator('[data-tab-hover-card]').waitFor();
      assert.match(
        await page.locator('[data-tab-hover-card]').innerText(),
        /example.test\/library\/projects/,
      );
      await page.screenshot({ path: 'artifacts/ui-tab-hover.png', animations: 'disabled' });
      await page.mouse.move(0, 0);
      await activation.focus();
      await page.locator('[data-tab-hover-card]').waitFor();
      await page.getByRole('searchbox').focus();
      await page.getByRole('searchbox').fill('Discussion evening');
      await page.waitForFunction(() => document.querySelectorAll('[data-tabloom-id]').length === 1);
      assert.equal(await page.locator('[data-tabloom-id]').count(), 1);
      await page.getByRole('searchbox').fill('');
      if (process.env.TABFLOW_PERF === '1') {
        await page.locator('[data-tabloom-id="performance-499"]').waitFor({ state: 'attached' });
        await page.waitForFunction(
          () => document.querySelectorAll('[data-tabloom-id]').length === 510,
        );
        assert.equal(await page.locator('[data-tabloom-id]').count(), 510);
      }
      await page.getByRole('button', { name: 'Snapshot', exact: true }).click();
      await page.getByLabel('Snapshot name').fill('UI smoke checkpoint');
      const box = await page.getByRole('dialog').boundingBox();
      assert(
        box &&
          Math.abs(box.x + box.width / 2 - width / 2) < 3 &&
          Math.abs(box.y + box.height / 2 - height / 2) < 3,
        'Dialog must be centered',
      );
      await page.screenshot({
        path: 'artifacts/ui-dialog.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText('Snapshot saved', { exact: true }).waitFor();
      await page.screenshot({ path: 'artifacts/ui-toast.png', animations: 'disabled' });
      const toastBox = await page.getByText('Snapshot saved', { exact: true }).boundingBox();
      assert(
        toastBox && toastBox.y >= 0 && toastBox.y + toastBox.height <= height,
        'Notice remains in viewport',
      );
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
      await page.getByRole('button', { name: 'Today', exact: true }).click();
      await page.getByRole('heading', { name: 'Continue browsing', exact: true }).waitFor();
      await page
        .getByRole('button', { name: 'Plan saved work', exact: true })
        .isDisabled()
        .then((disabled) => assert(disabled));
      await page.getByRole('button', { name: 'Add next action', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Work item', exact: true })
        .fill('Review Harbor Library keyboard navigation');
      await page.getByRole('button', { name: 'Add next action', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Work item', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Add next action', exact: true }).click();
      assert.equal(
        await page.getByRole('textbox', { name: 'Work item', exact: true }).inputValue(),
        'Review Harbor Library keyboard navigation',
        'Closing and reopening capture preserves the unsaved action',
      );
      await page.getByRole('button', { name: 'Add to Today', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Review Harbor Library keyboard navigation', exact: true })
        .waitFor();
      await page
        .getByRole('searchbox', { name: 'Search next actions', exact: true })
        .fill('missing action');
      await page.getByRole('heading', { name: 'No matching actions', exact: true }).waitFor();
      await page.getByRole('searchbox', { name: 'Search next actions', exact: true }).fill('');
      await page.getByRole('heading', { name: 'Next actions', exact: true }).click();
      await page
        .getByRole('region', { name: 'Continue browsing', exact: true })
        .getByRole('button')
        .first()
        .hover();
      await page.screenshot({ path: 'artifacts/ui-today.png', animations: 'disabled' });
      await activateWorkspaceAction(page, 'Switch to light mode');
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('light') &&
          !document.documentElement.dataset.themeTransition,
      );
      await page.screenshot({ path: 'artifacts/ui-today-light.png', animations: 'disabled' });
      await activateWorkspaceAction(page, 'Switch to dark mode');
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('dark') &&
          !document.documentElement.dataset.themeTransition,
      );
      await page.getByRole('button', { name: 'Work item status', exact: true }).click();
      await page.getByRole('option', { name: 'Done', exact: true }).click();
      await page.getByRole('heading', { name: 'Completed recently', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Reopen', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Review Harbor Library keyboard navigation', exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Today project', exact: true }).click();
      await page.getByRole('option', { name: 'Personal research', exact: true }).click();
      await page.getByRole('heading', { name: 'Give this day a next step', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Today project', exact: true }).click();
      await page.getByRole('option', { name: 'All projects', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Generative orchestrator' })
        .waitFor()
        .catch(async (error) => {
          console.error('Settings body:', await page.locator('body').innerText(), errors);
          await page.screenshot({ path: 'artifacts/ui-settings-failure.png' });
          throw error;
        });
      assert.equal(await page.getByLabel('Simultaneous model workflows').inputValue(), '1');
      assert.equal(
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .getAttribute('aria-current'),
        'page',
      );
      assert.match(
        await page.getByRole('button', { name: 'Settings', exact: true }).getAttribute('class'),
        /bg-raised/,
      );
      await page.screenshot({
        path: 'artifacts/ui-settings.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page
        .getByLabel('Evidence characters per request', { exact: true })
        .scrollIntoViewIfNeeded();
      assert.equal(
        await page.getByLabel('Evidence characters per request', { exact: true }).inputValue(),
        '64000',
      );
      await page.screenshot({ path: 'artifacts/ui-model-evidence.png', animations: 'disabled' });
      assert.equal(
        await page.getByRole('button', { name: 'Save preferences', exact: true }).count(),
        0,
      );
      const lastModelField = await page
        .getByLabel('Evidence characters per request', { exact: true })
        .boundingBox();

      assert(
        lastModelField && lastModelField.y + lastModelField.height <= height,
        'Final model control is not covered by the save footer',
      );
      await activateWorkspaceAction(page, 'Switch to light mode');
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('light') &&
          !document.documentElement.dataset.themeTransition,
      );
      await page.screenshot({ path: 'artifacts/ui-light-settings.png', animations: 'disabled' });
      await activateWorkspaceAction(page, 'Switch to dark mode');
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('dark') &&
          !document.documentElement.dataset.themeTransition,
      );
      await page.getByRole('tab', { name: 'Suspension', exact: true }).click();
      await page.getByRole('heading', { name: 'Suspension & indexing', exact: true }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-suspension-settings.png',
        fullPage: true,
        animations: 'disabled',
      });
      const historyStarted = Date.now();
      await page.getByRole('button', { name: 'Snapshots & history', exact: true }).click();
      await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
      const historyMs = Date.now() - historyStarted;
      await page.screenshot({
        path:
          process.env.TABFLOW_PERF === '1'
            ? 'artifacts/ui-history-stress.png'
            : 'artifacts/ui-history.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Review & inspect', exact: true }).click();
      await page.getByRole('heading', { name: 'Inspection activity', exact: true }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-review.png',
        fullPage: true,
        animations: 'disabled',
      });
      const tabsStarted = Date.now();
      await page.getByRole('button', { name: 'Windows & tabs', exact: true }).click();
      await page.locator('[data-tabloom-id="record-0"]').waitFor();
      await writeFile(
        `artifacts/route-performance-${process.env.TABFLOW_PERF_LABEL || 'current'}.json`,
        JSON.stringify(
          {
            fixtureTabs: records.length,
            fixtureSnapshots: state.snapshots.length,
            fixtureOperations: state.operations.length,
            historyMs,
            tabsMs: Date.now() - tabsStarted,
            longTasks: await page.evaluate(() => window.__routeLongTasks),
          },
          null,
          2,
        ),
      );
      if (process.env.TABFLOW_PERF === '1' && process.env.TABFLOW_PERF_LABEL !== 'before') {
        await page.getByRole('button', { name: 'Snapshots & history', exact: true }).click();
        assert.equal(await page.locator('main article').count(), 25);
        assert.deepEqual(await page.evaluate(() => window.__detailRequests), []);
        await page.getByRole('button', { name: 'Results', exact: true }).first().click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll('[data-ui-collapsible] [data-slot=content] p').length === 30,
        );
        assert.deepEqual(await page.evaluate(() => window.__detailRequests), ['operation-0']);
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await page
          .getByRole('heading', { name: 'Performance operation 25', exact: true })
          .waitFor();
        assert.equal(await page.locator('main article').count(), 25);
        await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
        await page.getByRole('heading', { name: 'Performance snapshot 0', exact: true }).waitFor();
        assert.equal(await page.locator('main article').count(), 25);
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await page.getByRole('heading', { name: 'Performance snapshot 25', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
        await page
          .getByRole('dialog')
          .getByRole('heading', { name: 'Restore this arrangement?' })
          .waitFor();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
    }
    if (label === 'mobile') {
      await page.getByRole('button', { name: 'Assistant', exact: true }).click();
      await page.getByRole('heading', { name: 'Workspace assistant' }).waitFor();
      await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Add attachments', exact: true }).click();
      const attachmentSearch = page.getByPlaceholder('Search tabs, projects, tags…');
      await attachmentSearch.fill('Glass Orchard catalog');
      await page
        .getByRole('option', { name: /tab.*Harbor Library - The Glass Orchard catalog/ })
        .click();
      await attachmentSearch.fill('Window 2');
      await page.getByRole('option', { name: /window.*Window 2/ }).click();
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', { name: 'Remove attachment: Window 2', exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator('[data-assistant-attachments]')
          .getByRole('button', { name: /Remove attachment:/ })
          .count(),
        2,
      );
      await page.screenshot({
        path: 'artifacts/ui-assistant-attachments-mobile.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Remove attachment: Window 2', exact: true }).click();
      await page
        .getByRole('button', {
          name: 'Remove attachment: Harbor Library - The Glass Orchard catalog',
          exact: true,
        })
        .click();
      assert.equal(
        await page
          .locator('[data-assistant-attachments]')
          .getByRole('button', { name: /Remove attachment:/ })
          .count(),
        0,
      );
      await page.getByRole('button', { name: 'Add attachments', exact: true }).click();
      await attachmentSearch.fill('Glass Orchard catalog');
      await page
        .getByRole('option', { name: /tab.*Harbor Library - The Glass Orchard catalog/ })
        .click();
      await page.keyboard.press('Escape');
      await page
        .getByRole('textbox', { name: 'Message to workspace assistant', exact: true })
        .fill('Prepare synthetic workspace edits');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const editReview = page.getByRole('region', { name: 'Review assistant workspace action' });
      const runningStatus = page
        .locator('div[role="status"]')
        .filter({ has: page.locator('svg.animate-spin') })
        .last();
      await runningStatus.waitFor();
      const aligned = await runningStatus.evaluate((element) => {
        const icon = element.children[0].getBoundingClientRect();
        const text = element.children[1].getBoundingClientRect();
        return Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2) < 1;
      });
      assert(aligned, 'The progress spinner and shimmer text must share a vertical center');
      await page.screenshot({
        path: 'artifacts/ui-progress-alignment.png',
        animations: 'disabled',
      });
      await editReview.getByText('Read the catalog introduction', { exact: false }).waitFor();
      await editReview.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'artifacts/ui-assistant-workspace-edits-mobile.png',
        animations: 'disabled',
      });
      const attachedRequest = completionRequests.find(
        (request) => request.messages.at(-1)?.content === 'Prepare synthetic workspace edits',
      );
      assert(attachedRequest.messages[0].content.includes('"scopeRecordIds":["record-0"]'));
      await editReview.getByRole('button', { name: 'Approval options', exact: true }).click();
      await page.getByRole('menuitem', { name: /^Ask orchestrator to review/ }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-assistant-approval-options.png',
        animations: 'disabled',
      });
      await page.getByRole('menuitem', { name: /^Ask orchestrator to review/ }).click();
      await page.getByText('Orchestrator declined', { exact: true }).waitFor();
      await editReview.getByRole('button', { name: 'Save changes', exact: true }).click();
      const actionTrace = page.getByLabel('Assistant action trace', { exact: true });
      await actionTrace.getByRole('button', { name: 'Undo action', exact: true }).waitFor();
      await actionTrace
        .getByRole('button', { name: 'Undo action', exact: true })
        .scrollIntoViewIfNeeded();
      const approvalToast = page.getByRole('button', { name: 'Dismiss notification', exact: true });
      if (await approvalToast.isVisible()) await approvalToast.click();
      await page.screenshot({
        path: 'artifacts/ui-assistant-action-trace.png',
        animations: 'disabled',
      });
      await actionTrace.getByRole('button', { name: 'Undo action', exact: true }).click();
      await actionTrace.getByText(/Undo: 2 restored/).waitFor();
      await actionTrace.getByRole('button', { name: 'Redo action', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Approvals', exact: true }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Approve for me', exact: true }).click();
      await page.getByRole('button', { name: 'Approvals', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Review pending actions', exact: true }).waitFor();
      assert.equal(await page.getByRole('menu').getByRole('textbox').count(), 0);
      await page.screenshot({
        path: 'artifacts/ui-chat-approvals-mobile.png',
        animations: 'disabled',
      });
      await page.getByRole('menuitemcheckbox', { name: 'Approve all', exact: true }).click();
      await page.getByRole('button', { name: 'Approvals', exact: true }).click();
      assert.equal(
        await page
          .getByRole('menuitemcheckbox', { name: 'Approve all', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      await page.screenshot({
        path: 'artifacts/ui-approve-all-mobile.png',
        animations: 'disabled',
      });
      await page.getByRole('menuitemcheckbox', { name: 'Ask me', exact: true }).click();
      await page.getByRole('button', { name: 'Retry answer', exact: true }).last().click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Retry answer', exact: true })
        .click();
      await page.getByRole('button', { name: 'Previous answer', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Next answer', exact: true }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-chat-answer-branches-mobile.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Previous answer', exact: true }).click();
      await actionTrace.getByRole('button', { name: 'Redo action', exact: true }).waitFor();
      await activateWorkspaceAction(page, 'New conversation');
      await page.getByText('Approval required', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Model quick settings', exact: true }).click();
      await page.getByRole('heading', { name: 'Models and routing' }).waitFor();
      await page.getByRole('button', { name: 'Save model settings', exact: true }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-chat-model-settings-mobile.png',
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Tools and scope', exact: true }).click();
      await page.getByRole('switch', { name: 'Sleep/wake proposals', exact: true }).waitFor();
      await page.screenshot({ path: 'artifacts/ui-chat-tools-mobile.png', animations: 'disabled' });
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Show saved chats' }).click();
      await page.getByRole('complementary', { name: 'Saved chats' }).waitFor();
      const chatDrawer = page.getByRole('dialog', { name: 'Saved chats', exact: true });
      await chatDrawer.waitFor();
      await page.screenshot({ path: 'artifacts/ui-chat-drawer-open.png', animations: 'disabled' });
      await page.mouse.click(384, 450);
      await chatDrawer.waitFor({ state: 'hidden' });
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Show saved chats',
      );
      await page.getByRole('button', { name: 'Show saved chats' }).click();
      await chatDrawer.waitFor();
      await page.keyboard.press('Escape');
      await chatDrawer.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Show saved chats' }).click();
      await page
        .getByRole('complementary', { name: 'Saved chats' })
        .getByRole('button', { name: 'Hide saved chats' })
        .click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: 'artifacts/ui-assistant-mobile.png',
        fullPage: true,
        animations: 'disabled',
      });
      const composerInput = page.getByRole('textbox', {
        name: 'Message to workspace assistant',
        exact: true,
      });
      await composerInput.focus();
      assert.equal(
        await composerInput.evaluate((element) => window.getComputedStyle(element).boxShadow),
        'none',
      );
      assert.equal(
        await page
          .locator('.assistant-composer')
          .evaluate((element) => window.getComputedStyle(element).outlineStyle),
        'none',
      );
      await page.screenshot({
        path: 'artifacts/ui-composer-focus-dark.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Switch to light mode', exact: true }).first().click();
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('light') &&
          !document.documentElement.dataset.themeTransition,
      );
      await composerInput.focus();
      await page.screenshot({
        path: 'artifacts/ui-composer-focus-light.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).first().click();
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('dark') &&
          !document.documentElement.dataset.themeTransition,
      );
      await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await settingsSection(page, 'Models');
      await page.getByRole('heading', { name: 'Generative orchestrator' }).waitFor();
      await settingsSection(page, 'Calendar');
      await settingsSection(page, 'Models');
      await page
        .getByLabel('Evidence characters per request', { exact: true })
        .scrollIntoViewIfNeeded();
      assert.equal(
        await page.getByRole('button', { name: 'Save preferences', exact: true }).count(),
        0,
      );
      const narrowField = await page
        .getByLabel('Evidence characters per request', { exact: true })
        .boundingBox();

      assert(
        narrowField && narrowField.y + narrowField.height <= height,
        'Narrow settings fields remain above footer',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({ path: 'artifacts/ui-settings-mobile.png', animations: 'disabled' });
      await page.getByText('Independent tag proposals', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'artifacts/ui-tag-settings-mobile.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Update TabFlow', exact: true }).click();
      await page.getByRole('heading', { name: 'Activate a new build' }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: 'artifacts/ui-update-mobile.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.goto(`${base}/dashboard.html#today`);
      await page.getByRole('heading', { name: 'Continue browsing', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({ path: 'artifacts/ui-today-mobile.png', animations: 'disabled' });
      await page.goto(`${base}/dashboard.html#projects`);
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page.getByRole('heading', { name: 'Review organization', exact: true }).waitFor();
      await page
        .getByRole('textbox', { name: 'Proposal name', exact: true })
        .fill('Weekend reading draft');
      await page
        .getByRole('navigation', { name: 'Proposed projects' })
        .getByRole('button', { name: /Uncertain tabs/ })
        .click();
      await page.getByRole('button', { name: 'Remove from draft', exact: true }).first().click();
      await page.getByRole('button', { name: 'Removed from draft - 1', exact: true }).click();
      await page.getByRole('button', { name: 'Restore to draft', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: /Removed from draft/ }).count(), 0);
      await page.getByRole('button', { name: 'Save draft edits', exact: true }).click();
      await page.waitForFunction(async () =>
        (await window.chrome.runtime.sendMessage({ type: 'state' })).value.collectionProposals.some(
          (item) => item.name === 'Weekend reading draft',
        ),
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: 'artifacts/ui-collection-mobile.png',
        animations: 'disabled',
      });
    }
    if (label === 'desktop' && process.env.TABFLOW_PERF !== '1') {
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Update TabFlow', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Activate a new build' }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-update.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Save & reload', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('heading', { name: 'Reload TabFlow with the new build?' })
        .waitFor();
      await page.screenshot({
        path: 'artifacts/ui-update-dialog.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Windows & tabs', exact: true }).click();
      await page.evaluate(() => window.__pendingUpdateFixture());
      await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
      await page.getByRole('button', { name: /Finish update · 3 remaining/ }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Resume missing tabs', exact: true }).count(),
        0,
        'Pending update must take precedence over Resume',
      );
      await page.screenshot({
        path: 'artifacts/ui-update-recovery.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByRole('button', { name: /Finish update · 3 remaining/ }).click();
      await page.getByRole('button', { name: 'Finish update', exact: true }).click();
      await page.getByRole('button', { name: 'Review missing tabs', exact: true }).click();
      await page.getByRole('button', { name: 'Resume missing tabs', exact: true }).waitFor();
      await page.evaluate(async () => {
        const thread = {
          id: 'retry-fixture',
          title: 'Saved synthetic request',
          createdAt: 1,
          updatedAt: Date.now(),
          projectId: null,
          status: 'error',
          messages: [
            {
              id: 'request-1',
              role: 'user',
              content: 'Summarize my synthetic workspace',
              createdAt: 1,
              request: {
                task: 'work',
                recordIds: [],
                projectId: null,
                selectedRecordIds: [],
                allowCrossWindowMove: false,
                allowSleepWake: false,
              },
            },
            {
              id: 'attempt-1',
              role: 'assistant',
              content:
                '## Investigate first\n- Check the synthetic tab\n\n![remote](https://example.test/remote.png)\n<img src="https://example.test/raw.png">',
              createdAt: 2,
              requestMessageId: 'request-1',
              collectionProposalId: 'partial-review-fixture',
              deliveryStatus: 'error',
              outcome: 'The provider returned no answer.',
              toolEvents: [
                {
                  id: 'tool-1',
                  tool: 'list_tabs',
                  phase: 'returned',
                  summary: 'One synthetic tab found',
                  createdAt: 2,
                },
                {
                  id: 'tool-2',
                  tool: 'read_workspace',
                  phase: 'requested',
                  summary: 'Requested read_workspace',
                  details: '{"scope":"all"}',
                  createdAt: 3,
                },
                {
                  id: 'tool-2',
                  tool: 'read_workspace',
                  phase: 'returned',
                  summary: 'One workspace found',
                  details: '{"windows":2}',
                  createdAt: 1003,
                },
              ],
            },
            {
              id: 'request-2',
              role: 'user',
              content: 'Organize all synthetic tabs',
              createdAt: 4,
              request: {
                task: 'work',
                recordIds: [],
                projectId: null,
                selectedRecordIds: [],
                allowCrossWindowMove: false,
                allowSleepWake: false,
              },
            },
            {
              id: 'attempt-2',
              role: 'assistant',
              content: 'Analysis paused after batch 6',
              createdAt: 5,
              requestMessageId: 'request-2',
              deliveryStatus: 'error',
              collectionAnalysisId: 'request-2',
              analysisFailure: {
                stage: 'classification',
                completed: 245,
                total: 330,
                batchCount: 1,
                attempts: 3,
              },
              outcome: 'Model output limit',
              toolEvents: [],
            },
          ],
        };
        await new Promise((resolve, reject) => {
          const open = window.indexedDB.open('tabloom');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction(
              ['assistantThreads', 'assistantAudit', 'inferenceReceipts', 'collectionAnalyses'],
              'readwrite',
            );
            tx.objectStore('assistantThreads').put(thread);
            const progressScope = Array.from({ length: 330 }, (_, index) => ({
              id: `progress-${index}`,
              url: `https://example.test/progress/${index}`,
              navigationVersion: 0,
            }));
            tx.objectStore('collectionAnalyses').put({
              id: 'request-2',
              createdAt: 1,
              updatedAt: 1,
              revision: 1,
              purpose: 'proposal',
              instruction: '',
              reuseAcceptedTaxonomyOnly: true,
              scope: progressScope,
              discoveredIds: progressScope.map((item) => item.id),
              classifiedIds: progressScope.slice(0, 245).map((item) => item.id),
              unresolvedRecordIds: progressScope.slice(0, 245).map((item) => item.id),
              projects: [],
              assignments: [],
              summaries: [],
              skippedRecordIds: ['progress-0'],
              failedBatch: {
                stage: 'classification',
                recordIds: ['progress-245'],
                attempts: 3,
                error: 'Synthetic output failure',
                failedAt: 1,
              },
            });
            for (let i = 1; i <= 127; i++)
              tx.objectStore('assistantAudit').put({
                id: `audit-${i}`,
                messageId: 'attempt-1',
                sequence: i,
                createdAt: i,
                text: `Saved decision ${i}`,
              });
            for (let i = 1; i <= 107; i++)
              tx.objectStore('inferenceReceipts').put({
                id: `receipt-${i}`,
                analysisId: 'request-2',
                contract: 'isolated-evidence-v2',
                stage: 'tagging',
                model: 'synthetic-decision',
                startedAt: i * 1000,
                finishedAt: i * 1000 + 220,
                outcome: 'responded',
                request: JSON.stringify({ question: `Tag check ${i}` }),
                response: '{"answers":{}}',
              });
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      });
      await page.evaluate(() => window.__actionPlanFixture());
      await page.reload();
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Assistant', exact: true })
        .click();
      await page.getByRole('button', { name: 'Retry request', exact: true }).waitFor();
      await page.getByText('Saved action plan · 1/2 tabs').waitFor();
      const resumeAnalysis = page.getByRole('button', { name: 'Retry failed batch', exact: true });
      await resumeAnalysis.waitFor();
      await page
        .getByText('Categories 244/329 · 1 skipped · 1 failed in classification after 3 attempts', {
          exact: true,
        })
        .waitFor();
      await resumeAnalysis.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'artifacts/ui-assistant-analysis-resume.png',
        animations: 'disabled',
      });
      const savedAnswer = page.locator('article').filter({ hasText: 'Investigate first' });
      await savedAnswer.getByRole('heading', { name: 'Investigate first' }).waitFor();
      const fullHistory = savedAnswer
        .getByRole('button', { name: 'Full run history', exact: true })
        .locator('..');
      await fullHistory.getByRole('button', { name: 'Full run history', exact: true }).click();
      await fullHistory.getByText('1\u201350 of 127', { exact: true }).waitFor();
      await fullHistory.getByRole('button', { name: 'Latest', exact: true }).click();
      await fullHistory.getByText('101\u2013127 of 127', { exact: true }).waitFor();
      await fullHistory.getByText(/Saved decision 127/).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-assistant-full-history.png',
        animations: 'disabled',
      });
      await fullHistory.getByRole('button', { name: 'Full run history', exact: true }).click();
      const analysisAnswer = page
        .locator('article')
        .filter({ hasText: 'Analysis paused after batch 6' });
      const receipts = analysisAnswer
        .getByRole('button', { name: 'Inference requests', exact: true })
        .locator('..');
      await receipts.getByRole('button', { name: 'Inference requests', exact: true }).click();
      await receipts.getByText('1\u201325 of 107', { exact: true }).waitFor();
      await receipts.getByRole('button', { name: 'Latest', exact: true }).click();
      await receipts.getByText('101\u2013107 of 107', { exact: true }).waitFor();
      await receipts.locator('[data-ui-collapsible]').last().getByRole('button').first().click();
      await receipts.getByText(/Tag check 107/).waitFor();
      await receipts.getByText(/Tag check 107/).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'artifacts/ui-inference-receipts.png',
        animations: 'disabled',
      });
      await receipts.getByRole('button', { name: 'Inference requests', exact: true }).click();
      await savedAnswer.getByText('Saved tool activity').click();
      await savedAnswer.getByText('1.0 s').waitFor();
      await savedAnswer
        .locator('[data-tool-call]')
        .last()
        .locator('[data-slot=trigger]')
        .first()
        .click();
      await savedAnswer.getByText(/"scope":\s*"all"/).waitFor();
      await savedAnswer.getByText(/"windows":\s*2/).waitFor();
      await savedAnswer
        .locator('[data-tool-call]')
        .first()
        .locator('[data-slot=trigger]')
        .first()
        .click();
      await savedAnswer.getByText('One synthetic tab found').waitFor();
      assert.equal(await savedAnswer.locator('img').count(), 0);
      assert.equal(await savedAnswer.locator('iframe').count(), 0);
      assert.equal(
        await savedAnswer.evaluate((article) => {
          const log = article.querySelector('[data-tool-activity]');
          const answer = article.querySelector('.assistant-markdown');
          return Boolean(
            log &&
            answer &&
            log.compareDocumentPosition(answer) &
              article.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
        true,
      );
      const transcriptViewport = page.getByLabel('Conversation messages', { exact: true });
      const firstTool = savedAnswer
        .locator('[data-tool-call]')
        .first()
        .locator('[data-slot=trigger]')
        .first();
      const lastTool = savedAnswer
        .locator('[data-tool-call]')
        .last()
        .locator('[data-slot=trigger]')
        .first();
      await firstTool.evaluate((button) => button.click());
      await lastTool.evaluate((button) => button.click());
      await transcriptViewport.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new window.Event('scroll'));
      });
      await page.getByRole('button', { name: 'Jump to latest messages' }).waitFor();
      const beforeGrowth = await transcriptViewport.evaluate((element) => element.scrollTop);
      await lastTool.evaluate((button) => button.click());
      await savedAnswer.getByText(/"windows":\s*2/).waitFor();
      await page.waitForTimeout(300);
      assert(
        Math.abs(
          (await transcriptViewport.evaluate((element) => element.scrollTop)) - beforeGrowth,
        ) < 3,
        'Growing tool output must not pull a reader back down',
      );
      await page.getByRole('button', { name: 'Jump to latest messages' }).click();
      await page.waitForFunction(() => {
        const el = document.querySelector('[aria-label="Conversation messages"]');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
      });
      await firstTool.evaluate((button) => button.click());
      await page.waitForTimeout(300);
      assert(
        await transcriptViewport.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 72,
        ),
        'Tool growth must follow the bottom when the reader has resumed following',
      );
      await firstTool.evaluate((button) => button.click());
      await page.waitForTimeout(300);
      await page
        .getByRole('button', { name: 'Jump to latest messages' })
        .waitFor({ state: 'hidden' });
      await page.screenshot({ path: 'artifacts/ui-assistant-retry.png', animations: 'disabled' });
      await page.screenshot({
        path: 'artifacts/ui-assistant-action-resume.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Tools and scope', exact: true }).click();
      await page.getByRole('switch', { name: 'Sleep/wake proposals' }).check();
      await page.screenshot({ path: 'artifacts/ui-chat-tools.png', animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Retry request', exact: true }).click();
      await page.getByText('Recovered the saved synthetic request.').first().waitFor();
      await page
        .getByRole('button', { name: /^Thought/ })
        .last()
        .click();
      await page
        .getByText('Synthetic provider reasoning for this test only.', { exact: true })
        .waitFor();
      await page.screenshot({ path: 'artifacts/ui-chat-thinking.png', animations: 'disabled' });
      const savedReasoning = await page.evaluate(
        async () =>
          new Promise((resolve, reject) => {
            const open = window.indexedDB.open('tabloom');
            open.onsuccess = () => {
              const request = open.result
                .transaction('assistantThreads')
                .objectStore('assistantThreads')
                .getAll();
              request.onsuccess = () => {
                open.result.close();
                resolve(JSON.stringify(request.result));
              };
              request.onerror = () => reject(request.error);
            };
            open.onerror = () => reject(open.error);
          }),
      );
      assert(
        !savedReasoning.includes('Synthetic provider reasoning'),
        'Live provider reasoning must not leak into saved conversation data',
      );

      assert.equal(
        completionRequests.some((request) =>
          request.messages?.some(
            (message) =>
              message.role === 'system' && message.content.includes('"sleepWakeProposals":true'),
          ),
        ),
        true,
      );
      assert.equal(
        await page.getByText('Summarize my synthetic workspace', { exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByRole('button', { name: 'Retry request', exact: true }).count(),
        0,
      );
      await page.screenshot({
        path: 'artifacts/ui-assistant-recovered.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Model quick settings', exact: true }).click();
      await page.getByRole('heading', { name: 'Models and routing' }).waitFor();
      await page.getByRole('button', { name: 'Discover models', exact: true }).click();
      await page.getByRole('button', { name: 'Quick model', exact: true }).click();
      await page
        .getByPlaceholder('Search options\u2026', { exact: true })
        .fill('fixture-chat-fast');
      await page.getByRole('option', { name: 'fixture-chat-fast', exact: true }).click();
      await page
        .getByRole('spinbutton', { name: 'Quick loaded context tokens', exact: true })
        .fill('49152');
      await page.getByRole('slider').first().press('ArrowRight');
      await page.screenshot({
        path: 'artifacts/ui-chat-model-settings.png',
        animations: 'disabled',
      });
      await page.evaluate(async () => {
        const settings = (await window.chrome.runtime.sendMessage({ type: 'state' })).value
          .settings;
        await window.chrome.runtime.sendMessage({
          type: 'settings',
          payload: { ...settings, snapshotRetention: 137 },
        });
      });
      await page.getByRole('button', { name: 'Save model settings', exact: true }).click();
      const quickSettings = await page.evaluate(
        async () => (await window.chrome.runtime.sendMessage({ type: 'state' })).value.settings,
      );
      assert.equal(quickSettings.aiModel, 'fixture-chat-fast');
      assert.equal(quickSettings.aiContextTokens, 50176);
      assert.equal(
        quickSettings.snapshotRetention,
        137,
        'Quick controls must preserve unrelated preferences saved by another view',
      );
      await page.getByRole('heading', { name: 'Models and routing' }).waitFor({ state: 'hidden' });
      const chats = page.getByRole('navigation', { name: 'Chat projects' });
      await chats.getByRole('button', { name: 'Saved synthetic request', exact: true }).waitFor();
      await chats.getByRole('button', { name: 'Move Saved synthetic request' }).click();
      await page.getByRole('menuitem', { name: 'Move to Harbor Library' }).click();
      await page.getByRole('button', { name: 'Tools and scope', exact: true }).click();
      await page.getByText('Harbor Library', { exact: true }).last().waitFor();
      await page.keyboard.press('Escape');
      await chats.getByRole('button', { name: 'Saved synthetic request', exact: true }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-assistant-project-chats.png',
        animations: 'disabled',
      });
      const chatSearch = page.getByRole('searchbox', { name: 'Search saved chats' });
      assert.equal(await chatSearch.count(), 1);
      await page.getByRole('button', { name: 'Switch to light mode', exact: true }).first().click();
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('light') &&
          !document.documentElement.dataset.themeTransition,
      );
      await page.screenshot({ path: 'artifacts/ui-light-chats.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).first().click();
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('dark') &&
          !document.documentElement.dataset.themeTransition,
      );
      await chats.getByRole('button', { name: /^Harbor Library/ }).click();
      await chats
        .getByRole('button', { name: 'Saved synthetic request', exact: true })
        .waitFor({ state: 'hidden' });
      await chats.getByRole('button', { name: /^Harbor Library/ }).click();
      await chats.getByRole('button', { name: 'Saved synthetic request', exact: true }).waitFor();
      await page.goto(`${base}/dashboard.html#projects`);
      await page.getByRole('tab', { name: 'Tabs', exact: true }).click();
      const projectTabs = page.getByRole('region', { name: 'Project tabs', exact: true });
      await projectTabs.locator('[data-tabloom-id="record-0"]').waitFor();
      assert.equal(
        await page.getByRole('heading', { name: 'Project context', exact: true }).count(),
        0,
        'Opening a project shows tabs before settings',
      );
      const beforeProjectOpen = await page.evaluate(
        () => window.__sidebarRequests.filter((request) => request.type === 'focus').length,
      );
      await projectTabs
        .getByRole('button', { name: /^Harbor Library - The Glass Orchard catalog/ })
        .click();
      assert.equal(
        await page.evaluate(
          () => window.__sidebarRequests.filter((request) => request.type === 'focus').length,
        ),
        beforeProjectOpen + 1,
        'The whole tab title opens its occurrence',
      );
      for (const width of [1440, 420]) {
        await page.setViewportSize({ width, height: 1000 });
        await projectTabs.scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({
          path: `artifacts/ui-project-tabs-first-${width}.png`,
          animations: 'disabled',
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page.getByText('2 of 9 eligible tabs covered').waitFor();
      await page.getByRole('button', { name: 'Analyze tags', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('dialog', { name: 'Saved chats', exact: true }).count(),
        0,
        'A hidden assistant must not leave a portaled chat drawer active',
      );
      const proposalPicker = page
        .locator('label.field-label')
        .filter({ hasText: 'Review proposal' });
      await proposalPicker.waitFor();
      await proposalPicker.getByRole('button').click();
      await page.getByRole('option', { name: /Personal references/ }).click();
      await page.getByText('1 of 9 eligible tabs covered').waitFor();
      await proposalPicker.getByRole('button').click();
      await page.getByRole('option', { name: /Research/ }).click();
      await page.getByText('2 of 9 eligible tabs covered').waitFor();
      await page.getByRole('button', { name: 'Analyze tags', exact: true }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-collection-partial.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByRole('button', { name: /Uncertain tabs/ }).click();
      await page.getByText('Tags needing review').first().click();
      await page.getByRole('button', { name: 'Add to draft', exact: true }).first().waitFor();
      await page.screenshot({ path: 'artifacts/ui-tag-review.png', animations: 'disabled' });
      const tagsBeforeReview = await page.evaluate(
        async () =>
          (await window.chrome.runtime.sendMessage({ type: 'state' })).value.records[0].tags,
      );
      await page.getByRole('button', { name: 'Add to draft', exact: true }).first().click();
      const tagsAfterReview = await page.evaluate(
        async () =>
          (await window.chrome.runtime.sendMessage({ type: 'state' })).value.records[0].tags,
      );
      assert.deepEqual(
        tagsAfterReview,
        tagsBeforeReview,
        'Adding a suggestion to a draft must not change owner tags',
      );
      await page
        .getByRole('navigation', { name: 'Proposed projects' })
        .getByRole('button', { name: /^Research/ })
        .click();
      await page.getByText('Edit project, categories and merge').click();
      await page
        .getByRole('textbox', { name: 'Purpose', exact: true })
        .fill('Locally edited purpose');
      await page.getByRole('button', { name: 'Saved synthetic request', exact: true }).click();
      await page.waitForURL('**#assistant');
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Projects' })
        .click();
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page.getByRole('heading', { name: 'Review organization', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('textbox', { name: 'Purpose', exact: true }).inputValue(),
        'Locally edited purpose',
      );
      const mergeResearch = page.getByRole('button', {
        name: 'Merge Research into another project',
      });
      await mergeResearch.click();
      await page.getByRole('option', { name: 'Reading', exact: true }).click();
      await page
        .getByRole('button', { name: 'Merge Research into another project' })
        .waitFor({ state: 'hidden' });
      await page.screenshot({
        path: 'artifacts/ui-project-merge.png',
        fullPage: true,
        animations: 'disabled',
      });
      await page.evaluate(() => window.__projectAnalysisFixture());
      const projectPicker = page.getByRole('button', { name: 'Choose project' });
      await projectPicker.click();
      await page.getByRole('option', { name: /Canyon Garden/ }).click();
      await projectPicker.click();
      await page.getByRole('option', { name: /Harbor Library/ }).click();
      await page.getByRole('tab', { name: 'Organize', exact: true }).click();
      await page.getByText('Saved analysis: 0 of 1 tabs classified.').waitFor();
      await page.getByRole('button', { name: 'Resume analysis' }).waitFor();
      await page.getByRole('button', { name: 'Start new' }).waitFor();
      await page.getByText('Saved analysis: 0 of 1 tabs classified.').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'artifacts/ui-project-resume.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Project options', exact: true }).click();
      await page
        .getByRole('menuitem', { name: 'Classify project externally', exact: true })
        .click();
      await page.getByRole('button', { name: 'Prepare files', exact: true }).click();
      const [projectDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download tab data (.json)', exact: true }).click(),
      ]);
      const projectData = JSON.parse(await readFile(await projectDownload.path(), 'utf8'));
      assert.equal(projectData.scope.kind, 'project');
      assert.equal(projectData.scope.occurrenceCount, 6);
      assert.ok(projectData.tabs.every((tab) => tab.currentProject === 'Harbor Library'));
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.evaluate(() => window.__largeProposalFixture());
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page.getByRole('button', { name: 'Classify externally', exact: true }).click();
      await page.getByRole('button', { name: 'Prepare files', exact: true }).click();
      const [contextDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download context (.md)', exact: true }).click(),
      ]);
      assert.equal(contextDownload.suggestedFilename(), 'tabflow-context.md');
      const instructions = await readFile(await contextDownload.path(), 'utf8');
      assert.match(instructions, /Every supplied occurrence/);
      assert.match(instructions, /complete user request/);
      assert.match(instructions, /No additional pasted prompt/);
      await writeFile('artifacts/external-classification-context.md', instructions);
      const [dataDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download tab data (.json)', exact: true }).click(),
      ]);
      const externalData = JSON.parse(await readFile(await dataDownload.path(), 'utf8'));
      assert.equal(externalData.tabs.length, 340);
      assert.equal(externalData.scope.kind, 'all');
      assert.equal(externalData.scope.occurrenceCount, 340);
      assert.deepEqual(
        externalData.scope.occurrenceIds,
        externalData.tabs.map((tab) => tab.occurrenceId),
      );
      await page.screenshot({
        path: 'artifacts/ui-external-classification.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      const response = {
        format: 'tabflow-collection-proposal',
        version: 1,
        scope: externalData.scope,
        summary: 'Imported synthetic review draft',
        projects: [
          {
            name: 'External reference',
            areaName: 'Test',
            purpose: 'Review imported tabs',
            categories: [{ name: 'Docs', description: 'References' }],
          },
        ],
        assignments: externalData.tabs
          .filter((tab) => !tab.protected && !tab.ownerAssigned)
          .slice(0, 2)
          .map((tab) => ({
            ...tab,
            projectName: 'External reference',
            categoryName: 'Docs',
            reason: 'Supplied title',
            confidence: 0.8,
            suggestedTags: ['reference'],
          })),
        unresolved: externalData.tabs
          .filter(
            (tab) =>
              tab.protected ||
              tab.ownerAssigned ||
              !externalData.tabs
                .filter((item) => !item.protected && !item.ownerAssigned)
                .slice(0, 2)
                .some((item) => item.occurrenceId === tab.occurrenceId),
          )
          .map((tab) => ({ ...tab, reason: 'Needs owner review' })),
      };
      await page.getByLabel('Proposal JSON file', { exact: true }).setInputFiles({
        name: 'external-proposal.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(response)),
      });
      await page.getByRole('dialog').getByText('2 assigned · 337 uncertain · 1 skipped').waitFor();
      await page.screenshot({ path: 'artifacts/ui-proposal-import.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Save review draft', exact: true }).click();
      await page
        .getByText('Imported as a new review draft. No organization was applied.', { exact: true })
        .waitFor();
      await page
        .getByRole('navigation', { name: 'Proposed projects' })
        .getByRole('button', { name: /External reference/ })
        .waitFor();
      await activateWorkspaceAction(page, 'Refresh workspace');
      await proposalPicker.getByRole('button').click();
      await page.getByRole('option', { name: /Project 1, Project 2/ }).click();
      await page.getByText('330 of 339 eligible tabs covered').waitFor();
      await page
        .getByRole('navigation', { name: 'Proposed projects' })
        .getByRole('button', { name: /All assigned tabs/ })
        .click();
      assert.equal(await page.getByRole('button', { name: /^Synthetic tab \d+$/ }).count(), 30);
      await page.getByRole('button', { name: /Show next 30 of 217/ }).click();
      assert.equal(await page.getByRole('button', { name: /^Synthetic tab \d+$/ }).count(), 60);
      await page
        .getByRole('navigation', { name: 'Proposed projects' })
        .getByRole('button', { name: /Uncertain tabs/ })
        .click();
      assert.equal(await page.getByText(/^Synthetic tab \d+$/).count(), 30);
      await page
        .getByRole('heading', { name: 'Review organization', exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: 'artifacts/ui-collection-large.png',
        animations: 'disabled',
      });
    }
    if (label === 'mobile') {
      await page.goto(`${base}/sidepanel.html`);
      await page
        .getByRole('button', { name: 'This window' })
        .waitFor()
        .catch(async (error) => {
          console.error(
            'Side panel body:',
            (await page.locator('body').innerText()).slice(0, 1500),
          );
          await page.screenshot({ path: 'artifacts/ui-sidepanel-failure.png' });
          throw error;
        });
      await page.getByRole('button', { name: 'This window', exact: true }).click();
      await page.getByText('6 tabs', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'All tabs' }).click();
      await page.getByText('10 tabs', { exact: true }).waitFor();
      await page.mouse.move(0, 0);
      await page.screenshot({ path: 'artifacts/ui-docs-sidebar.png', animations: 'disabled' });
      await page.evaluate(() => window.__largeWorkspaceFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByText('340 tabs', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-workspace-record-id]').count(), 35);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: 'artifacts/ui-sidepanel-workspace.png',
        animations: 'disabled',
      });
      const workspaceViewport = page.locator('main > [data-reka-scroll-area-viewport]');
      await workspaceViewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-workspace-record-id]').length >= 70,
      );
      assert.equal(await page.getByRole('button', { name: /Show more/ }).count(), 0);
      await workspaceViewport.evaluate((element) => {
        element.scrollTop = 0;
      });
      await workspaceViewport.focus();
      await page.keyboard.press('PageDown');
      await page.waitForFunction(
        () => document.querySelector('main > [data-reka-scroll-area-viewport]')?.scrollTop > 0,
      );
      await page.keyboard.press('Control+Home');
      await page.waitForFunction(
        () => document.querySelector('main > [data-reka-scroll-area-viewport]')?.scrollTop === 0,
      );
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      const projectTrigger = page.getByRole('button', { name: /^Workspace project 1\b/ });
      await projectTrigger.click();
      const projectRows = page.locator('[data-workspace-project="workspace-0"]');
      await projectRows.getByRole('button', { name: /^Implementation/ }).waitFor();
      assert.equal(await projectRows.locator('[data-workspace-record-id]').count(), 16);
      const categoryTrigger = projectRows.getByRole('button', { name: /^Implementation/ });
      await categoryTrigger.click();
      await page.waitForTimeout(200);
      assert.equal(await projectRows.locator('[data-workspace-record-id]').count(), 8);
      await categoryTrigger.click();
      await projectRows.getByRole('button', { name: /^References/ }).click();
      await page
        .locator('main [data-reka-scroll-area-viewport]')
        .first()
        .evaluate((main) => {
          main.scrollTop = 0;
        });
      await page.screenshot({ path: 'artifacts/ui-sidepanel-project.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Filters', exact: true }).click();
      await page.getByRole('button', { name: /^Native group\b/ }).click();
      await page.getByRole('button', { name: 'Filter by native group' }).waitFor();
      await page.screenshot({ path: 'artifacts/ui-workspace-filters.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page
        .getByRole('button', { name: 'Filter by native group' })
        .waitFor({ state: 'hidden' });
      await projectTrigger.click();
      await projectRows.waitFor({ state: 'detached' });
      assert.equal(
        await projectRows.count(),
        0,
        'Collapsed projects unmount their hidden tab rows',
      );
      await projectTrigger.click();
      const firstRow = projectRows.locator('[data-workspace-record-id="large-0"]');
      await projectRows.getByRole('button', { name: /^References/ }).click();
      await page.setViewportSize({ width: 430, height: 1800 });
      await page.waitForTimeout(350);
      const references = projectRows.locator('[data-section-id="category-0"]');
      const handleBox = await firstRow
        .locator('button')
        .filter({ hasText: 'Synthetic tab 0' })
        .first()
        .boundingBox();
      const targetBox = await references
        .locator('[data-workspace-record-id="large-16"]')
        .boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(
        handleBox.x + handleBox.width / 2 + 10,
        handleBox.y + handleBox.height / 2,
        { steps: 5 },
      );
      await page.waitForTimeout(180);
      await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
        steps: 20,
      });
      await page.waitForTimeout(180);
      await page.locator('.tab-drag-preview').waitFor();
      await page.locator('[data-tab-hover-card]').waitFor({ state: 'hidden' });
      assert.equal(
        await page
          .locator('.tab-drag-placeholder:not(.tab-drag-preview)')
          .evaluateAll((slots) =>
            slots.every((slot) =>
              [...slot.children].every(
                (child) => window.getComputedStyle(child).visibility === 'hidden',
              ),
            ),
          ),
        true,
        'The source slot hides its contents while the single drag preview is visible',
      );
      await page.screenshot({
        path: 'artifacts/ui-sidebar-drag-preview.png',
        animations: 'disabled',
      });
      await page.mouse.up();
      await page.screenshot({ path: 'artifacts/ui-sidebar-drag.png', animations: 'disabled' });
      await references.locator('[data-workspace-record-id="large-0"]').waitFor();
      await page.setViewportSize({ width: 430, height: 900 });

      assert.equal(
        await page.evaluate(
          () => window.__sidebarRequests.filter((request) => request.type === 'apply').length,
        ),
        0,
        'Semantic drag must not mutate browser placement',
      );
      await firstRow
        .getByRole('button', { name: 'Actions for Synthetic tab 0', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Browser and protection', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
      await firstRow.getByLabel('Pinned tab', { exact: true }).waitFor();
      await firstRow
        .getByRole('button', { name: 'Actions for Synthetic tab 0', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Browser and protection', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Mute tab', exact: true }).click();
      await firstRow.getByLabel('Muted tab', { exact: true }).waitFor();
      await firstRow
        .getByRole('button', { name: 'Actions for Synthetic tab 0', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Browser and protection', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Move down in TabFlow', exact: true }).click();
      assert.ok(
        await page.evaluate(() =>
          JSON.parse(window.localStorage.getItem('tabflow.workspace.semanticOrder'))[
            'category-0'
          ].includes('large-0'),
        ),
      );
      await activateWorkspaceAction(page, 'Select tabs');
      await firstRow.getByRole('checkbox', { name: 'Select Synthetic tab 0', exact: true }).click();
      await projectRows
        .locator('[data-workspace-record-id="large-32"]')
        .getByRole('checkbox')
        .click();
      await page.getByRole('button', { name: '2 selected · Actions', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Done selecting', exact: true }).click();
      await page.evaluate(() => window.__sidebarCurrentFixture());
      await activateWorkspaceAction(page, 'Refresh workspace');
      await page.getByRole('searchbox', { name: 'Search tabs' }).fill('no matching reference');
      await activateWorkspaceAction(page, 'Reveal current tab');
      const activeRow = page.locator('[data-workspace-record-id="large-241"]');
      await activeRow.locator('button[aria-current="page"]').waitFor();
      await activeRow.locator('button[aria-current="page"]').click();
      assert.equal(
        await page.evaluate(
          () =>
            window.__sidebarRequests.filter((request) => request.type === 'focus').at(-1)?.payload
              .id,
        ),
        'large-241',
      );
      assert.equal(await page.getByRole('searchbox', { name: 'Search tabs' }).inputValue(), '');
      assert.ok((await page.locator('[data-workspace-record-id]').count()) < 50);
      await page.screenshot({ path: 'artifacts/ui-sidepanel-current.png', animations: 'disabled' });
      if ((await projectTrigger.getAttribute('aria-expanded')) !== 'true')
        await projectTrigger.click();
      await projectRows
        .locator('[data-workspace-record-id="large-0"]')
        .getByRole('button', { name: 'Actions for Synthetic tab 0', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Organize', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Move to Inbox', exact: true }).click();
      await page.getByRole('button', { name: /^Inbox ·/ }).click();
      await page.getByRole('searchbox', { name: 'Search tabs' }).fill('Synthetic tab 0');
      await page.locator('[data-workspace-record-id="large-0"]').waitFor();
      await page.getByRole('switch', { name: 'Suggest organization for new tabs' }).waitFor();
      await page.screenshot({ path: 'artifacts/ui-sidepanel-inbox.png', animations: 'disabled' });
      await page.getByRole('searchbox', { name: 'Search tabs' }).fill('');
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await page.setViewportSize({ width: 430, height: 1800 });
      await page.waitForTimeout(350);
      const moving = projectRows.locator(
        '[data-workspace-record-id="large-32"] button:not([aria-haspopup=menu]):not([role=checkbox])',
      );
      const movingBox = await moving.boundingBox();
      const otherProject = page.getByRole('button', { name: /^Workspace project 2\b/ });
      const otherBox = await otherProject.boundingBox();
      await page.mouse.move(movingBox.x + movingBox.width / 2, movingBox.y + movingBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(
        movingBox.x + movingBox.width / 2 + 10,
        movingBox.y + movingBox.height / 2,
        { steps: 5 },
      );
      await page.waitForTimeout(180);
      await page.mouse.move(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2, {
        steps: 20,
      });
      const otherDrop = page.locator('[data-section-id="workspace-1:none"]');
      await otherDrop.waitFor();
      await page.waitForTimeout(350);
      await otherDrop.scrollIntoViewIfNeeded();
      await page.waitForTimeout(180);
      const otherDropBox = await otherDrop.boundingBox();
      await page.mouse.move(
        otherDropBox.x + otherDropBox.width / 2,
        otherDropBox.y + otherDropBox.height / 2,
        { steps: 10 },
      );
      await page.waitForTimeout(180);
      await page.mouse.up();
      await otherDrop.locator('[data-workspace-record-id="large-32"]').waitFor();
      assert.equal(
        await page.evaluate(
          () => window.__sidebarRequests.filter((request) => request.type === 'apply').length,
        ),
        2,
        'Cross-project drag must not call browser Apply',
      );
      await page.setViewportSize({ width: 430, height: 900 });
      await page.getByRole('button', { name: /^Inbox ·/ }).click();
      await page.getByRole('searchbox', { name: 'Search tabs' }).fill('Synthetic tab 0');
      const editable = page.locator('[data-workspace-record-id="large-0"]');
      await editable
        .getByRole('button', { name: 'Actions for Synthetic tab 0', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Organize', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await page.getByRole('menuitem', { name: 'Edit tags and note', exact: true }).click();
      await page.getByRole('combobox', { name: 'Tags', exact: true }).fill('research');
      await page.screenshot({ path: 'artifacts/ui-tag-picker-open.png', animations: 'disabled' });
      await page.getByRole('option', { name: 'research', exact: true }).click();
      await page.getByRole('combobox', { name: 'Tags', exact: true }).fill('reading-later');
      await page.getByRole('option', { name: /Create/ }).click();
      await page.screenshot({ path: 'artifacts/ui-tag-picker.png', animations: 'disabled' });
      await page.keyboard.press('Escape');
      await page.screenshot({ path: 'artifacts/ui-merged-tag-editor.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      const retainedTags = await page.evaluate(
        async () =>
          (await window.chrome.runtime.sendMessage({ type: 'state' })).value.records.find(
            (record) => record.id === 'large-0',
          ).tags,
      );
      assert.deepEqual(
        retainedTags,
        [
          ...Array.from({ length: 24 }, (_, index) => `merged-${index}`),
          'research',
          'reading-later',
        ],
        'Editing a merged tab must preserve all existing tags beyond twenty',
      );
      await editable.getByRole('button', { name: /^Synthetic tab 0/ }).hover();
      await page
        .getByRole('button', { name: 'Filter tabs tagged research', exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: 'Filter tabs tagged reading-later', exact: true })
        .waitFor();
      await page.keyboard.press('Escape');
      await editable
        .getByRole('button', { name: 'Actions for Synthetic tab 0', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Organize', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Assign project or category', exact: true }).click();
      await page.getByRole('button', { name: 'Project', exact: true }).click();
      await page.getByPlaceholder('Search options…', { exact: true }).fill('Fresh project');
      await page.getByRole('option', { name: /Create/ }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Category', exact: true }).click();
      await page.getByPlaceholder('Search options…', { exact: true }).fill('Fresh references');
      await page.getByRole('option', { name: /Create/ }).click();
      await page.screenshot({ path: 'artifacts/ui-create-category.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Assign tab', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Search tabs' }).fill('');
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await page.getByRole('button', { name: /^Fresh project/ }).click();
      await page.getByRole('button', { name: /^Fresh references/ }).waitFor();
    }
    if (label === 'desktop' && process.env.TABFLOW_PERF !== '1') {
      await page.evaluate(() => window.sessionStorage.setItem('testCollectionAnalysis', 'true'));
      await page.goto(`${base}/dashboard.html#projects`);
      await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page.evaluate(
        async () =>
          new Promise((resolve, reject) => {
            const open = window.indexedDB.open('tabloom');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction('collectionAnalyses', 'readwrite');
              tx.objectStore('collectionAnalyses').put(window.__collectionAnalysisFixture());
              tx.oncomplete = () => {
                open.result.close();
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
          }),
      );
      await page.reload();
      const actions = page.getByRole('group', { name: 'Collection analysis actions', exact: true });
      await actions.getByRole('button', { name: 'Repair analysis', exact: true }).click();
      await page
        .getByRole('menuitem', { name: 'Recheck projects and categories', exact: false })
        .waitFor();
      await page.getByRole('menuitem', { name: 'Repair tags only', exact: false }).waitFor();
      await page.getByRole('menuitem', { name: 'Start new analysis', exact: false }).waitFor();
      await page
        .getByRole('menuitem', { name: 'Rebuild project structure', exact: false })
        .waitFor();
      await page.keyboard.press('Escape');
      await actions.getByRole('button', { name: 'Resume analysis', exact: true }).waitFor();
      for (const testWidth of [1440, 1100, 720, 420]) {
        await page.setViewportSize({ width: testWidth, height: 900 });
        const heading = page.getByRole('heading', {
          name: 'Understand the whole collection',
          exact: true,
        });
        await heading.scrollIntoViewIfNeeded();
        const measured = await heading.evaluate((element) => {
          const section = element.closest('section');
          const description = element.nextElementSibling;
          const actions = section.querySelector('[aria-label="Collection analysis actions"]');
          const title = element.getBoundingClientRect(),
            bounds = section.getBoundingClientRect(),
            details = description.getBoundingClientRect(),
            toolbar = actions.getBoundingClientRect();
          return {
            titleWidth: title.width,
            titleHeight: title.height,
            sectionWidth: bounds.width,
            actionsBelow: toolbar.top >= details.bottom,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            controlsInside: [...actions.querySelectorAll('button')].every((button) => {
              const rect = button.getBoundingClientRect();
              return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
            }),
          };
        });
        assert(
          measured.titleWidth >= Math.min(300, measured.sectionWidth * 0.9),
          `${testWidth}: heading must retain readable width`,
        );
        assert(
          measured.titleHeight <= 44,
          `${testWidth}: heading must not collapse into a word column`,
        );
        assert(measured.actionsBelow, `${testWidth}: actions must follow description`);
        assert(measured.controlsInside, `${testWidth}: action controls must wrap within section`);
        assert.equal(
          measured.overflow,
          false,
          `${testWidth}: no page overflow with every saved-analysis control`,
        );
        await page.screenshot({
          path: `artifacts/ui-collection-saved-analysis-${testWidth}.png`,
          animations: 'disabled',
        });
      }
      const originalAnalysis = await page.evaluate(() => window.__collectionAnalysisFixture());
      await actions.getByRole('button', { name: 'Repair analysis', exact: true }).click();
      await page.screenshot({
        path: 'artifacts/ui-collection-repair-menu-420.png',
        animations: 'disabled',
      });
      await page.getByRole('menuitem', { name: 'Rebuild project structure', exact: false }).click();
      await page.waitForURL('**#assistant');
      await page
        .getByText(
          'Saved analysis is ready to resume. Completed compatible batches are retained.',
          { exact: true },
        )
        .waitFor();
      await page.getByRole('button', { name: 'Resume analysis', exact: true }).waitFor();
      const preserved = await page.evaluate(
        async (id) =>
          new Promise((resolve, reject) => {
            const open = window.indexedDB.open('tabloom');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction('collectionAnalyses', 'readonly');
              const get = tx.objectStore('collectionAnalyses').get(id);
              get.onsuccess = () => resolve(get.result);
              get.onerror = () => reject(get.error);
              tx.oncomplete = () => open.result.close();
            };
          }),
        originalAnalysis.id,
      );
      assert.deepEqual(
        preserved,
        originalAnalysis,
        'Opening project repair in chat must retain original checkpoint',
      );
      await page.screenshot({
        path: 'artifacts/ui-project-repair-linked-chat.png',
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Approvals', exact: true }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Approve for me', exact: true }).click();
      const approvalsBeforeResume = await page.evaluate(() => window.__approvalRequests.length);
      await page.evaluate(() => window.__completedCollectionAnalysisFixture());
      await page.setViewportSize({ width: 1440, height: 1000 });
      const completionsBefore = completionRequests.length;
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Projects', exact: true })
        .click();
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page
        .getByRole('group', { name: 'Collection analysis actions', exact: true })
        .getByRole('button', { name: 'Resume analysis', exact: true })
        .click();
      await page.waitForURL('**#assistant');
      await page
        .getByText(/Analysis resumed and saved as proposal imported-/)
        .first()
        .waitFor();
      assert.equal(
        completionRequests.length,
        completionsBefore,
        'A fully committed checkpoint must resume through chat without repeating model work',
      );
      const beforeFollowUp = completionRequests.length;
      await page
        .getByRole('textbox', { name: 'Message to workspace assistant', exact: true })
        .fill('Describe this saved draft without changing it.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page
        .getByText('Recovered the saved synthetic request.', { exact: true })
        .last()
        .waitFor();
      const followUpRoute = completionRequests
        .slice(beforeFollowUp)
        .find((request) => request.response_format?.json_schema?.name === 'proposal_workflow');
      assert(
        followUpRoute,
        'A real follow-up send must retain its active proposal instead of requiring model rediscovery',
      );
      const followUpTarget = JSON.parse(followUpRoute.messages.at(-1).content).activeProposal.id;
      assert(
        (await page.evaluate(() => window.__proposalStatuses())).some(
          (proposal) => proposal.id === followUpTarget,
        ),
      );
      const approval = page.getByRole('group', {
        name: 'Approval: Apply organization',
        exact: true,
      });
      await approval.getByRole('button', { name: 'Apply organization', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => window.__approvalRequests.length),
        approvalsBeforeResume,
        'Preparing a saved draft must not request application approval, even in delegated approval mode',
      );
      await approval
        .getByText(
          'Saves project/category assignments and proposed tags on existing tabs; browser placement stays unchanged.',
          {
            exact: true,
          },
        )
        .waitFor();
      const approvalBaseline = await page.evaluate(() => ({
        requests: window.__approvalRequests.length,
        proposals: window.__proposalStatuses(),
      }));
      await page.getByRole('button', { name: 'Hide saved chats', exact: true }).first().click();
      for (const width of [1440, 420]) {
        await page.setViewportSize({ width, height: 1000 });
        await approval.scrollIntoViewIfNeeded();
        assert.equal(
          await approval.evaluate((element) => element.scrollWidth > element.clientWidth),
          false,
        );
        await page.screenshot({
          path: `artifacts/ui-organization-approval-${width}.png`,
          animations: 'disabled',
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page
        .getByRole('button', { name: 'Review organization in Projects', exact: true })
        .click();
      await page.waitForURL('**#projects');
      assert.equal(
        await page.evaluate(() => window.__approvalRequests.length),
        approvalBaseline.requests,
        'Reviewing a saved proposal must never execute an action',
      );
      assert.deepEqual(
        await page.evaluate(() => window.__proposalStatuses()),
        approvalBaseline.proposals,
      );
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Assistant', exact: true })
        .click();
      await approval.getByRole('button', { name: 'Apply organization', exact: true }).waitFor();
      await approval.getByRole('button', { name: 'Keep draft', exact: true }).click();
      await page
        .getByText('Organization not applied. Saved draft kept in Projects.', { exact: true })
        .waitFor();
      const afterDecline = await page.evaluate(() => ({
        requests: window.__approvalRequests,
        proposals: window.__proposalStatuses(),
      }));
      assert.deepEqual(
        afterDecline.proposals,
        approvalBaseline.proposals,
        'Keep draft must preserve the saved pending proposal',
      );
      assert.deepEqual(
        afterDecline.requests.slice(approvalBaseline.requests).map(({ type }) => type),
        ['denyAssistantAction'],
        'Keep draft must record denial without applying or dismissing the saved draft',
      );
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Projects', exact: true })
        .click();
      await page.getByRole('tab', { name: 'All drafts', exact: true }).click();
      await page.getByText('1 of 9 eligible tabs covered', { exact: true }).waitFor();
      await page.getByText('From chat', { exact: true }).waitFor();
      await page.screenshot({
        path: 'artifacts/ui-project-repair-shared-result.png',
        animations: 'disabled',
      });
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    process.env.TABFLOW_UI_FOCUS === 'docs'
      ? 'Documentation capture passed: realistic fictional workspace, current UI, seven views, no remote page/model calls, zero renderer errors.'
      : process.env.TABFLOW_UI_FOCUS === 'attachment-picker'
        ? 'Attachment picker UI passed: compact bounds, padded search, hidden native scrollbar, edge masks and context search/selection.'
        : process.env.TABFLOW_UI_FOCUS === 'scroll-fade'
          ? 'Scroll fade UI passed: no overflow, vertical/horizontal start-middle-end, content growth and resize removal, zero renderer errors.'
          : process.env.TABFLOW_UI_FOCUS === 'ordering'
            ? 'Ordering UI passed: immediate category drag in main/sidebar, vertical and horizontal project order after reload, distributed compact footer.'
            : process.env.TABFLOW_UI_FOCUS === 'compact-ui'
              ? 'Compact UI passed: full-width sort, aligned select options, autosave/retry, narrow list/detail settings, compact confirmation/review/footer and one attachment menu.'
              : process.env.TABFLOW_UI_FOCUS === 'drag'
                ? 'Drag UI passed: whole-row pointer nesting, subtree sibling reorder, root detach, hover dismissal and click/drag separation.'
                : process.env.TABFLOW_UI_FOCUS === 'layout'
                  ? 'Layout UI passed: native placement status/fallback, old preferences ignored, settings/chat draft preservation, narrow side-panel and dashboard themes.'
                  : process.env.TABFLOW_UI_FOCUS === 'trees'
                    ? 'Tab tree UI passed: five levels, collapse/expand, filtered children, light/dark compact layouts and zero renderer errors.'
                    : process.env.TABFLOW_UI_FOCUS === 'refresh'
                      ? 'Refresh UI passed: three delayed background polls preserve enabled controls, search state and row identity.'
                      : process.env.TABFLOW_UI_FOCUS === 'maintenance'
                        ? 'Maintenance UI passed: category/project dragging, category and tag maintenance, older paginated Undo/Redo, compact light/dark layouts and zero renderer errors.'
                        : process.env.TABFLOW_PERF === '1'
                          ? 'Stress UI passed: 510 tabs, 500 snapshots, 500 operations, route timings and zero renderer errors.'
                          : 'UI smoke passed: desktop, compact, mobile, search, centered dialog, settings, history, review, mobile assistant, and zero renderer errors.',
  );
} finally {
  await browser.close();
  server.close();
}
