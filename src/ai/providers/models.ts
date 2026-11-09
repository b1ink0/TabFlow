import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { Settings } from '../../shared/types';
import { z } from 'zod';

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });
async function listModelIds(base: string, key: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${base.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${key || 'local'}` },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new Error(`Model listing failed (HTTP ${response.status}).`);
  return modelListSchema.parse(await response.json()).data.map((model) => model.id);
}
export const typesafe = (s: Settings) =>
  new TypeSafeClient({
    baseURL: s.decisionBase,
    apiKey: s.decisionKey || 'local',
    defaultModel: s.decisionModel,
    dangerouslyAllowBrowser: true,
    timeout: 120000,
    retry: { maxRetries: 0 },
  });
export async function models(s: Settings, signal?: AbortSignal): Promise<string[]> {
  if (s.aiProvider === 'bud') {
    const result = await typesafe(s).models.list({ signal });
    return result.map((m) => m.name);
  }
  return listModelIds(s.aiBase, s.aiKey, signal);
}
export async function generativeModels(s: Settings, signal?: AbortSignal): Promise<string[]> {
  return listModelIds(s.aiBase, s.aiKey, signal);
}
export async function decisionModels(s: Settings, signal?: AbortSignal): Promise<string[]> {
  if (s.decisionProvider === 'jev') {
    return listModelIds(`${s.decisionBase.replace(/\/$/, '')}/v1`, s.decisionKey, signal);
  }
  const result = await typesafe(s).models.list({ signal });
  return result.map((model) => model.name);
}
export async function smallModels(s: Settings, signal?: AbortSignal): Promise<string[]> {
  return listModelIds(s.smallModelBase, s.smallModelKey, signal);
}
