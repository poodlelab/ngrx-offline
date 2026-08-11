import { expect, test } from '@playwright/test';

test('replays one logical mutation after losing the first committed response', async ({ page }) => {
  await openFixture(page, '?reset');
  const operationId = await page.evaluate(() => window.offlineFixture.queue());
  await page.evaluate(() => window.offlineFixture.loseNextResponseAfterCommit());

  await page.evaluate(() => window.offlineFixture.reconnectAndSync());
  const recovered = await page.evaluate(() => window.offlineFixture.snapshot());
  expect(recovered.operations).toEqual([]);
  expect(recovered.receipts).toEqual([expect.objectContaining({ operationId })]);
  expect(recovered.serverMutations).toBe(1);
  expect(recovered.transportCalls).toHaveLength(2);
  expect(recovered.events).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'retry-scheduled' })]),
  );
});

test('recovers a stale claim after its executing page is terminated', async ({ context, page }) => {
  await openFixture(page, '?reset');
  const operationId = await page.evaluate(() => window.offlineFixture.queue());
  await page.evaluate(() => {
    window.offlineFixture.setOnline(true);
    window.offlineFixture.holdTransport();
    window.offlineFixture.startSync();
  });
  await expect
    .poll(async () => (await page.evaluate(() => window.offlineFixture.snapshot())).transportCalls)
    .toHaveLength(1);
  await page.close();

  await new Promise((resolve) => setTimeout(resolve, 450));
  const replacement = await context.newPage();
  await openFixture(replacement);
  await replacement.evaluate(() => window.offlineFixture.reconnectAndSync());
  const recovered = await replacement.evaluate(() => window.offlineFixture.snapshot());
  expect(recovered.operations).toEqual([]);
  expect(recovered.receipts).toEqual([expect.objectContaining({ operationId })]);
  expect(recovered.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'claims-recovered', operationIds: [operationId] }),
    ]),
  );
});

test('migrates a pending legacy definition before sending it', async ({ page }) => {
  await openFixture(page, '?reset&legacy');
  const operation = await page.evaluate(() => window.offlineFixture.queueMigrated());
  expect((await page.evaluate(() => window.offlineFixture.snapshot())).operations[0]).toMatchObject(
    {
      id: operation.id,
      input: { name: 'Legacy inspection' },
    },
  );

  await page.reload();
  await page.waitForFunction(() => Boolean(window.offlineFixtureReady));
  await page.evaluate(() => window.offlineFixture.reconnectAndSync());
  const migrated = await page.evaluate(() => window.offlineFixture.snapshot());
  expect(migrated.transportCalls[0]?.body).toEqual({
    label: 'Legacy inspection',
    upgraded: true,
  });
  expect(migrated.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'operation-migrated', fromVersion: 1, toVersion: 2 }),
    ]),
  );
});

test('keeps operations and resolved references isolated while switching scopes', async ({
  page,
}) => {
  await openFixture(page, '?reset');
  await page.evaluate(() => window.offlineFixture.queueRelations('workspace-a'));
  await page.evaluate(() => window.offlineFixture.queueRelations('workspace-b'));

  await page.evaluate(() => window.offlineFixture.reconnectAndSync('workspace-a'));
  const scopeA = await page.evaluate(() => window.offlineFixture.snapshot('workspace-a'));
  const scopeBPending = await page.evaluate(() => window.offlineFixture.snapshot('workspace-b'));
  expect(scopeA.operations).toEqual([]);
  expect(scopeA.references).toHaveLength(4);
  expect(scopeBPending.operations).toHaveLength(4);
  expect(scopeBPending.references).toEqual([]);

  await page.evaluate(() => window.offlineFixture.reconnectAndSync('workspace-b'));
  const scopeB = await page.evaluate(() => window.offlineFixture.snapshot('workspace-b'));
  expect(scopeB.operations).toEqual([]);
  expect(scopeB.references).toHaveLength(4);
  expect(scopeB.receipts).toHaveLength(4);
});

