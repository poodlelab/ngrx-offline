import { expect, test } from '@playwright/test';

test('queues offline, reloads, restores optimism, and replays with one idempotency key', async ({
  page,
}) => {
  await page.goto('/e2e/browser/foreground-fixture.html?reset');
  await page.waitForFunction(() => Boolean(window.offlineFixtureReady));
  const operationId = await page.evaluate(() => window.offlineFixture.queue());
  const queued = await page.evaluate(() => window.offlineFixture.snapshot());
  expect(queued.optimistic).toBe(true);
  expect(queued.operations).toHaveLength(1);
  expect(queued.operations[0]?.id).toBe(operationId);
  expect(queued.events.map((event) => event.type)).toContain('queued');

  await page.reload();
  await page.waitForFunction(() => Boolean(window.offlineFixtureReady));
  const reloaded = await page.evaluate(() => window.offlineFixture.snapshot());
  expect(reloaded.optimistic).toBe(false);
  expect(reloaded.operations).toHaveLength(1);

  await page.evaluate(() => window.offlineFixture.restore());
  expect((await page.evaluate(() => window.offlineFixture.snapshot())).optimistic).toBe(true);
  await page.evaluate(() => window.offlineFixture.reconnectAndSync());
  const synchronized = await page.evaluate(() => window.offlineFixture.snapshot());
  expect(synchronized.operations).toEqual([]);
  expect(synchronized.receipts).toHaveLength(1);
  expect(synchronized.receipts[0]?.operationId).toBe(operationId);
  expect(synchronized.transportCalls[0]?.headers?.['Idempotency-Key']).toBe(operationId);
});

declare global {
  interface Window {
    offlineFixtureReady: boolean;
    offlineFixture: {
      queue(scope?: string): Promise<string>;
      restore(): Promise<void>;
      reconnectAndSync(scope?: string): Promise<unknown>;
      snapshot(scope?: string): Promise<{
        optimistic: boolean;
        operations: Array<{
          id: string;
          input: Record<string, unknown>;
          status: string;
          attempts: number;
          lastFailure?: { code: string; status?: number } | null;
        }>;
        allOperations: Array<{ id: string; scope: string }>;
        receipts: Array<{ operationId: string }>;
        events: Array<{ type: string }>;
        transportCalls: Array<{
          url: string;
          body?: Record<string, unknown>;
          headers?: Record<string, string>;
        }>;
        references: Array<{ key: string; value: number | string }>;
        serverMutations: number;
        scopeCounts: Array<{ scope: string; pending: number; blocked: number }>;
      }>;
      queueRelations(scope?: string): Promise<void>;
      queueMigrated(): Promise<{ id: string }>;
      setResponseStatusOnce(status: number): void;
      loseNextResponseAfterCommit(): void;
      retryNow(operationId: string, scope?: string): Promise<unknown>;
      cancel(operationId: string): Promise<'executing' | 'not-found' | 'removed'>;
      pauseForAuthentication(scope?: string): Promise<void>;
      restoreAuthentication(scope?: string): Promise<unknown>;
      setOnline(online: boolean): void;
      holdTransport(): void;
      releaseTransport(): void;
      startSync(scope?: string): void;
      awaitSync(): Promise<unknown>;
    };
  }
}
