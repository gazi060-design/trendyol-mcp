import { createHash, randomUUID } from 'node:crypto';

const TTL_MS = 5 * 60 * 1000;

type PendingConfirmation = {
  id: string;
  toolName: string;
  payloadHash: string;
  expiresAt: number;
};

const pending = new Map<string, PendingConfirmation>();

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

function cleanup(): void {
  const now = Date.now();
  for (const [id, item] of pending) if (item.expiresAt <= now) pending.delete(id);
}

export function requestConfirmation(toolName: string, payload: unknown) {
  cleanup();
  const id = randomUUID();
  const expiresAt = Date.now() + TTL_MS;
  pending.set(id, { id, toolName, payloadHash: payloadHash(payload), expiresAt });
  return { confirmationId: id, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeConfirmation(toolName: string, payload: unknown, confirmationId?: string, approved?: boolean): { ok: true } | { ok: false; reason: string } {
  cleanup();
  if (!approved) return { ok: false, reason: 'Explicit approval is required.' };
  if (!confirmationId) return { ok: false, reason: 'confirmationId is required.' };
  const item = pending.get(confirmationId);
  if (!item) return { ok: false, reason: 'Confirmation not found or expired.' };
  pending.delete(confirmationId);
  if (item.toolName !== toolName) return { ok: false, reason: 'Confirmation belongs to another tool.' };
  if (item.payloadHash !== payloadHash(payload)) return { ok: false, reason: 'Payload changed after confirmation request.' };
  return { ok: true };
}