for (const status of [409, 412]) {
  test(`blocks HTTP ${status}, then resolves and retries explicitly`, async ({ page }) => {
    await openFixture(page, '?reset');
    const operationId = await page.evaluate(() => window.offlineFixture.queue());
    await page.evaluate((value) => window.offlineFixture.setResponseStatusOnce(value), status);
    await page.evaluate(() => window.offlineFixture.reconnectAndSync());
    expect((await page.evaluate(() => window.offlineFixture.snapshot())).operations).toEqual([
      expect.objectContaining({
        id: operationId,
        status: 'blocked',
        lastFailure: expect.objectContaining({ code: 'conflict', status }),
      }),
    ]);

    await page.evaluate((id) => window.offlineFixture.retryNow(id), operationId);
    const resolved = await page.evaluate(() => window.offlineFixture.snapshot());
    expect(resolved.operations).toEqual([]);
    expect(resolved.receipts).toHaveLength(1);
  });
}

test('reports quota exhaustion without creating optimistic state', async ({
  context,
  page,
}, testInfo) => {
  await context.addInitScript(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...arguments_: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'operations') {
        throw new DOMException('The test storage quota is exhausted.', 'QuotaExceededError');
      }
      return originalAdd.apply(this, arguments_);
    };
  });
  await page.goto('/ngrx-offline/');
  await page.getByRole('button', { name: 'Simulate offline' }).click();
  if (testInfo.project.name.startsWith('mobile-')) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Journal studio', exact: true }).click();
  await page.getByRole('button', { name: 'Save day to the journal' }).click();

  await expect(page.getByText('Durable storage unavailable')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Save a travel day to populate this graph.')).toBeVisible();
  await expect(page.getByText('0 active')).toBeVisible();
  await expect(page.getByText(/Enqueue Failed/).first()).toBeVisible();
});

test('cancels before send but refuses cancellation after transport starts', async ({ page }) => {
  await openFixture(page, '?reset');
  const cancelledId = await page.evaluate(() => window.offlineFixture.queue());
  await expect(page.evaluate((id) => window.offlineFixture.cancel(id), cancelledId)).resolves.toBe(
    'removed',
  );
  expect((await page.evaluate(() => window.offlineFixture.snapshot())).transportCalls).toEqual([]);

  const executingId = await page.evaluate(() => window.offlineFixture.queue());
  await page.evaluate(() => {
    window.offlineFixture.setOnline(true);
    window.offlineFixture.holdTransport();
    window.offlineFixture.startSync();
  });
  await expect
    .poll(async () => (await page.evaluate(() => window.offlineFixture.snapshot())).transportCalls)
    .toHaveLength(1);
  await expect(page.evaluate((id) => window.offlineFixture.cancel(id), executingId)).resolves.toBe(
    'executing',
  );
  await page.evaluate(() => window.offlineFixture.releaseTransport());
  await page.evaluate(() => window.offlineFixture.awaitSync());
  expect((await page.evaluate(() => window.offlineFixture.snapshot())).receipts).toEqual([
    expect.objectContaining({ operationId: executingId }),
  ]);
});

test('pauses replay while authentication is unavailable and resumes safely', async ({ page }) => {
  await openFixture(page, '?reset');
  const operationId = await page.evaluate(() => window.offlineFixture.queue());
  await page.evaluate(() => window.offlineFixture.pauseForAuthentication());
  const paused = await page.evaluate(() => window.offlineFixture.reconnectAndSync());
  expect(paused).toMatchObject({ outcome: 'scope-paused', attempted: 0 });
  expect((await page.evaluate(() => window.offlineFixture.snapshot())).transportCalls).toEqual([]);

  await page.evaluate(() => window.offlineFixture.restoreAuthentication());
  const resumed = await page.evaluate(() => window.offlineFixture.snapshot());
  expect(resumed.operations).toEqual([]);
  expect(resumed.receipts).toEqual([expect.objectContaining({ operationId })]);
  expect(resumed.events).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'scope-resumed' })]),
  );
});

async function openFixture(page: import('@playwright/test').Page, query = ''): Promise<void> {
  await page.goto(`/e2e/browser/foreground-fixture.html${query}`);
  await page.waitForFunction(() => Boolean(window.offlineFixtureReady));
}
