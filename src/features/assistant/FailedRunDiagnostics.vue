<script setup lang="ts">
import { ref } from 'vue';
import { PhCopy } from '@phosphor-icons/vue';
import UiButton from '../../ui/UiButton.vue';
import { database } from '../../core/db';
import { useWorkspace } from '../../stores/workspace';
import { useAssistantConversations } from '../../stores/assistant';
import type { AssistantMessage } from '../../shared/assistant/assistant';
import { failureDiagnostics } from '../../shared/assistant/failure-diagnostics';
const props = defineProps<{ message: AssistantMessage }>();
const store = useWorkspace();
const chat = useAssistantConversations();
const busy = ref(false),
  copied = ref(false);
async function copy() {
  if (busy.value) return;
  busy.value = true;
  copied.value = false;
  try {
    const message = props.message;
    const analysisId = message.collectionAnalysisId || message.actionAnalysisId;
    const warnings: string[] = [];
    const progress = await (async () => {
      if (!analysisId) return;
      try {
        return message.collectionAnalysisId
          ? await database.collectionAnalyses.get(analysisId)
          : await database.actionAnalyses.get(analysisId);
      } catch {
        warnings.push('Saved analysis could not be read.');
        return undefined;
      }
    })();
    const failedIds = new Set(progress?.failedBatch?.recordIds || []);
    const receipts = analysisId
      ? await database.inferenceReceipts
          .where('[analysisId+startedAt]')
          .between(
            [analysisId, message.createdAt],
            [analysisId, message.completedAt || Number.MAX_SAFE_INTEGER],
            true,
            true,
          )
          .reverse()
          .filter(
            (entry) =>
              (!message.analysisFailure || entry.stage === message.analysisFailure.stage) &&
              (!failedIds.size || entry.occurrenceIds?.some((id) => failedIds.has(id)) === true),
          )
          .limit(Math.max(6, message.analysisFailure?.attempts || 0))
          .toArray()
          .catch(() => {
            warnings.push('Inference attempts could not be read.');
            return [];
          })
      : [];
    if (analysisId && !receipts.length)
      warnings.push('No saved inference attempts matched this failed turn and scope.');
    const audit = await database.assistantAudit
      .where('[messageId+sequence]')
      .between([message.id, 0], [message.id, Number.MAX_SAFE_INTEGER])
      .reverse()
      .limit(20)
      .toArray()
      .catch(() => {
        warnings.push('Tool audit could not be read.');
        return [];
      });
    const settings = store.app?.settings;
    const text = failureDiagnostics({
      version: chrome.runtime.getManifest().version,
      message,
      question: chat.current?.messages.find((entry) => entry.id === message.requestMessageId)
        ?.content,
      receipts,
      tools: audit.length ? audit : message.toolEvents,
      progress: progress
        ? { id: progress.id, failedBatch: progress.failedBatch, revision: progress.revision }
        : undefined,
      models: {
        generative: settings?.aiModel || '',
        classifier:
          (settings?.useDedicatedDecisionModel ? settings.decisionModel : settings?.smallModel) ||
          '',
        tagVerification: settings?.tagVerification || '',
        maxAttempts: settings?.aiMaxAttempts || 0,
      },
      warnings,
    });
    await navigator.clipboard.writeText(text);
    copied.value = true;
  } catch {
    store.notify('Could not copy diagnostics. Check clipboard access and try again.', true);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <UiButton
    size="small"
    variant="ghost"
    :disabled="busy"
    title="Copy error, failed-stage requests and responses, model settings and scope. Includes tab evidence; excludes credentials and image data."
    @click="copy"
    ><PhCopy class="size-3.5" />{{ copied ? 'Diagnostics copied' : 'Copy diagnostics' }}</UiButton
  >
</template>
