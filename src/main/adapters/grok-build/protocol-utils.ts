export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function currentModelId(value: unknown): string | null {
  const root = asRecord(value);
  const models = asRecord(root.models);
  const sessionModel = models.currentModelId;
  if (typeof sessionModel === 'string' && sessionModel.trim()) return sessionModel;

  const modelState = asRecord(asRecord(root._meta).modelState);
  const initializedModel = modelState.currentModelId;
  return typeof initializedModel === 'string' && initializedModel.trim()
    ? initializedModel
    : null;
}

export function currentSessionMode(value: unknown): 'default' | 'plan' | 'ask' | null {
  const root = asRecord(value);
  const standard = asRecord(root.modes).currentModeId;
  if (standard === 'default' || standard === 'plan' || standard === 'ask') return standard;

  const sessionConfig = asRecord(asRecord(root._meta)['x.ai/sessionConfig']);
  const extension = sessionConfig.currentModeId ?? sessionConfig.mode;
  return extension === 'default' || extension === 'plan' || extension === 'ask'
    ? extension
    : null;
}
