import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { targetSessionsDir } from '../paths.js';
import { buildTurnRecords, splitIntoTurns, type TurnMessage, type WireRecord } from './turn-structure.js';

/**
 * In-place repair for sessions imported by a pre-0.40.0 migrator: the wire
 * carries `metadata` + `context.append_message` but no `turn.prompt` /
 * `turn.ended`. Without those records the engine's turn clock rebuilds from
 * zero, so the first live turn collides with imported history (healEndedTurns
 * then lets the imported snapshot win).
 *
 * Only the imported prefix is rewritten; live records appended after import
 * are preserved verbatim. Returns `true` when the wire (or lastTurnReason)
 * changed. Leaves every file untouched when there is nothing to repair.
 */
export async function repairImportedSessionWire(targetDir: string): Promise<boolean> {
  const statePath = join(targetDir, 'state.json');
  let meta: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null) meta = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (meta === undefined || !isImportedFromKimiCli(meta)) return false;

  const wirePath = join(targetDir, 'agents', 'main', 'wire.jsonl');
  let text: string;
  try {
    text = await readFile(wirePath, 'utf-8');
  } catch {
    return false;
  }
  const records = parseWireRecords(text);
  if (records === undefined) return false;

  let index = 0;
  let metadata: WireRecord | undefined;
  if (records[0]?.type === 'metadata') {
    metadata = records[0];
    index = 1;
  }
  const createdAt = metadata?.['created_at'];
  const time = typeof createdAt === 'number' ? createdAt : Date.now();

  const firstMessage = firstIndexOfType(records, index, 'context.append_message');
  const hasTurnStructure = records.slice(index, firstMessage).some((record) => record.type === 'turn.prompt');
  if (hasTurnStructure) return false;

  const importedMessages: TurnMessage[] = [];
  while (index < records.length && records[index]!.type === 'context.append_message') {
    const message = records[index]!['message'];
    if (typeof message !== 'object' || message === null) return false;
    importedMessages.push(message as TurnMessage);
    index += 1;
  }
  if (importedMessages.length === 0) return false;

  const prefix = buildTurnRecords(splitIntoTurns(importedMessages), { agentId: 'main', time });
  const liveSuffix = records.slice(index);
  const rebuilt: WireRecord[] = [
    ...(metadata === undefined ? [] : [metadata]),
    ...prefix,
    ...liveSuffix,
  ];
  await writeFile(
    wirePath,
    rebuilt.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf-8',
  );

  if (
    meta['lastTurnReason'] === undefined &&
    rebuilt.some((record) => record.type === 'turn.ended')
  ) {
    meta['lastTurnReason'] = 'completed';
    await writeFile(statePath, JSON.stringify(meta, null, 2), 'utf-8');
  }
  return true;
}

/**
 * One-shot scan of every imported session under `targetHome`. Fail-open: a
 * single unreadable session never aborts the walk. Safe to call on every
 * startup — already-repaired and native sessions are left untouched.
 */
export async function repairImportedSessionsInHome(targetHome: string): Promise<number> {
  const sessionsRoot = targetSessionsDir(targetHome);
  let bucketNames: string[];
  try {
    bucketNames = await readdir(sessionsRoot);
  } catch {
    return 0;
  }
  let repaired = 0;
  for (const bucketName of bucketNames) {
    const bucketPath = join(sessionsRoot, bucketName);
    let sessionNames: string[];
    try {
      sessionNames = await readdir(bucketPath);
    } catch {
      continue;
    }
    for (const sessionName of sessionNames) {
      try {
        if (await repairImportedSessionWire(join(bucketPath, sessionName))) {
          repaired += 1;
        }
      } catch {
        // Leave the session as-is; never fail startup for one bad wire.
      }
    }
  }
  return repaired;
}

function isImportedFromKimiCli(meta: Record<string, unknown>): boolean {
  const custom = meta['custom'];
  if (typeof custom !== 'object' || custom === null) return false;
  return (custom as Record<string, unknown>)['imported_from_kimi_cli'] === true;
}

function parseWireRecords(text: string): WireRecord[] | undefined {
  const records: WireRecord[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      return undefined;
    }
    records.push(parsed as WireRecord);
  }
  return records;
}

function firstIndexOfType(records: readonly WireRecord[], from: number, type: string): number {
  const found = records.findIndex((record, i) => i >= from && record.type === type);
  return found === -1 ? records.length : found;
}
