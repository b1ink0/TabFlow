import type { InferenceReceipt, ReceiptWriter } from '../../shared/inference/inference-receipt';
import { CLASSIFICATION_CONTRACT } from '../workflows/classification';
export class ReceiptPersistenceError extends Error {}

/** A transport receipt is not a committed decision; validated decisions live in checkpoints. */
export async function recordInference<T>(
  write: ReceiptWriter | undefined,
  model: string,
  stage: InferenceReceipt['stage'],
  request: unknown,
  run: () => Promise<T>,
  occurrenceIds: string[] = [],
): Promise<T> {
  const startedAt = Date.now();
  const persist: ReceiptWriter = async (receipt) => {
    try {
      await write?.(receipt);
    } catch (error) {
      throw new ReceiptPersistenceError(
        `Could not save inference receipt. Saved decisions remain available. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await persist({
      id: crypto.randomUUID(),
      contract: CLASSIFICATION_CONTRACT,
      occurrenceIds,
      model,
      stage,
      startedAt,
      finishedAt: Date.now(),
      outcome: 'failed',
      request: JSON.stringify(request),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await persist({
    id: crypto.randomUUID(),
    contract: CLASSIFICATION_CONTRACT,
    occurrenceIds,
    model,
    stage,
    startedAt,
    finishedAt: Date.now(),
    outcome: 'responded',
    request: JSON.stringify(request),
    response: JSON.stringify(result),
  });
  return result;
}
