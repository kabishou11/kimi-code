import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const startServerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    host: '127.0.0.1',
    port: 58627,
    close: async () => {},
  })),
);

vi.mock('@moonshot-ai/kap-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kap-server')>();
  return { ...actual, startServer: startServerMock };
});

vi.mock('#/cli/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/telemetry')>();
  return {
    ...actual,
    initializeServerTelemetry: () => ({
      track: () => {},
      withContext: (_ctx: unknown, fn: () => unknown) => fn(),
      setContext: () => {},
    }),
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-telemetry')>();
  return {
    ...actual,
    track: () => {},
    shutdownTelemetry: async () => {},
  };
});

describe('foreground startup failure', () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = previousExitCode;
    startServerMock.mockReset();
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 58627,
      close: async () => {},
    });
  });

  it('prints the onReady error, sets exitCode 1, and still rejects', async () => {
    let closed = false;
    let shutdownReason: string | undefined;
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 58627,
      close: async () => {
        closed = true;
      },
    });
    const { startServerForeground } = await import('#/cli/sub/web/run');
    const { parseServerOptions } = await import('#/cli/sub/web/shared');
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-web-startup-'));
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    process.exitCode = undefined;
    try {
      vi.stubEnv('KIMI_CODE_HOME', homeDir);
      await expect(
        startServerForeground(parseServerOptions({}), {
          onReady: async () => {
            throw new Error('Remote Control requires a Kimi login. Run `kimi login` first.');
          },
          onShutdown: async (reason) => {
            shutdownReason = reason;
          },
        }),
      ).rejects.toThrow('Remote Control requires a Kimi login. Run `kimi login` first.');
      expect(process.exitCode).toBe(1);
      expect(stderrChunks.join('')).toContain(
        'Remote Control requires a Kimi login. Run `kimi login` first.',
      );
      expect(shutdownReason).toBe('startup_failed');
      expect(closed).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
