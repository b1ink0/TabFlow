import type { ReceiptWriter } from '../../shared/inference/inference-receipt';
import type { ActionAnalysis } from '../../shared/types';
export interface GenerationOptions {
  onReceipt?: ReceiptWriter;
  readOnly?: boolean;
  allowCrossWindowMove?: boolean;
  allowSleepWake?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  conversation?: Array<{ role: 'user' | 'assistant'; content: string }>;
  useDecisionModel?: boolean;
  actionCheckpoint?: {
    id: string;
    receipt?: ReceiptWriter;
    load: () => Promise<ActionAnalysis | undefined>;
    save: (analysis: ActionAnalysis) => Promise<ActionAnalysis>;
    rebase: () => Promise<ActionAnalysis>;
  };
}
export interface DailyFocusDraft {
  summary: string;
  priorities: Array<{ workItemId: string; reason: string }>;
  evidenceGaps: string[];
}
export interface WorkItemDraft {
  dueAt?: number | null;
  recordId?: string | null;
  title: string;
  notes: string;
  areaId: string | null;
  projectId: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
}
