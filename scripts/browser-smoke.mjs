// Run with a full Chromium build supporting extensions, not chromium-headless-shell.
import { chromium } from '@playwright/test';
import path from 'node:path';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
async function waitUntil(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const chromiumPath = process.env.TABFLOW_CHROMIUM_PATH || process.env.TABLOOM_CHROMIUM_PATH;

const temporary = await mkdtemp(path.join(tmpdir(), 'tabloom-e2e-'));
const resolvedTemporary = path.resolve(temporary);
if (
  !resolvedTemporary.startsWith(path.resolve(tmpdir()) + path.sep) ||
  !path.basename(resolvedTemporary).startsWith('tabloom-e2e-')
)
  throw new Error('Refusing cleanup outside the isolated test directory.');
const extension = path.join(temporary, 'extension');
const legacyExtension = path.join(temporary, 'legacy-suspender');
await mkdir(legacyExtension);
await writeFile(
  path.join(legacyExtension, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'Legacy Suspender test fixture',
    version: '1.0.0',
    background: { service_worker: 'legacy-worker.js' },
    web_accessible_resources: [{ resources: ['suspended.html'], extension_ids: ['*'] }],
  }),
);
await writeFile(
  path.join(legacyExtension, 'legacy-worker.js'),
  'chrome.runtime.onInstalled.addListener(() => {});',
);
await writeFile(
  path.join(legacyExtension, 'suspended.html'),
  '<!doctype html><title>Legacy sleeping page</title><p>Migration fixture; original site is not loaded.</p>',
);
await cp(path.resolve(process.env.TABLOOM_EXTENSION_ROOT || '.output/chrome-mv3'), extension, {
  recursive: true,
});
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const devServer = process.env.TABLOOM_DEV_SERVER_URL;
if (devServer)
  manifest.content_security_policy.extension_pages =
    manifest.content_security_policy.extension_pages.replace(
      'ws://localhost:3000',
      devServer.replace(/^http/, 'ws'),
    );
// Isolated test-only grant exercises the real screenshot API; production requests this optionally.
manifest.host_permissions = ['<all_urls>'];
manifest.permissions.push('sessions');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
let originalRequests = 0;
let pendingWakeRequests = 0,
  maxPendingWakeRequests = 0,
  totalWakeRequests = 0;
