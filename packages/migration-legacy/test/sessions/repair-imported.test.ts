import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reduceContextTranscript } from '@moonshot-ai/agent-core-v2';
import { foldWireRecordFacts, groupMessagesIntoSnapshot } from '@moonshot-ai/transcript';

import { targetSessionsDir } from '../../src/paths.js';
import {
  repairImportedSessionsInHome,
  repairImportedSessionWire,
} from '../../src/sessions/repair-imported.js';
import { computeWorkdirBucket } from '../../src/sessions/workdir-bucket.js';

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'repair-imported-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

const IMPORTED_WIRE = [
  '{"type":"metadata","protocol_version":"1.5","created_at":1700000000000}',
  '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"old question 1"}],"toolCalls":[]}}',
  '{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"old answer 1"}],"toolCalls":[]}}',
  '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"old question 2"}],"toolCalls":[]}}',
  '{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"old answer 2"}],"toolCalls":[]}}',
];

const LIVE_SUFFIX = [
  '{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"hello"}],"origin":{"kind":"user"},"promptId":"msg_live1","time":1800000000000}',
  '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"hello"}],"toolCalls":[],"origin":{"kind":"user"},"id":"msg_live1"}}',
  '{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"live reply"}],"toolCalls":[]}}',
  '{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed","durationMs":18779,"time":1800000001000}',
  '{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"hello again"}],"origin":{"kind":"user"},"promptId":"msg_live2","time":1800000002000}',
  '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"hello again"}],"toolCalls":[],"origin":{"kind":"user"},"id":"msg_live2"}}',
  '{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"second live reply"}],"toolCalls":[]}}',
  '{"type":"turn.ended","agentId":"main","turnId":1,"reason":"completed","durationMs":5985,"time":1800000003000}',
];

async function seedImportedSession(
  sessionId: string,
  wireLines: readonly string[],
  stateExtra: Record<string, unknown> = {},
): Promise<string> {
  const targetDir = join(
    targetSessionsDir(targetHome),
    computeWorkdirBucket('/Users/me/proj'),
    sessionId,
  );
  await mkdir(join(targetDir, 'agents', 'main'), { recursive: true });
  await writeFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), wireLines.join('\n') + '\n');
  await writeFile(
    join(targetDir, 'state.json'),
    JSON.stringify({
      id: sessionId,
      title: 'old import',
      custom: { imported_from_kimi_cli: true, kimi_cli_session_id: sessionId.replace(/^ses_/, '') },
      ...stateExtra,
    }),
  );
  return targetDir;
}

function parseRecords(text: string): Array<{ type: string; [key: string]: unknown }> {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
}

