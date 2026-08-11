import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function appendAuditEvent(filePath, type, details = {}) {
  if (typeof type !== 'string' || !type) throw new TypeError('Audit event type is required.');
  const entry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    type,
    details
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export async function readAuditEvents(filePath, limit = 100) {
  const boundedLimit = Math.min(Math.max(Math.round(Number(limit) || 100), 1), 500);
  let body;
  try {
    body = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return body.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .slice(-boundedLimit)
    .reverse();
}