const server = createServer((req, res) => {
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body);
      assert.equal(request.tools, undefined);
      assert.equal(request.response_format.json_schema.name, 'action_permission_review');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'native-permission-response',
          object: 'chat.completion',
          created: 1,
          model: 'synthetic-reviewer',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  decision: 'allow',
                  reason:
                    'The user explicitly requested the source label and annotation on this selected reference.',
                }),
              },
            },
          ],
        }),
      );
    });
    return;
  }
  if (req.url?.startsWith('/slow-wake/')) {
    totalWakeRequests++;
    pendingWakeRequests++;
    maxPendingWakeRequests = Math.max(maxPendingWakeRequests, pendingWakeRequests);
    res.setHeader('Content-Type', 'text/html');
    setTimeout(() => {
      pendingWakeRequests--;
      res.end('<title>Slow synthetic page</title><p>Loaded</p>');
    }, 1000);
    return;
  }
  if (/^\/(one|two)(?:\?|$)/.test(req.url)) originalRequests++;
  if (req.url === '/favicon.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#d0289e"/></svg>',
    );
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<title>TabFlow test page</title><link rel="icon" href="/favicon.svg"><main><h1>Project documentation</h1><p>Useful cached content.</p></main><input aria-label="Draft" value=""><select aria-label="Priority"><option>Normal</option><option>High</option></select>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
const runtimeErrors = new Set();
const headless = process.env.TABLOOM_HEADLESS !== 'false';
function recordRuntimeError(error) {
  if (!runtimeErrors.has(error.message)) console.error('Extension runtime error:', error.message);
  runtimeErrors.add(error.message);
}
try {
  console.log('Native smoke: launching isolated Chromium');
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    channel: chromiumPath ? undefined : 'chromium',
    executablePath: chromiumPath || undefined,
    headless,
    args: [
      '--no-sandbox',
      ...(!headless ? ['--window-position=-32000,-32000'] : []),
      `--disable-extensions-except=${extension},${legacyExtension}`,
      `--load-extension=${extension},${legacyExtension}`,
    ],
  });
  console.log(`Native smoke: browser ${context.browser()?.version()}`);
  if (process.env.TABLOOM_EXTENSION_ROOT?.endsWith('-dev'))
    await context.route(`${devServer || 'http://localhost:3000'}/**`, async (route) => {
      // The isolated extension ID is outside the running WXT server's origin allowlist.
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'access-control-allow-origin': '*' },
      });
    });
  const worker =
    context.serviceWorkers().find((worker) => !worker.url().endsWith('/legacy-worker.js')) ||
    (await context.waitForEvent('serviceworker', {
      predicate: (worker) => !worker.url().endsWith('/legacy-worker.js'),
      timeout: 15000,
    }));
  const extensionId = new URL(worker.url()).host;
  const legacyWorker =
    context.serviceWorkers().find((worker) => worker.url().endsWith('/legacy-worker.js')) ||
    (await context.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().endsWith('/legacy-worker.js'),
      timeout: 15000,
    }));
  const legacyId = new URL(legacyWorker.url()).host;
  await mkdir('artifacts', { recursive: true });
  console.log('Native smoke: extension service worker ready');
  const page = await context.newPage();
  await page.goto(`${base}/one`);
  const other = await context.newPage();
  await other.goto(`${base}/two`);
  let dashboard = await context.newPage();
  dashboard.on('pageerror', recordRuntimeError);
  dashboard.on('console', (message) => {
    if (message.type() === 'error') console.error('Dashboard console:', message.text());
    if (/Unhandled error|Maximum recursive|Injection.*not found/.test(message.text()))
      recordRuntimeError(new Error(message.text()));
  });
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html#tabs`);
  await dashboard
    .getByRole('heading', { name: 'Windows & tabs', exact: true })
    .waitFor()
    .catch(async (error) => {
      console.error(
        'Dashboard body:',
        (await dashboard.locator('body').innerText()).slice(0, 1200),
      );
      throw error;
    });
  const call = (type, payload) => {
    console.log(`Native smoke: ${type}`);
    return dashboard.evaluate(
      async ({ type, payload }) => {
        let deadline;
        const timeout = new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error(`Background ${type} timed out`)), 20000);
        });
        const result = await Promise.race([chrome.runtime.sendMessage({ type, payload }), timeout]);
        window.clearTimeout(deadline);
        if (!result.ok) throw new Error(result.error);
        return result.value;
      },
      { type, payload },
    );
  };
  await dashboard.waitForFunction(() => {
    const mark = document.querySelector('img[src="/icons/mark.svg"]');
    return mark?.complete && mark.naturalWidth > 0;
  });
  await dashboard
    .getByRole('searchbox', { name: 'Search tabs', exact: true })
    .locator('..')
    .locator('svg')
    .first()
    .waitFor();
  const state = await call('state');
  const record = state.records.find((r) => r.url === `${base}/one`);
  assert(record);
  const metadataDraft = {
    kind: 'workspace_edits',
    summary: 'Synthetic reviewed source label and note',
    edits: [
      {
        edit: { kind: 'tags', recordId: record.id, mode: 'add', tags: ['source'] },
        before: JSON.stringify({
          url: record.url,
          navigationVersion: record.navigationVersion,
          value: record.tags,
        }),
      },
      {
        edit: { kind: 'note', recordId: record.id, note: 'Synthetic reference note' },
        before: JSON.stringify({
          url: record.url,
          navigationVersion: record.navigationVersion,
          value: record.note,
        }),
      },
    ],
  };
  const approvedRequest = {
    threadId: 'synthetic-chat',
    messageId: 'synthetic-message',
    mode: 'once',
    artifact: { kind: 'command', command: metadataDraft },
  };
  await assert.rejects(
    () => call('executeAssistantAction', { ...approvedRequest, mode: 'automatic' }),
    /Approval is required/,
  );
  const metadataTrace = await call('executeAssistantAction', approvedRequest);
  assert.equal((await call('executeAssistantAction', approvedRequest)).id, metadataTrace.id);
  const edited = (await call('state')).records.find((item) => item.id === record.id);
  assert(edited.tags.includes('source'));
  assert.equal(edited.note, 'Synthetic reference note');
  await assert.rejects(() => call('applyWorkspaceEdits', metadataDraft), /stale/);
  const undoMetadata = await call('undoAssistantChange', { id: metadataTrace.id });
  assert.equal(undoMetadata.status, 'undone');
  const redoMetadata = await call('redoAssistantChange', { id: metadataTrace.id });
  assert.equal(redoMetadata.status, 'complete');
  assert.equal(
    (await call('state')).records.find((item) => item.id === record.id).note,
    'Synthetic reference note',
  );
  await call('undoAssistantChange', { id: metadataTrace.id });
  await call('settings', {
    ...state.settings,
    aiModel: 'synthetic-reviewer',
    aiBase: `${base}/v1`,
    aiContextTokens: 32768,
    aiCompletionTokens: 1024,
  });
  await dashboard.evaluate(
    async ({ record, artifact }) => {
      const thread = {
        id: 'native-permission-chat',
        title: 'Synthetic permission review',
        createdAt: 1,
        updatedAt: 1,
        projectId: null,
        status: 'ready',
        messages: [
          {
            id: 'native-permission-user',
            role: 'user',
            content: 'Apply the source label and annotation to this selected reference.',
            createdAt: 1,
            request: {
              task: 'work',
              recordIds: [record.id],
              selectedRecordIds: [record.id],
              projectId: null,
              restrictToScope: true,
              allowCrossWindowMove: false,
              allowSleepWake: false,
            },
          },
          {
            id: 'native-permission-answer',
            role: 'assistant',
            content: 'Prepared exact metadata edits.',
            createdAt: 2,
            deliveryStatus: 'complete',
            requestMessageId: 'native-permission-user',
            commandDraft: artifact.command,
          },
        ],
      };
      await new Promise((resolve, reject) => {
        const open = window.indexedDB.open('tabloom');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('assistantThreads', 'readwrite');
          tx.objectStore('assistantThreads').put(thread);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { record, artifact: { kind: 'command', command: metadataDraft } },
  );
  const permissionInput = {
    threadId: 'native-permission-chat',
    messageId: 'native-permission-answer',
    artifact: { kind: 'command', command: metadataDraft },
    oneOff: false,
  };
  await call('setPermissionPolicy', { threadId: permissionInput.threadId, mode: 'review' });
  const preparedPermission = await call('preparePermissionReview', permissionInput);
  const allowedPermission = await call('resolvePermissionReview', { id: preparedPermission.id });
  assert.equal(allowedPermission.decision, 'allow');
  const reviewedAction = await call('executeAssistantAction', {
    ...permissionInput,
    mode: 'reviewed',
    permissionReviewId: preparedPermission.id,
  });
  assert.equal(reviewedAction.permissionReview.id, preparedPermission.id);
  assert.equal(
    (
      await call('executeAssistantAction', {
        ...permissionInput,
        mode: 'reviewed',
        permissionReviewId: preparedPermission.id,
      })
    ).id,
    reviewedAction.id,
  );
  await call('undoAssistantChange', { id: reviewedAction.id });
  const allPolicy = await call('setPermissionPolicy', {
    threadId: permissionInput.threadId,
    mode: 'all',
  });
  const automaticAction = await call('executeAssistantAction', {
    ...permissionInput,
    mode: 'automatic',
    permissionPolicyRevision: allPolicy.revision,
  });
  assert.equal(automaticAction.status, 'complete');
  assert.equal(automaticAction.mode, 'automatic');
  await call('undoAssistantChange', { id: automaticAction.id });
  await call('setPermissionPolicy', { threadId: permissionInput.threadId, mode: 'ask' });
  console.log(
    'Native delegated permission review passed: tool-free model request, exact receipt, single execution and Undo',
  );
  const mergeTarget = await call('proposeCollection', {
    name: 'Main fixture',
    summary: 'Preserve this draft',
    scopeRecordIds: [record.id],
    projects: [],
    assignments: [],
    unresolvedRecordIds: [record.id],
    unresolvedTagSuggestions: [
      {
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        suggestedTags: Array.from({ length: 12 }, (_, i) => `reading-${i}`),
      },
    ],
  });
  const mergeSource = await call('proposeCollection', {
    name: 'Extra fixture',
    summary: 'Additional reference',
    scopeRecordIds: [record.id],
    projects: [
      {
        name: 'Course reference',
        purpose: 'Reading lessons',
        areaName: 'Learning',
        categories: [{ name: 'Lessons', description: 'Course lessons' }],
      },
    ],
    assignments: [
      {
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        projectName: 'Course reference',
        categoryName: 'Lessons',
        confidence: 0.9,
        reason: 'Synthetic evidence',
        suggestedTags: Array.from({ length: 12 }, (_, i) => `reference-${i}`),
      },
    ],
    unresolvedRecordIds: [],
  });
  const proposalHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const oldTargetHash = proposalHash(mergeTarget);
  const mergedDraft = await call('mergeCollectionProposals', {
    targetProposalId: mergeTarget.id,
    sourceProposalId: mergeSource.id,
    targetFingerprint: oldTargetHash,
    sourceFingerprint: proposalHash(mergeSource),
    projectNames: [],
    assignmentConflict: 'keep_target',
  });
  assert.equal(mergedDraft.proposal.assignments.length, 1);
  assert.equal(mergedDraft.proposal.unresolvedRecordIds.length, 0);
  assert.equal(mergedDraft.proposal.name, mergeTarget.name);
  assert.deepEqual(mergedDraft.proposal.assignments[0].suggestedTags, [
    ...mergeTarget.unresolvedTagSuggestions[0].suggestedTags,
    ...mergeSource.assignments[0].suggestedTags,
  ]);
  assert.deepEqual(await call('getCollectionProposal', { id: mergeSource.id }), mergeSource);
  const metadataBeforeTagDraft = (await call('state')).records.find(
    (item) => item.id === record.id,
  ).tags;
  const tagDraft = await call('updateCollectionTags', {
    id: mergeTarget.id,
    expectedFingerprint: proposalHash(mergedDraft.proposal),
    patches: [
      {
        recordId: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        suggestedTags: [...mergedDraft.proposal.assignments[0].suggestedTags, 'reference-guide'],
        review: [],
      },
    ],
  });
  assert.equal(tagDraft.status, 'pending');
  assert.equal(tagDraft.assignments[0].suggestedTags.length, 25);
  assert.deepEqual(tagDraft.projects, mergedDraft.proposal.projects);
  assert.deepEqual(
    (await call('state')).records.find((item) => item.id === record.id).tags,
    metadataBeforeTagDraft,
  );
  await assert.rejects(
    call('updateCollectionTags', {
      id: mergeTarget.id,
      expectedFingerprint: proposalHash(mergedDraft.proposal),
      patches: [],
    }),
    /proposal changed/,
  );
  await assert.rejects(
    call('updateCollectionDraft', {
      id: mergeTarget.id,
      draft: { ...mergedDraft.proposal, name: 'Stale override' },
      expectedFingerprint: oldTargetHash,
    }),
    /changed in another chat/,
  );
  assert.equal(
    (await call('getCollectionProposal', { id: mergeTarget.id })).name,
    mergeTarget.name,
  );
  await call('dismissCollection', { id: mergeTarget.id });
  await call('dismissCollection', { id: mergeSource.id });
  console.log(
    'Native proposal merge passed: exact target, source preserved, no Apply, stale cross-chat write rejected',
  );
  const newTabOperation = await call('tabCommand', {
    id: record.id,
    command: 'new',
    expected: { url: record.url, navigationVersion: record.navigationVersion },
  });
  assert.equal(newTabOperation.status, 'complete');
  assert.equal(newTabOperation.tabCommand.created.index, record.index + 1);
  assert((await call('undo', { id: newTabOperation.id })).every((item) => item.ok));
  const reloadOperation = await call('tabCommand', {
    id: record.id,
    command: 'reload',
    expected: { url: record.url, navigationVersion: record.navigationVersion },
  });
  assert.equal(reloadOperation.status, 'complete');
  await page.waitForLoadState('load');
  const duplicateOperation = await call('tabCommand', {
    id: record.id,
    command: 'duplicate',
    expected: { url: record.url, navigationVersion: record.navigationVersion },
  });
  assert.equal(duplicateOperation.status, 'complete');
  await dashboard.waitForTimeout(500);
  const duplicateId = duplicateOperation.tabCommand.created.recordId;
  assert.notEqual(duplicateId, record.id);
  assert((await call('state')).records.some((item) => item.id === duplicateId && item.live));
  assert((await call('undo', { id: duplicateOperation.id })).every((item) => item.ok));
  const redoneDuplicate = await call('redo', { id: duplicateOperation.id });
  assert.equal(redoneDuplicate.status, 'complete');
  await dashboard.waitForTimeout(500);
  assert((await call('undo', { id: redoneDuplicate.id })).every((item) => item.ok));
  const closeSourceOperation = await call('tabCommand', {
    id: record.id,
    command: 'duplicate',
    expected: { url: record.url, navigationVersion: record.navigationVersion },
  });
  await dashboard.waitForTimeout(500);
  const closeSource = (await call('state')).records.find(
    (item) => item.id === closeSourceOperation.tabCommand.created.recordId,
  );
  await call('record', {
    id: closeSource.id,
    patch: { tags: ['retain-on-close'], note: 'Retain the closed reference annotation' },
  });
  const closeOperation = await call('tabCommand', {
    id: closeSource.id,
    command: 'close',
    expected: { url: closeSource.url, navigationVersion: closeSource.navigationVersion },
  });
  assert.equal(closeOperation.status, 'complete');
  assert((await call('undo', { id: closeOperation.id })).every((item) => item.ok));
  const restoredClose = (await call('state')).records.find((item) => item.id === closeSource.id);
  assert(restoredClose.live && restoredClose.suspended);
  assert.deepEqual(restoredClose.tags, ['retain-on-close']);
  assert.equal(restoredClose.note, 'Retain the closed reference annotation');
  const redoneClose = await call('redo', { id: closeOperation.id });
  assert.equal(redoneClose.status, 'complete');
  console.log(
    'Native menu commands: independent duplicate, guarded Undo/Redo, explicit close and sleeping restoration passed',
  );
  await call('record', { id: record.id, patch: { tags: record.tags, note: record.note } });
  const wakeTabIds = await dashboard.evaluate(async (base) => {
    const ids = [];
    for (let index = 0; index < 3; index++) {
      const fragment = new URLSearchParams({
        id: window.crypto.randomUUID(),
        url: `${base}/slow-wake/${index}`,
        title: `Synthetic slow page ${index}`,
      });
      const tab = await chrome.tabs.create({
        active: false,
        url: chrome.runtime.getURL(`suspended.html#${fragment}`),
      });
      ids.push(tab.id);
    }
    return ids;
  }, base);
  await waitUntil(
    () =>
      dashboard.evaluate(
        async (ids) =>
          (await Promise.all(ids.map((id) => chrome.tabs.get(id)))).every(
            (tab) => tab.url?.includes('suspended.html#') && tab.status === 'complete',
          ),
        wakeTabIds,
      ),
    'three sleeping wake fixtures are loaded',
  );
  const wakeState = await call('state');
  assert.equal(wakeState.records.filter((entry) => wakeTabIds.includes(entry.tabId)).length, 3);
  const waking = await call('apply', {
    summary: 'Synthetic bounded wake',
    actions: [
      {
        type: 'wake',
        recordIds: wakeState.records
          .filter((entry) => wakeTabIds.includes(entry.tabId))
          .map((entry) => entry.id),
      },
    ],
  });
  assert.equal(waking.status, 'running');
  await dashboard.getByRole('region', { name: 'Browser work progress', exact: true }).waitFor();
  await dashboard.screenshot({ path: 'artifacts/native-wake-progress.png' });
  const readStarted = Date.now();
  await call('state');
  assert(Date.now() - readStarted < 2000, 'State reads remain responsive during wake loading');
  await waitUntil(() => totalWakeRequests === 1, 'first wake request starts');
  await call('controlWakeOperation', { id: waking.id, resume: false });
  await waitUntil(() => pendingWakeRequests === 0, 'the in-flight page finishes while paused');
  assert.equal(totalWakeRequests, 1, 'Pause leaves the rest of the queue asleep');
  assert.equal((await call('operationDetails', { id: waking.id })).status, 'interrupted');
  await call('controlWakeOperation', { id: waking.id, resume: true });
  await waitUntil(async () => {
    const operation = await call('operationDetails', { id: waking.id });
    assert.notEqual(operation.status, 'interrupted', operation.pauseReason);
    return operation.status === 'complete';
  }, 'wake queue completes actual navigation');
  assert.equal(totalWakeRequests, 3);
  assert.equal(maxPendingWakeRequests, 1, 'Only one synthetic original can load at a time');
  await dashboard.evaluate((ids) => chrome.tabs.remove(ids), wakeTabIds);
  await call('state');
  await call('saveCollectionAnalysis', {
    id: 'native-checkpoint',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    purpose: 'proposal',
    instruction: 'Synthetic browser resume',
    reuseAcceptedTaxonomyOnly: false,
    scope: [{ id: record.id, url: record.url, navigationVersion: record.navigationVersion }],
    discoveredIds: [],
    classifiedIds: [],
    projects: [],
    summaries: [],
    assignments: [],
    unresolvedRecordIds: [],
    failedBatch: {
      stage: 'discovery',
      recordIds: [record.id],
      attempts: 3,
      error: 'Synthetic output limit',
      failedAt: Date.now(),
    },
  });
  const repairedCheckpoint = await call('repairCollectionAnalysis', {
    id: 'native-checkpoint',
    stage: 'classification',
  });
  assert.notEqual(repairedCheckpoint.id, 'native-checkpoint');
  assert.equal(repairedCheckpoint.sourceAnalysisId, 'native-checkpoint');
  assert.equal((await call('getCollectionAnalysis', { id: 'native-checkpoint' })).revision, 1);
  const tagRecord = (await call('state')).records.find((item) => item.id === record.id);
  await call('saveCollectionAnalysis', {
    id: 'native-tags',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    purpose: 'proposal',
    instruction: '',
    reuseAcceptedTaxonomyOnly: true,
    decisionContract: 'isolated-evidence-v2',
    scope: [
      { id: tagRecord.id, url: tagRecord.url, navigationVersion: tagRecord.navigationVersion },
    ],
    discoveredIds: [tagRecord.id],
    classifiedIds: [tagRecord.id],
    projects: [],
    summaries: [],
    assignments: [],
    unresolvedRecordIds: [tagRecord.id],
    tagVocabulary: [],
  });
  const cached = tagRecord.content?.url === tagRecord.url ? tagRecord.content : undefined;
  const evidence = {
    title: tagRecord.title.slice(0, 500),
    url: tagRecord.url.slice(0, 2000),
    note: tagRecord.note.slice(0, 500),
    text: cached
      ? [cached.description, ...cached.headings, cached.text].join('\n').slice(0, 10000)
      : '',
    existingTags: tagRecord.tags,
    navigationVersion: tagRecord.navigationVersion,
  };
  const evidenceKey = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const catalogKey = createHash('sha256').update('[]').digest('hex');
  await call('saveTagAnalysis', {
    id: JSON.stringify(['native-tags', tagRecord.id, evidenceKey, catalogKey]),
    analysisId: 'native-tags',
    recordId: tagRecord.id,
    url: tagRecord.url,
    navigationVersion: tagRecord.navigationVersion,
    evidenceKey,
    catalogKey,
    contract: 'bounded-tags-v1',
    revision: 1,
    updatedAt: 1,
    cursor: 0,
    status: 'complete',
    proposalModel: 'synthetic',
    tags: [],
    newTags: [],
    uncertain: false,
    decisions: [],
  });
  await call('saveInferenceReceipt', {
    id: 'native-receipt',
    analysisId: repairedCheckpoint.id,
    contract: 'isolated-evidence-v2',
    stage: 'classification',
    model: 'synthetic',
    startedAt: 1,
    finishedAt: 2,
    outcome: 'responded',
    request: '{"synthetic":true}',
    response: '{"answers":{}}',
  });
  await call('saveActionAnalysis', {
    id: 'native-action-checkpoint',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    status: 'pending',
    instruction: 'Synthetic action resume',
    mode: 'generative',
    readOnly: false,
    allowCrossWindowMove: false,
    allowSleepWake: false,
    scope: [
      {
        id: record.id,
        url: record.url,
        navigationVersion: record.navigationVersion,
        windowId: record.windowId,
        groupId: record.groupId,
      },
    ],
    completedIds: [],
    actions: [],
    matchIds: [],
    summaries: [],
    failedBatch: {
      recordIds: [record.id],
      attempts: 3,
      error: 'Synthetic failed batch',
      failedAt: Date.now(),
    },
  });
  await call('apply', {
    summary: 'Browser test grouping',
    actions: [
      {
        type: 'group',
        recordIds: [record.id],
        windowId: record.windowId,
        name: 'Test project',
        color: 'green',
      },
    ],
  });
  const grouped = await call('state');
  assert(grouped.groups.some((g) => g.title === 'Test project'));
  await call('settings', { ...grouped.settings, capturePreviews: true });
  await page.bringToFront();
  const op = await call('apply', {
    summary: 'Browser test suspension',
    actions: [{ type: 'suspend', recordIds: [record.id] }],
  });
  await page.waitForURL(/suspended.html/);
  await page.waitForFunction(() =>
    document.querySelector('link[rel="icon"]')?.href.startsWith('data:image/png;base64,'),
  );
  await dashboard.waitForFunction(
    async (id) => (await chrome.tabs.get(id)).favIconUrl?.startsWith('data:image/png;base64,'),
    record.tabId,
    { timeout: 10000 },
  );
  const fadedPixel = await page.evaluate(async () => {
    const icon = document.createElement('img');
    icon.src = document.querySelector('link[rel="icon"]').href;
    await icon.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    context.drawImage(icon, 0, 0);
    return [...context.getImageData(16, 16, 1, 1).data];
  });
  assert(
    fadedPixel[0] > fadedPixel[1] + 40 && fadedPixel[2] > fadedPixel[1] + 30,
    `Suspended favicon should retain its original magenta hue: ${fadedPixel}`,
  );
  assert(
    fadedPixel[3] >= 110 && fadedPixel[3] <= 150,
    `Suspended favicon should be translucent: ${fadedPixel}`,
  );
  const suspendedFavicon = await page.locator('link[rel="icon"]').getAttribute('href');
  await writeFile(
    'artifacts/suspended-favicon.png',
    Buffer.from(suspendedFavicon.split(',')[1], 'base64'),
  );
  await page.locator('#preview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#preview')?.naturalWidth > 0);
  await page.screenshot({ path: 'artifacts/suspended-preview.png' });
  await dashboard
    .getByRole('button', { name: 'Switch to light mode', exact: true })
    .first()
    .click();
  await page.waitForFunction(() => document.documentElement.classList.contains('light'));
  await dashboard.waitForFunction(
    () =>
      document.documentElement.classList.contains('light') &&
      !document.documentElement.dataset.themeTransition,
  );
  await page.screenshot({ path: 'artifacts/suspended-preview-light.png' });
  await dashboard.getByRole('button', { name: 'Switch to dark mode', exact: true }).first().click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await dashboard.waitForFunction(() => !document.documentElement.dataset.themeTransition);
  assert.equal(await page.title(), 'TabFlow test page');
  assert.equal((await call('state')).records.find((r) => r.id === record.id).suspended, true);
  const undoSuspension = await call('undo', { id: op.id });
  assert(
    undoSuspension.every((item) => item.ok),
    JSON.stringify(undoSuspension),
  );
  await page.waitForURL(`${base}/one`);
  const backup = await call('export');
  assert.equal(backup.format, 'tabloom');
  assert(!JSON.stringify(backup.snapshots).includes('chrome-extension://'));
  assert(!JSON.stringify(backup).includes('data:image/jpeg'));
  await call('settings', { ...grouped.settings, capturePreviews: false });
  await page.getByLabel('Draft').fill('Unsubmitted owner draft');
  const protectedForm = await call('apply', {
    summary: 'Unsaved-input protection',
    actions: [{ type: 'suspend', recordIds: [record.id] }],
  });
  assert(protectedForm.results[0].outcomes.some((outcome) => outcome.skipped));
  assert.equal(page.url(), `${base}/one`);
  await page.reload();
  await page.getByLabel('Priority').selectOption({ label: 'High' });
  const protectedSelect = await call('apply', {
    summary: 'Select protection',
    actions: [{ type: 'suspend', recordIds: [record.id] }],
  });
  assert(protectedSelect.results[0].outcomes.some((outcome) => outcome.skipped));
  await page.reload();
  const beforeCopy = await call('state');
  const sourceRecords = beforeCopy.records.filter((item) => item.live && item.url.startsWith(base));
  const originals = sourceRecords.map((item) => ({
    id: item.id,
    tabId: item.tabId,
    windowId: item.windowId,
    groupId: item.groupId,
    url: item.url,
    suspended: item.suspended,
  }));
  const proposal = await call('proposeCollection', {
    model: 'browser-fixture',
    summary: 'Reviewed copy arrangement',
    scopeRecordIds: sourceRecords.map((item) => item.id),
    projects: [
      {
        name: 'Browser project',
        purpose: 'Native acceptance fixture',
        areaName: 'Tests',
        categories: [
          { name: 'Documentation', description: 'Page one' },
          { name: 'References', description: 'Page two' },
        ],
      },
    ],
    assignments: sourceRecords.map((item) => ({
      recordId: item.id,
      url: item.url,
      navigationVersion: item.navigationVersion,
      projectName: 'Browser project',
      categoryName: item.url.endsWith('/one') ? 'Documentation' : 'References',
      reason: 'Reviewed test fixture',
      confidence: 1,
    })),
    unresolvedRecordIds: [],
  });
  const copied = await call('organizeCollection', { id: proposal.id });
  assert.equal(copied.operation.status, 'complete', JSON.stringify(copied.proposal.copyState));
  const arranged = await call('state');
  for (const original of originals) {
    const retained = arranged.records.find((item) => item.id === original.id);
    for (const key of ['tabId', 'windowId', 'groupId', 'url', 'suspended'])
      assert.equal(retained[key], original[key]);
  }
  const copies = arranged.records.filter((item) => item.live && item.sourceRecordId);
  assert.equal(copies.length, sourceRecords.length);
  assert(copies.every((item) => item.suspended && item.id !== item.sourceRecordId));
  const projectWindow = copied.proposal.copyState.windows[0].windowId;
  assert.deepEqual(
    arranged.groups
      .filter((item) => item.windowId === projectWindow)
      .map((item) => item.title)
      .sort(),
    ['Documentation', 'References'],
  );
  const randomTab = await worker.evaluate(
    async ({ projectWindow, url }) => {
      const tab = await chrome.tabs.create({ windowId: projectWindow, url, active: false });
      const groups = await chrome.tabGroups.query({ windowId: projectWindow });
      await chrome.tabs.group({ tabIds: [tab.id], groupId: groups[0].id });
      return tab.id;
    },
    { projectWindow, url: `${base}/random-in-project-window` },
  );
  await waitUntil(
    async () => (await call('state')).records.some((record) => record.tabId === randomTab),
    'new tab coordinator reconciliation',
  );
  const randomRecord = (await call('state')).records.find((record) => record.tabId === randomTab);
  assert.equal(
    randomRecord.projectId,
    null,
    'New grouped tabs do not inherit semantic project membership',
  );
  await call('assignMembership', {
    recordIds: [randomRecord.id],
    projectId: null,
    categoryId: null,
  });
  await worker.evaluate(
    async ({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }),
    { tabId: randomTab, windowId: originals[0].windowId },
  );
  const inboxState = await call('state');
  assert.equal(inboxState.records.find((record) => record.id === randomRecord.id).projectId, null);
  assert(
    inboxState.memberships.some(
      (membership) =>
        membership.recordId === randomRecord.id &&
        membership.projectId === null &&
        membership.source === 'owner',
    ),
  );
  const inboxBackup = await call('export');
  assert(
    inboxBackup.memberships.some(
      (membership) => membership.recordId === randomRecord.id && membership.projectId === null,
    ),
  );
  const browserPanel = await context.newPage();
  const nativeFlags = await call('apply', {
    summary: 'Native pin and mute regression',
    actions: [
      { type: 'pin', recordIds: [randomRecord.id], enabled: true },
      { type: 'mute', recordIds: [randomRecord.id], enabled: true },
    ],
    expected: {
      [randomRecord.id]: {
        url: randomRecord.url,
        navigationVersion: randomRecord.navigationVersion,
      },
    },
  });
  assert.equal(nativeFlags.status, 'complete');
  const flaggedTab = await worker.evaluate((id) => chrome.tabs.get(id), randomTab);
  assert.equal(flaggedTab.pinned, true);
  assert.equal(flaggedTab.mutedInfo.muted, true);
  assert.equal(flaggedTab.url, randomRecord.url);
  await call('undo', { id: nativeFlags.id });
  const restoredFlags = await worker.evaluate((id) => chrome.tabs.get(id), randomTab);
  assert.equal(restoredFlags.pinned, false);
  assert.equal(restoredFlags.mutedInfo.muted, false);
  assert.equal(restoredFlags.url, randomRecord.url);
  const groupFixture = await worker.evaluate(async (base) => {
    const source = await chrome.windows.create({ url: `${base}/one`, focused: false });
    const extra = await chrome.tabs.create({
      windowId: source.id,
      url: `${base}/two`,
      active: false,
    });
    const tabIds = [source.tabs[0].id, extra.id];
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: 'Whole group fixture',
      color: 'purple',
      collapsed: true,
    });
    const target = await chrome.windows.create({ url: 'about:blank', focused: false });
    return { groupId, tabIds, targetWindowId: target.id };
  }, base);
  const groupState = await call('state');
  const groupMove = await call('apply', {
    summary: 'Native whole-group regression',
    actions: [
      {
        type: 'moveGroup',
        nativeGroupId: groupFixture.groupId,
        windowId: groupFixture.targetWindowId,
        recordIds: groupState.records
          .filter((record) => groupFixture.tabIds.includes(record.tabId))
          .map((record) => record.id),
      },
    ],
  });
  assert.equal(groupMove.status, 'complete', JSON.stringify(groupMove.results));
  const movedGroup = await worker.evaluate(async (tabIds) => {
    const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
    return { tabs, group: await chrome.tabGroups.get(tabs[0].groupId) };
  }, groupFixture.tabIds);
  assert.equal(movedGroup.group.title, 'Whole group fixture');
  assert.equal(movedGroup.group.color, 'purple');
  assert.equal(movedGroup.group.collapsed, true);
  assert(movedGroup.tabs.every((tab) => tab.windowId === groupFixture.targetWindowId));
  const groupRecords = (await call('state')).records.filter((record) =>
    groupFixture.tabIds.includes(record.tabId),
  );
  await call('apply', {
    summary: 'Sleeping session favicon fixture',
    actions: groupRecords.map((record) => ({ type: 'suspend', recordIds: [record.id] })),
  });
  await call('saveSession');
  const sleepingFixtureUrls = await worker.evaluate(
    async (tabIds) =>
      (await Promise.all(tabIds.map((id) => chrome.tabs.get(id)))).map((tab) => tab.url),
    groupFixture.tabIds,
  );
  await worker.evaluate((id) => chrome.windows.remove(id), groupFixture.targetWindowId);
  await waitUntil(
    () =>
      worker.evaluate(
        async (urls) =>
          (await chrome.sessions.getRecentlyClosed()).some(
            (entry) =>
              Boolean(entry.window?.sessionId) &&
              urls.every((url) => entry.window.tabs?.some((tab) => tab.url === url)),
          ),
        sleepingFixtureUrls,
      ),
    'native closed-window session persistence',
  );
  const nativeRestored = await worker.evaluate(async (urls) => {
    const closed = await chrome.sessions.getRecentlyClosed();
    const window = closed.find(
      (entry) =>
        entry.window?.sessionId &&
        urls.every((url) => entry.window.tabs?.some((tab) => tab.url === url)),
    )?.window;
    if (!window?.sessionId) throw new Error('Missing native closed-window fixture');
    return (await chrome.sessions.restore(window.sessionId)).window;
  }, sleepingFixtureUrls);
  const restoredSleepingIds = nativeRestored.tabs
    .filter((tab) => (tab.pendingUrl || tab.url)?.includes('/suspended.html#'))
    .map((tab) => tab.id);
  assert.equal(restoredSleepingIds.length, 2, 'Native restore must include both sleeping fixtures');
  await dashboard.waitForFunction(
    async (ids) => {
      const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      return tabs.every((tab) => tab.favIconUrl?.startsWith('data:image/png;base64,'));
    },
    restoredSleepingIds,
    { timeout: 20000 },
  );
  const inactiveRestored = await worker.evaluate(async (ids) => {
    const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
    return tabs.find((tab) => !tab.active);
  }, restoredSleepingIds);
  const dormantPage = context.pages().find((page) => page.url() === inactiveRestored.url);
  assert(dormantPage, 'Restored placeholder document must exist for the discard fixture');
  await dormantPage.evaluate(() => {
    document.querySelector('link[rel="icon"]').href = chrome.runtime.getURL('icons/16.png');
  });
  await dashboard.waitForFunction(
    async (id) => (await chrome.tabs.get(id)).favIconUrl?.includes('/icons/16.png'),
    inactiveRestored.id,
  );
  const discardedRestored = await worker.evaluate(
    (id) => chrome.tabs.discard(id),
    inactiveRestored.id,
  );
  const requestsBeforeDormantRepair = originalRequests;
  await dashboard.waitForFunction(
    async (id) => {
      const tab = await chrome.tabs.get(id);
      return !tab.active && !tab.discarded && tab.favIconUrl?.startsWith('data:image/png;base64,');
    },
    discardedRestored.id,
    { timeout: 65000 },
  );
  assert.equal(
    originalRequests,
    requestsBeforeDormantRepair,
    'Dormant icon repair must not visit original sites',
  );
  await worker.evaluate((id) => chrome.windows.remove(id), nativeRestored.id);
  await call('state');
  const beforeResumeRequests = originalRequests;
  await call('resumeSession');
  const resumedIcons = (await call('state')).records.filter(
    (record) => groupRecords.some((source) => source.id === record.id) && record.live,
  );
  assert.equal(resumedIcons.length, 2);
  assert(
    resumedIcons.every((record) => record.suspendedFavicon?.startsWith('data:image/png;base64,')),
  );
  await dashboard.waitForFunction(
    async (ids) => {
      const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      return tabs.every(
        (tab) =>
          tab.url.includes('/suspended.html#') &&
          tab.favIconUrl?.startsWith('data:image/png;base64,'),
      );
    },
    resumedIcons.map((record) => record.tabId),
  );
  assert.equal(
    originalRequests,
    beforeResumeRequests,
    'Resume and native favicon repair must not load original websites',
  );
  console.log(
    'Native smoke: exact closed-window fixture, dormant favicon repair and saved-session resume passed',
  );
  await worker.evaluate(
    async (fixture) => {
      await chrome.tabs.remove(fixture.tabIds);
    },
    {
      tabIds: resumedIcons.map((record) => record.tabId),
    },
  );
  await call('state');
  await call('saveSession', { replaceMissing: true });
  browserPanel.on('pageerror', recordRuntimeError);
  browserPanel.on('console', (message) => {
    if (/Unhandled error|Maximum recursive|Injection.*not found/.test(message.text()))
      recordRuntimeError(new Error(message.text()));
  });
  await browserPanel.setViewportSize({ width: 730, height: 900 });
  await browserPanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await browserPanel.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
  await browserPanel.getByRole('button', { name: 'This window', exact: true }).waitFor();
  await mkdir('artifacts', { recursive: true });
  await browserPanel.screenshot({ path: 'artifacts/sidepanel-tabs.png' });
  await browserPanel.getByRole('button', { name: 'All tabs', exact: true }).click();
  assert(
    (await browserPanel.locator('[data-workspace-record-id]').count()) > 0,
    'The native entrypoint must render real tab occurrences',
  );
  await browserPanel.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await browserPanel.getByRole('button', { name: 'Assistant', exact: true }).click();
  await browserPanel.getByRole('heading', { name: 'Assistant', exact: true }).waitFor();
  await browserPanel.screenshot({ path: 'artifacts/sidepanel-assistant.png' });
  await browserPanel.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await browserPanel.getByRole('button', { name: 'Windows & tabs', exact: true }).click();
  await browserPanel.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
  const panelWidth = await browserPanel.locator('main').boundingBox();
  assert(
    panelWidth && panelWidth.width >= 725,
    'Workspace view must fill the side panel after navigation',
  );
  const panelWindowId = await browserPanel.evaluate(async () => {
    const originalClose = chrome.sidePanel.close;
    chrome.sidePanel.close = async (options) => {
      window.sessionStorage.setItem('panelCloseWindowId', String(options.windowId));
      return originalClose(options);
    };
    return (await chrome.windows.getCurrent()).id;
  });
  await browserPanel.getByRole('button', { name: 'Workspace menu', exact: true }).click();
  await browserPanel.getByRole('menuitem', { name: 'Open full page', exact: true }).click();
  await dashboard.waitForURL('**/dashboard.html#tabs');
  await browserPanel.waitForFunction(
    () => window.sessionStorage.getItem('panelCloseWindowId') !== null,
  );
  assert.equal(
    await browserPanel.evaluate(() => window.sessionStorage.getItem('panelCloseWindowId')),
    String(panelWindowId),
    'Full-page handoff must close the source browser panel after opening the dashboard',
  );
  await browserPanel.getByRole('button', { name: 'Close side panel', exact: true }).waitFor();
  await browserPanel.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await browserPanel.getByRole('button', { name: 'Settings', exact: true }).click();
  await browserPanel.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const settingsWidth = await browserPanel.locator('main').boundingBox();
  assert(settingsWidth && settingsWidth.width >= 725, 'Settings must fill the side panel');
  await browserPanel.screenshot({ path: 'artifacts/sidepanel-settings.png' });
  // This loads the actual side-panel entrypoint, not the browser's docked panel surface.
  const panelConfig = await worker.evaluate(async () => chrome.sidePanel.getOptions({}));
  assert.equal(panelConfig.path, 'sidepanel.html');
  await call('undoCollection', { id: proposal.id });
  const undone = await call('state');
  assert(copies.every((item) => !undone.records.find((record) => record.id === item.id)?.live));
  assert(originals.every((item) => undone.records.find((record) => record.id === item.id)?.live));
  const legacyUrl = `${base}/legacy?q=one+two&url=https://nested.test/&b=2#part`;
  const legacyTabs = await dashboard.evaluate(
    async ({ legacyId, legacyUrl }) => {
      const url = `chrome-extension://${legacyId}/suspended.html#ttl=Legacy%20fixture&pos=48&uri=${legacyUrl}`;
      const host = await chrome.tabs.getCurrent();
      const first = await chrome.tabs.create({
        url,
        active: false,
        pinned: true,
        windowId: host.windowId,
      });
      const second = await chrome.tabs.create({ url, active: false, windowId: first.windowId });
      const groupId = await chrome.tabs.group({ tabIds: [second.id] });
      await chrome.tabGroups.update(groupId, { title: 'Legacy group', color: 'grey' });
      return [first, { ...second, groupId }];
    },
    { legacyId, legacyUrl },
  );
  await dashboard.waitForFunction(
    async (ids) =>
      (await Promise.all(ids.map((id) => chrome.tabs.get(id)))).every(
        (tab) => tab.url?.includes('/suspended.html') && tab.status === 'complete',
      ),
    legacyTabs.map((tab) => tab.id),
  );
  await dashboard.waitForFunction(async () => {
    const result = await chrome.runtime.sendMessage({ type: 'state' });
    return (
      result.ok && result.value.records.filter((record) => record.foreignSuspended).length === 2
    );
  });
  const beforeImport = await call('state');
  const importSlots = await dashboard.evaluate(
    async (ids) => Promise.all(ids.map((id) => chrome.tabs.get(id))),
    legacyTabs.map((tab) => tab.id),
  );
  const importGroups = beforeImport.groups;
  const foreign = beforeImport.records.filter((record) => record.foreignSuspended);
  assert.equal(foreign.length, 2);
  assert.equal(new Set(foreign.map((record) => record.id)).size, 2);
  const importReport = await call('migrationReport');
  assert.equal(importReport.recognized, 2);
  await dashboard.getByRole('button', { name: 'Review & inspect', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Import Suspender tabs', exact: true }).click();
  await dashboard.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await dashboard
    .getByRole('heading', { name: 'Import complete', exact: true })
    .waitFor({ timeout: 10000 })
    .catch(async (error) => {
      const diagnostic = await call('state');
      console.error('Migration state:', diagnostic.migration);
      if (diagnostic.migration)
        console.error(
          'Migration receipt:',
          await call('migrationDetails', { id: diagnostic.migration.id }),
        );
      console.error('Migration UI:', (await dashboard.locator('body').innerText()).slice(0, 2200));
      await dashboard.screenshot({ path: 'artifacts/migration-failure.png' });
      throw error;
    });
  await dashboard.screenshot({ path: 'artifacts/migration-complete.png' });
  const imported = await call('state');
  assert.equal(imported.migration.imported, 2);
  assert.equal(imported.records.filter((record) => record.foreignSuspended).length, 0);
  assert.deepEqual(
    imported.groups,
    importGroups,
    'Migration must retain group identities and properties',
  );
  for (const previous of importSlots) {
    const after = await dashboard.evaluate((id) => chrome.tabs.get(id), previous.id);
    for (const key of ['id', 'windowId', 'groupId', 'index', 'pinned'])
      assert.equal(after[key], previous[key], `Migration changed ${key}`);
  }
  for (const previous of legacyTabs) {
    const after = imported.records.find((record) => record.tabId === previous.id);
    assert.equal(after.url, legacyUrl);
    assert.equal(after.suspended, true);
    assert.equal(after.windowId, previous.windowId);
    assert.equal(after.groupId, previous.groupId);
    assert.equal(after.pinned, previous.pinned);
  }
  assert.equal(
    (await call('migrationDetails', { id: imported.migration.id })).items.filter(
      (item) => item.status === 'imported',
    ).length,
    2,
  );
  const firstImported = imported.records.find((record) => record.tabId === legacyTabs[0].id);
  const migratedPage = context
    .pages()
    .find((page) => page.url().includes(`id=${firstImported.id}`));
  assert(migratedPage, 'Imported native tab must remain available for an individual wake');
  await migratedPage.bringToFront();
  await migratedPage.locator('main').waitFor({ state: 'visible' });
  assert.equal(await migratedPage.locator('#status').isVisible(), false);
  assert.equal(await migratedPage.locator('#preview-note').isVisible(), false);
  await migratedPage.screenshot({ path: 'artifacts/suspended-no-preview.png' });
  await migratedPage.setViewportSize({ width: 390, height: 844 });
  await migratedPage.screenshot({ path: 'artifacts/suspended-mobile.png' });
  assert.equal(
    await migratedPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await migratedPage.getByRole('button', { name: 'Wake this tab', exact: true }).click();
  await migratedPage.waitForURL(legacyUrl);
  const afterWake = await call('state');
  assert.equal(
    afterWake.records.find((record) => record.tabId === legacyTabs[1].id).suspended,
    true,
  );
  // Animation-frame rendering requires the inspected panel tab to be visible after full-page handoff.
  await browserPanel.bringToFront();
  await browserPanel.evaluate(() => {
    const sendMessage = chrome.runtime.sendMessage;
    window.sessionStorage.setItem('stressRefreshes', '0');
    chrome.runtime.sendMessage = async (request) => {
      const result = await sendMessage(request);
      if (request.type === 'state' && result.ok) {
        const sample = result.value.records.find((record) => record.live);
        result.value.records.push(
          ...Array.from({ length: 300 }, (_, index) => ({
            ...structuredClone(sample),
            id: `render-stress-${index}`,
            title: `Render stress ${index}`,
            sourceRecordId: undefined,
            locked: false,
          })),
        );
        window.sessionStorage.setItem(
          'stressRefreshes',
          String(Number(window.sessionStorage.getItem('stressRefreshes')) + 1),
        );
      }
      return result;
    };
    window.location.hash = 'assistant';
  });
  await browserPanel.getByRole('heading', { name: 'Assistant', exact: true }).waitFor();
  await browserPanel.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await browserPanel.getByRole('button', { name: 'Windows & tabs', exact: true }).click();
  await browserPanel.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
  await browserPanel.getByRole('button', { name: 'All tabs', exact: true }).click();
  await browserPanel.getByRole('searchbox', { name: 'Search tabs' }).fill('Render stress 299');
  await browserPanel.locator('[data-workspace-record-id="render-stress-299"]').waitFor();
  await browserPanel.getByRole('searchbox', { name: 'Search tabs' }).fill('');
  assert(
    (await browserPanel.locator('[data-workspace-record-id]').count()) <= 35,
    'Workspace renders bounded rows for a large collection',
  );
  await browserPanel.waitForFunction(
    () => Number(window.sessionStorage.getItem('stressRefreshes')) >= 2,
  );
  assert.deepEqual(
    [...runtimeErrors],
    [],
    'Dashboard and side-panel must have no uncaught runtime errors',
  );
  // Exercise the browser's actual unpacked-extension Reload API, not a page refresh.
  const reloadFixtures = await worker.evaluate(async () => {
    const first = await chrome.windows.create({ focused: false });
    const second = await chrome.windows.create({ focused: false });
    const ids = [];
    for (let index = 0; index < 120; index++) {
      const recordId = globalThis.crypto.randomUUID();
      const fragment = new globalThis.URLSearchParams({
        id: recordId,
        title: `Reload duplicate ${index}`,
        url: 'https://example.test/reload-duplicate',
        scroll: '0',
      });
      const tab = await chrome.tabs.create({
        windowId: index < 60 ? first.id : second.id,
        active: false,
        pinned: index === 119,
        url: chrome.runtime.getURL(`suspended.html#${fragment}`),
      });
      ids.push(tab.id);
    }
    const group = await chrome.tabs.group({
      tabIds: ids.slice(0, 60),
      createProperties: { windowId: first.id },
    });
    await chrome.tabGroups.update(group, {
      title: 'Reload category',
      color: 'grey',
      collapsed: true,
    });
    return { ids, group };
  });
  const beforeReload = await call('state');
  assert(
    beforeReload.groups.some(
      (group) =>
        group.id === reloadFixtures.group && group.title === 'Reload category' && group.collapsed,
    ),
  );
  const expectedReloadIds = beforeReload.records
    .filter((record) => reloadFixtures.ids.includes(record.tabId))
    .map((record) => record.id);
  assert.equal(expectedReloadIds.length, 120);
  const survivor = beforeReload.records.find(
    (record) => record.url === `${base}/two` && !record.sourceRecordId,
  );
  const extensionSettings = await context.newPage();
  await extensionSettings.goto('chrome://extensions');
  await extensionSettings.evaluate(() =>
    chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }),
  );
  async function reloadExtension() {
    const closed = dashboard.waitForEvent('close', { timeout: 20000 });
    await extensionSettings.evaluate(async (id) => {
      await new Promise((resolve, reject) => {
        chrome.developerPrivate.reload(id, { failQuietly: false }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    }, extensionId);
    await closed;
    await extensionSettings.waitForFunction(async (id) => {
      const extensions = await chrome.developerPrivate.getExtensionsInfo({
        includeDisabled: true,
        includeTerminated: true,
      });
      return extensions.some((extension) => extension.id === id && extension.state === 'ENABLED');
    }, extensionId);
    dashboard = await context.newPage();
    dashboard.on('pageerror', recordRuntimeError);
    await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html#tabs`);
    await dashboard.getByRole('heading', { name: 'Windows & tabs', exact: true }).waitFor();
  }
  await reloadExtension();
  const resumedCheckpoint = await call('getCollectionAnalysis', { id: 'native-checkpoint' });
  assert.equal(resumedCheckpoint?.revision, 1);
  assert.equal(
    (await call('getCollectionAnalysis', { id: repairedCheckpoint.id })).sourceAnalysisId,
    'native-checkpoint',
  );
  const durableTags = await call('listTagAnalyses', { analysisId: 'native-tags' });
  assert.equal(durableTags.length, 1);
  assert.equal(durableTags[0].status, 'complete');
  assert.equal(durableTags[0].proposalModel, 'synthetic');
  const durableReceipt = await dashboard.evaluate(
    async () =>
      new Promise((resolve, reject) => {
        const open = window.indexedDB.open('tabloom');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('inferenceReceipts', 'readonly');
          const get = tx.objectStore('inferenceReceipts').get('native-receipt');
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
          tx.oncomplete = () => open.result.close();
        };
      }),
  );
  assert.equal(durableReceipt?.request, '{"synthetic":true}');
  assert.deepEqual(resumedCheckpoint?.failedBatch?.recordIds, [record.id]);
  const rebasedCheckpoint = await call('rebaseCollectionAnalysis', { id: 'native-checkpoint' });
  assert.equal(rebasedCheckpoint.revision, 2);
  assert.deepEqual(rebasedCheckpoint.failedBatch?.recordIds, [record.id]);
  await call('clearCollectionAnalysis', { id: 'native-checkpoint' });
  const savedAction = await call('getActionAnalysis', { id: 'native-action-checkpoint' });
  assert.equal(savedAction?.status, 'pending');
  assert.deepEqual(savedAction?.failedBatch?.recordIds, [record.id]);
  assert((await call('listActionAnalyses')).some((item) => item.id === savedAction.id));
  const afterRawReload = await call('state');
  console.log(
    'Reload inventory:',
    JSON.stringify({
      session: afterRawReload.session,
      fixtureSurvivors: afterRawReload.records.filter((record) =>
        expectedReloadIds.includes(record.id),
      ).length,
    }),
  );
  assert(
    afterRawReload.session.missingTabs >= 120,
    'Browser Reload must expose the saved missing collection',
  );
  assert.equal(
    afterRawReload.records.filter((record) => expectedReloadIds.includes(record.id)).length,
    0,
    'Verify that real browser reload actually closed these extension pages',
  );
  await dashboard.screenshot({ path: 'artifacts/session-reload-recovery.png' });
  await dashboard.getByRole('button', { name: 'Resume missing tabs', exact: true }).click();
  await dashboard.getByRole('button', { name: 'Resume', exact: true }).click();
  await dashboard
    .getByText(/missing tabs resumed/)
    .first()
    .waitFor();
  const recoveredReload = await call('state');
  console.log(
    'Recovered category:',
    JSON.stringify(
      recoveredReload.groups.map((group) => ({ title: group.title, collapsed: group.collapsed })),
    ),
  );
  assert.equal(recoveredReload.session.missingTabs, 0);
  assert.equal(
    recoveredReload.records.filter((record) => expectedReloadIds.includes(record.id)).length,
    120,
  );
  assert(
    recoveredReload.records
      .filter((record) => expectedReloadIds.includes(record.id))
      .every((record) => record.suspended),
  );
  assert.equal(
    recoveredReload.records.find((record) => record.id === survivor.id).tabId,
    survivor.tabId,
  );
  assert(
    recoveredReload.groups.some((group) => group.title === 'Reload category' && group.collapsed),
  );
  assert.deepEqual(await call('resumeSession'), [], 'Repeated Resume must not create duplicates');
  // Opt-in: creating/reconciling 608 native tabs is expensive on CI hosts.
  const largeUpdateCount = process.env.TABFLOW_LARGE_NATIVE === '1' ? 488 : 0;
  const updateFixtureWindow = recoveredReload.records.find((record) =>
    expectedReloadIds.includes(record.id),
  )?.windowId;
  assert(Number.isInteger(updateFixtureWindow));
  const largeUpdateFixture = largeUpdateCount
    ? await dashboard.evaluate(
        async ({ windowId, count }) => {
          const ids = [];
          for (let start = 0; start < count; start += 8) {
            const created = await Promise.all(
              Array.from({ length: Math.min(8, count - start) }, async (_, offset) => {
                const index = start + offset;
                const fragment = new URLSearchParams({
                  id: globalThis.crypto.randomUUID(),
                  title: `Large update ${index}`,
                  url: `https://example.test/large-update/${Math.floor(index / 2)}`,
                  scroll: '0',
                });
                return chrome.tabs.create({
                  windowId,
                  active: false,
                  url: chrome.runtime.getURL(`suspended.html#${fragment}`),
                });
              }),
            );
            ids.push(...created.map((tab) => tab.id));
          }
          return ids;
        },
        { windowId: updateFixtureWindow, count: largeUpdateCount },
      )
    : [];
  assert.equal(largeUpdateFixture.length, largeUpdateCount);
  const readyForSafeReload = await call('state');
  assert.equal(
    readyForSafeReload.records.filter((record) => largeUpdateFixture.includes(record.tabId)).length,
    largeUpdateCount,
  );
  const survivorPage = context.pages().find((page) => page.url() === `${base}/two`);
  assert(survivorPage, 'Ordinary live website must be present');
  await survivorPage.evaluate(() => {
    window.__updateSentinel = 'live page retained';
  });
  const exactSlots = await dashboard.evaluate(async () =>
    (await chrome.tabs.query({})).map(({ id, windowId, groupId, index, pinned, url }) => ({
      id,
      windowId,
      groupId,
      index,
      pinned,
      url,
    })),
  );
  await dashboard
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Update TabFlow', exact: true })
    .click();
  const dashboardRoute = dashboard.url();
  const extraDashboard = await context.newPage();
  await extraDashboard.goto(`chrome-extension://${extensionId}/dashboard.html#settings`);
  await extraDashboard.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const updateProgress = [];
  await dashboard.exposeFunction('recordUpdateProgress', (progress) =>
    updateProgress.push(progress),
  );
  await dashboard.evaluate(() =>
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'updateProgress' && message.payload)
        void window.recordUpdateProgress(message.payload);
    }),
  );
  await dashboard.getByRole('button', { name: 'Save & reload', exact: true }).click();
  const parkedDashboard = dashboard.waitForURL(/^chrome:\/\/version\/#tabflow-update=/, {
    timeout: 120000,
  });
  await dashboard
    .getByRole('dialog')
    .getByRole('button', { name: 'Save & reload', exact: true })
    .click();
  await parkedDashboard;
  let reopenedUpdatePage;
  for (let attempt = 0; attempt < 120; attempt++) {
    reopenedUpdatePage = context
      .pages()
      .find((page) => page.url().endsWith(`dashboard.html#update`));
    if (reopenedUpdatePage) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(reopenedUpdatePage, 'A visible update dashboard must reopen after the extension reloads');
  reopenedUpdatePage.on('pageerror', recordRuntimeError);
  await reopenedUpdatePage.getByRole('heading', { name: 'Update TabFlow', exact: true }).waitFor();
  await reopenedUpdatePage.getByText('TabFlow updated and ready').waitFor({ timeout: 120000 });
  const updateReceipt = await reopenedUpdatePage.evaluate(
    async () => (await chrome.storage.local.get('updateCompletion')).updateCompletion,
  );
  assert.equal(updateReceipt.total >= 120 + largeUpdateCount, true);
  assert.equal(updateReceipt.restored + updateReceipt.retained, updateReceipt.total);
  await reopenedUpdatePage.screenshot({ path: 'artifacts/update-restored.png' });
  await dashboard.waitForURL(dashboardRoute, { timeout: 120000 });
  await dashboard.getByRole('heading', { name: 'Update TabFlow', exact: true }).waitFor();
  await extraDashboard.waitForURL(`chrome-extension://${extensionId}/dashboard.html#settings`);
  assert(!extraDashboard.isClosed(), 'Other dashboard tabs must remain open');
  assert(
    updateProgress.some(
      (progress) =>
        progress.stage === 'preparing' &&
        progress.processed > 0 &&
        progress.total >= 120 + largeUpdateCount,
    ),
    'The update view must receive actual per-tab progress before reload',
  );
  const safelyReloaded = await call('state');
  assert.equal(
    await survivorPage.evaluate(() => window.__updateSentinel),
    'live page retained',
    'The live website must retain its in-memory state',
  );
  const afterSlots = await dashboard.evaluate(async () =>
    (await chrome.tabs.query({})).map(({ id, windowId, groupId, index, pinned, url }) => ({
      id,
      windowId,
      groupId,
      index,
      pinned,
      url,
    })),
  );
  for (const previous of exactSlots) {
    const current = afterSlots.find((tab) => tab.id === previous.id);
    assert(current, `Update closed tab ${previous.id}`);
    for (const key of ['id', 'windowId', 'groupId', 'index', 'pinned'])
      assert.equal(current[key], previous[key], `Protected update changed ${key}`);
    if (!previous.url.includes('/dashboard.html')) assert.equal(current.url, previous.url);
  }
  assert.deepEqual(
    safelyReloaded.groups,
    readyForSafeReload.groups,
    'Protected update must preserve group IDs and properties',
  );
  assert.equal(safelyReloaded.session.missingTabs, 0);
  assert.equal(safelyReloaded.records.length, readyForSafeReload.records.length);
  assert.equal(
    safelyReloaded.records.filter((record) => largeUpdateFixture.includes(record.tabId)).length,
    largeUpdateCount,
  );
  assert.deepEqual(
    safelyReloaded.windows.map((window) => window.id).sort(),
    readyForSafeReload.windows.map((window) => window.id).sort(),
    'Authorized in-app reload must reuse surviving window slots instead of leaving empty windows behind',
  );
  assert.equal(
    safelyReloaded.records.filter((record) => expectedReloadIds.includes(record.id)).length,
    120,
  );
  assert.equal(
    safelyReloaded.records.find((record) => record.id === survivor.id).tabId,
    survivor.tabId,
  );
  await dashboard.screenshot({ path: 'artifacts/session-safe-reload.png' });
  // Optional real-provider draft projection; only this disposable browser is mutated.
  if (process.env.TABFLOW_AI_ACCEPTANCE_PATH) {
    const sample = z
      .object({
        model: z.string(),
        draft: z
          .object({
            scopeRecordIds: z.array(z.string()),
            assignments: z.array(z.object({ recordId: z.string() }).passthrough()),
            unresolvedRecordIds: z.array(z.string()),
          })
          .passthrough(),
        records: z.array(z.object({ id: z.string(), url: z.string().url(), title: z.string() })),
      })
      .parse(JSON.parse(await readFile(process.env.TABFLOW_AI_ACCEPTANCE_PATH, 'utf8')));
    const sources = sample.records.filter((item) => sample.draft.scopeRecordIds.includes(item.id));
    const ids = new Map(sources.map((item) => [item.id, randomUUID()]));
    const urls = sources.map(
      (item) =>
        `chrome-extension://${extensionId}/suspended.html#${new URLSearchParams({ id: ids.get(item.id), url: item.url, title: item.title, pos: '0' })}`,
    );
    const fixtureWindow = await dashboard.evaluate(async (urls) => {
      const window = await chrome.windows.create({ url: urls, focused: false });
      const tabs = await chrome.tabs.query({ windowId: window.id });
      const group = await chrome.tabs.group({
        tabIds: tabs.map((tab) => tab.id),
        createProperties: { windowId: window.id },
      });
      await chrome.tabGroups.update(group, { title: 'Old fixture grouping', color: 'grey' });
      return window.id;
    }, urls);
    const nativeState = await call('state');
    const nativeSources = sources.map((source) => {
      const record = nativeState.records.find(
        (item) => item.id === ids.get(source.id) && item.live,
      );
      assert(record, `Synthetic source ${source.id} was not reconciled`);
      assert.equal(record.url, source.url);
      assert.equal(record.windowId, fixtureWindow);
      return record;
    });
    const originalGroups = nativeState.groups.filter((group) => group.windowId === fixtureWindow);
    const nativeDraft = {
      ...sample.draft,
      scopeRecordIds: nativeSources.map((item) => item.id),
      assignments: sample.draft.assignments.map((assignment) => {
        const record = nativeSources.find((item) => item.id === ids.get(assignment.recordId));
        assert(record);
        return {
          ...assignment,
          recordId: record.id,
          url: record.url,
          navigationVersion: record.navigationVersion,
        };
      }),
      unresolvedRecordIds: sample.draft.unresolvedRecordIds.map((id) => ids.get(id)),
    };
    // Background RPC performs the complete domain validation before saving or applying.
    const reviewed = await call('proposeCollection', nativeDraft);
    const applied = await call('organizeCollection', { id: reviewed.id });
    assert.equal(applied.operation.status, 'complete', JSON.stringify(applied.proposal.copyState));
    const projected = await call('state');
    for (const original of nativeSources) {
      const retained = projected.records.find((item) => item.id === original.id);
      for (const key of ['tabId', 'windowId', 'groupId', 'url', 'suspended'])
        assert.equal(retained[key], original[key]);
    }
    assert.deepEqual(
      projected.groups.filter((group) => group.windowId === fixtureWindow),
      originalGroups,
    );
    const projectedCopies = projected.records.filter(
      (item) => nativeSources.some((source) => item.sourceRecordId === source.id) && item.live,
    );
    assert.equal(projectedCopies.length, nativeDraft.assignments.length);
    assert(projectedCopies.every((item) => item.suspended && item.id !== item.sourceRecordId));
    for (const assignment of nativeDraft.assignments) {
      const copy = projectedCopies.find((item) => item.sourceRecordId === assignment.recordId);
      const membership = projected.memberships.find((item) => item.recordId === copy.id);
      assert.equal(
        projected.projects.find((item) => item.id === membership.projectId)?.name,
        assignment.projectName,
      );
      if (assignment.categoryName)
        assert.equal(
          projected.groups.find((item) => item.id === copy.groupId)?.title,
          assignment.categoryName,
        );
    }
    await call('undoCollection', { id: reviewed.id });
    const reverted = await call('state');
    assert(
      projectedCopies.every((copy) => !reverted.records.find((item) => item.id === copy.id)?.live),
    );
    assert(
      nativeSources.every((source) => reverted.records.find((item) => item.id === source.id)?.live),
    );
    console.log(
      `Real-provider draft from ${sample.model} passed isolated native Apply/category groups/original retention/Undo; no original websites were loaded.`,
    );
  }
  if (!devServer) {
    const restartUrls = nativeRestored.tabs
      .map((tab) => tab.pendingUrl || tab.url)
      .filter((url) => url?.includes('/suspended.html#'));
    const restartWorker = context
      .serviceWorkers()
      .find((item) => item.url().endsWith('/background.js'));
    assert(
      restartWorker,
      'Current background worker is required after the earlier extension reload',
    );
    await restartWorker.evaluate(async (urls) => {
      const window = await chrome.windows.create({ url: 'about:blank', focused: false });
      for (const url of urls) await chrome.tabs.create({ windowId: window.id, url, active: false });
      // Isolate restart from earlier intentionally awake pages in this temporary profile.
      const earlier = (await chrome.tabs.query({})).filter((tab) => tab.windowId !== window.id);
      if (earlier.length) await chrome.tabs.remove(earlier.map((tab) => tab.id));
    }, restartUrls);
    await context.close();
    const beforeRestartRequests = originalRequests;
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: chromiumPath ? undefined : 'chromium',
      executablePath: chromiumPath || undefined,
      headless,
      args: [
        ...(!headless ? ['--window-position=-32000,-32000'] : []),
        '--no-sandbox',
        '--restore-last-session',
        `--disable-extensions-except=${extension},${legacyExtension}`,
        `--load-extension=${extension},${legacyExtension}`,
      ],
    });
    const restartedWorker =
      context.serviceWorkers().find((item) => item.url().endsWith('/background.js')) ||
      (await context.waitForEvent('serviceworker', {
        predicate: (item) => item.url().endsWith('/background.js'),
        timeout: 15000,
      }));
    let recovered = false;
    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
      recovered = await restartedWorker.evaluate(async (urls) => {
        const tabs = await chrome.tabs.query({});
        return urls.every((url) =>
          tabs.some(
            (tab) =>
              tab.url === url &&
              !tab.active &&
              tab.favIconUrl?.startsWith('data:image/png;base64,'),
          ),
        );
      }, restartUrls);
      if (recovered) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(
      recovered,
      'Inactive sleeping site icons must recover after browser process restart without clicking',
    );
    assert.equal(
      originalRequests,
      beforeRestartRequests,
      'Restart icon repair must not load original sites',
    );
    console.log(
      'Native smoke: process restart restored inactive site icons without tab activation',
    );
  }
  console.log(
    'Real extension smoke passed: native closed-window restore, dormant favicon repair, raw extension reload/reviewed resume, safe reload with 120 duplicate sleeping tabs, previews, protections, migration/wake, groups/recovery/export, original-preserving copies/Undo, and side-panel configuration. Docked panel placement is not tested.',
  );
} finally {
  await context?.close();
  server.close();
  try {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`Isolated test cleanup remains at ${temporary}: ${error.message}`);
  }
}