describe('repairImportedSessionWire', () => {
  it('inserts turn structure into a message-only imported wire, once', async () => {
    const targetDir = await seedImportedSession('ses_repair-uuid', IMPORTED_WIRE);

    expect(await repairImportedSessionWire(targetDir)).toBe(true);

    const records = parseRecords(await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'));
    expect(records.map((record) => record.type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
    ]);
    expect(records[1]).toMatchObject({
      agentId: 'main',
      origin: { kind: 'user' },
      input: [{ type: 'text', text: 'old question 1' }],
      time: 1700000000000,
    });
    expect(records[4]).toMatchObject({ agentId: 'main', turnId: 0, reason: 'completed' });
    expect(records[8]).toMatchObject({ agentId: 'main', turnId: 1, reason: 'completed' });

    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8')) as {
      lastTurnReason?: string;
      custom?: { import_format_version?: unknown };
    };
    expect(state.lastTurnReason).toBe('completed');
    expect(state.custom?.import_format_version).toBeUndefined();

    expect(await repairImportedSessionWire(targetDir)).toBe(false);
  });

  it('preserves a live suffix verbatim while repairing the imported prefix', async () => {
    const targetDir = await seedImportedSession('ses_repair-uuid', [...IMPORTED_WIRE, ...LIVE_SUFFIX], {
      lastTurnReason: 'completed',
    });

    expect(await repairImportedSessionWire(targetDir)).toBe(true);

    const lines = (await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      'metadata',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'turn.ended',
    ]);
    expect(lines.slice(9)).toEqual(LIVE_SUFFIX);
  });

  it('leaves a native session and an already-structured import untouched', async () => {
    const nativeDir = await seedImportedSession('ses_native', IMPORTED_WIRE, {
      custom: { imported_from_kimi_cli: false },
    });
    const structured = [
      '{"type":"metadata","protocol_version":"1.0","created_at":1}',
      '{"type":"turn.prompt","agentId":"main","input":[],"origin":{"kind":"user"},"time":1}',
      '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"hi"}],"toolCalls":[]}}',
      '{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed","time":1}',
    ];
    const importedDir = await seedImportedSession('ses_current', structured);

    expect(await repairImportedSessionWire(nativeDir)).toBe(false);
    expect(await repairImportedSessionWire(importedDir)).toBe(false);
    expect(await readFile(join(nativeDir, 'agents', 'main', 'wire.jsonl'), 'utf-8')).toBe(
      IMPORTED_WIRE.join('\n') + '\n',
    );
    expect(await readFile(join(importedDir, 'agents', 'main', 'wire.jsonl'), 'utf-8')).toBe(
      structured.join('\n') + '\n',
    );
  });

  it('leaves an unreadable wire untouched', async () => {
    const targetDir = await seedImportedSession('ses_broken', [
      '{"type":"metadata","protocol_version":"1.0","created_at":1}',
      '{broken',
    ]);
    expect(await repairImportedSessionWire(targetDir)).toBe(false);
    expect(await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8')).toBe(
      '{"type":"metadata","protocol_version":"1.0","created_at":1}\n{broken\n',
    );
  });

  it('advances the restored turn clock past imported and live turns so heal cannot collide', async () => {
    const targetDir = await seedImportedSession('ses_clock', [...IMPORTED_WIRE, ...LIVE_SUFFIX]);
    await repairImportedSessionWire(targetDir);

    const records = parseRecords(await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8'));
    const transcript = reduceContextTranscript(records);
    const snapshot = groupMessagesIntoSnapshot([...transcript.entries]);
    const folded = foldWireRecordFacts(records, snapshot);
    const turns = folded.items.filter((item) => item.kind === 'turn');
    const promptCount = records.filter((record) => record.type === 'turn.prompt').length;

    expect(promptCount).toBe(4);
    expect(turns).toHaveLength(4);
    expect(promptCount).toBe(turns.length);

    expect(turns[0]).toMatchObject({ ordinal: 0, prompt: 'old question 1' });
    expect(turns[1]).toMatchObject({ ordinal: 1, prompt: 'old question 2' });
    expect(turns[2]).toMatchObject({ ordinal: 2, prompt: 'hello' });
    expect(turns[3]).toMatchObject({ ordinal: 3, prompt: 'hello again' });

    const importedOrdinals = new Set(
      turns.filter((turn) => turn.prompt?.startsWith('old question')).map((turn) => turn.ordinal),
    );
    const nextLiveOrdinal = promptCount;
    expect(importedOrdinals.has(0)).toBe(true);
    expect(importedOrdinals.has(1)).toBe(true);
    expect(importedOrdinals.has(nextLiveOrdinal)).toBe(false);
    expect(turns.some((turn) => turn.ordinal === nextLiveOrdinal)).toBe(false);

    const liveTurn = turns[3];
    expect(liveTurn?.kind).toBe('turn');
    if (liveTurn?.kind === 'turn') {
      expect(liveTurn.prompt).toBe('hello again');
      expect(liveTurn.prompt).not.toContain('old question');
    }
  });
});

describe('repairImportedSessionsInHome', () => {
  it('repairs every imported message-only session and skips the rest', async () => {
    const broken = await seedImportedSession('ses_needs-repair', [...IMPORTED_WIRE, ...LIVE_SUFFIX]);
    const current = await seedImportedSession('ses_already-ok', [
      '{"type":"metadata","protocol_version":"1.0","created_at":1}',
      '{"type":"turn.prompt","agentId":"main","input":[],"origin":{"kind":"user"},"time":1}',
      '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"hi"}],"toolCalls":[]}}',
    ]);
    const native = await seedImportedSession('ses_native', IMPORTED_WIRE, {
      custom: { imported_from_kimi_cli: false },
    });

    expect(await repairImportedSessionsInHome(targetHome)).toBe(1);
    expect(await repairImportedSessionsInHome(targetHome)).toBe(0);

    const repaired = parseRecords(await readFile(join(broken, 'agents', 'main', 'wire.jsonl'), 'utf-8'));
    expect(repaired.filter((record) => record.type === 'turn.prompt')).toHaveLength(4);
    expect(await readFile(join(current, 'agents', 'main', 'wire.jsonl'), 'utf-8')).toContain('turn.prompt');
    expect(await readFile(join(native, 'agents', 'main', 'wire.jsonl'), 'utf-8')).toBe(
      IMPORTED_WIRE.join('\n') + '\n',
    );
  });

  it('returns 0 when the home has no sessions directory', async () => {
    expect(await repairImportedSessionsInHome(targetHome)).toBe(0);
  });
});
