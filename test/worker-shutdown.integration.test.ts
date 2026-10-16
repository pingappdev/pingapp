import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';

const resourcePrefix = process.env.PINGAPP_WORKER_SHUTDOWN_TEST_RESOURCE_PREFIX ?? '';
if (resourcePrefix && resourcePrefix !== 'pingapp-audit-signer') {
  throw new Error('PINGAPP_WORKER_SHUTDOWN_TEST_RESOURCE_PREFIX must be pingapp-audit-signer.');
}
const suite = resourcePrefix === 'pingapp-audit-signer' ? describe : describe.skip;
let child: ChildProcess | undefined;

function assertLoopbackPortIsClosed(portValue: string): Promise<void> {
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid disposable Redis port.');
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('The disposable Redis test endpoint must be stopped before the shutdown probe.'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(new Error('The disposable Redis test endpoint could not be verified as unavailable.'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('The disposable Redis test endpoint did not refuse a loopback connection promptly.'));
    });
  });
}

suite('worker shutdown with unavailable disposable Redis', () => {
  afterAll(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  it('closes within the bounded shutdown window after SIGTERM during worker startup', async () => {
    const port = process.env.PINGAPP_WORKER_SHUTDOWN_TEST_REDIS_PORT;
    if (!port) throw new Error('A stopped disposable Redis port is required.');
    await assertLoopbackPortIsClosed(port);

    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "await import('./src/worker.ts'); process.stdout.write('audit-worker-ready\\n');"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test', LOG_LEVEL: 'silent', PORT: '7410',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test', POSTGRES_PASSWORD: 'test-only',
        REDIS_URL: `redis://127.0.0.1:${port}/0`,
        PHONE_HMAC_SECRET: 'a'.repeat(64), PHONE_ENC_KEY: 'b'.repeat(64), IP_HASH_SALT: 'audit-signer-test',
        APP_URL: 'http://127.0.0.1:7400', PUBLIC_RPC_URL: 'http://127.0.0.1:1',
        ROUTER_ENABLED: 'false', SMS_DRIVER: 'log',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child?.once('error', reject);
      child?.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
      let readyTimer: NodeJS.Timeout | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Worker startup did not emit its readiness marker.')), 8_000);
        child?.stdout?.setEncoding('utf8');
        child?.stdout?.on('data', (chunk: string) => {
          if (chunk.includes('audit-worker-ready')) resolve();
        });
        child?.once('exit', () => reject(new Error('Worker exited before its startup readiness marker.')));
      });
      try {
        await ready;
      } finally {
        if (readyTimer) clearTimeout(readyTimer);
      }
      expect(child.exitCode).toBeNull();
      child.kill('SIGTERM');
      const signaledAt = Date.now();
      let forceFailTimer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          forceFailTimer = setTimeout(() => reject(new Error('Worker did not exit within 18 seconds after SIGTERM.')), 18_000);
        });
        const result = await Promise.race([exit, timeout]);
        expect(result.signal).toBeNull();
        expect([0, 1]).toContain(result.code);
        expect(Date.now() - signaledAt).toBeLessThan(18_000);
      } finally {
        if (forceFailTimer) clearTimeout(forceFailTimer);
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);
});
