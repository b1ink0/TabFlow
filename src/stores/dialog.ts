import { defineStore } from 'pinia';
import { ref } from 'vue';
export interface DialogField {
  name: string;
  label: string;
  value?: string;
  options?: Array<{ label: string; value: string; color?: string }>;
  create?: (name: string) => Promise<{ label: string; value: string }>;
  tagOptions?: string[];
  color?: boolean;
}
interface Dialog {
  title: string;
  description?: string;
  fields: DialogField[];
  values: Record<string, string>;
  confirmLabel: string;
}
export const useDialog = defineStore('dialog', () => {
  const current = ref<Dialog | null>(null);
  const creating = ref(false),
    error = ref('');
  let resolve: ((result: Record<string, string> | null) => void) | undefined;
  function ask(
    title: string,
    fields: DialogField[] = [],
    description?: string,
    confirmLabel = 'Continue',
  ): Promise<Record<string, string> | null> {
    if (current.value) throw new Error('Finish the current dialog first.');
    error.value = '';
    current.value = {
      title,
      description,
      fields,
      values: Object.fromEntries(
        fields.map((f) => [f.name, f.value || f.options?.[0]?.value || '']),
      ),
      confirmLabel,
    };
    return new Promise((done) => (resolve = done));
  }
  function close(accepted: boolean) {
    if (creating.value) return;
    const value = accepted ? { ...current.value?.values } : null;
    current.value = null;
    resolve?.(value);
    resolve = undefined;
  }
  async function createOption(field: DialogField, name: string) {
    if (!field.create || !current.value || creating.value) return;
    creating.value = true;
    error.value = '';
    try {
      const option = await field.create(name);
      if (!field.options?.some((entry) => entry.value === option.value))
        field.options?.push(option);
      current.value.values[field.name] = option.value;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      creating.value = false;
    }
  }
  function protectFocus(event: Event) {
    if (current.value) event.preventDefault();
  }
  return { current, ask, close, creating, error, createOption, protectFocus };
});
