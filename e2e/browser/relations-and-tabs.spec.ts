import { expect, test } from '@playwright/test';

test('resolves a four-level relationship chain with numeric server IDs', async ({ page }) => {
  await page.goto('/e2e/browser/foreground-fixture.html?reset');
  await page.waitForFunction(() => Boolean(window.offlineFixtureReady));
  await page.evaluate(() => window.offlineFixture.queueRelations());
  await page.evaluate(() => window.offlineFixture.reconnectAndSync());
  const snapshot = await page.evaluate(() => window.offlineFixture.snapshot());

  expect(snapshot.operations).toEqual([]);
  expect(snapshot.transportCalls.map((call) => call.body)).toEqual([
    { clientId: 'trip-local' },
    { clientId: 'travel-day-local', tripId: 101 },
    { clientId: 'place-local', travelDayId: 202 },
    { clientId: 'memory-local', placeVisitId: 303 },
  ]);
  expect(snapshot.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'trip:trip-local', value: 101 }),
      expect.objectContaining({ key: 'travel-day:travel-day-local', value: 202 }),
      expect.objectContaining({ key: 'place-visit:place-local', value: 303 }),
      expect.objectContaining({ key: 'memory:memory-local', value: 404 }),
    ]),
  );
});

test('two real pages cannot transport the same scoped operation concurrently', async ({
  context,
  page,
}) => {
  await page.goto('/e2e/browser/foreground-fixture.html?reset');
  await page.waitForFunction(() => Boolean(window.offlineFixtureReady));
  await page.evaluate(() => window.offlineFixture.queue());
  const secondPage = await context.newPage();
  await secondPage.goto('/e2e/browser/foreground-fixture.html');
  await secondPage.waitForFunction(() => Boolean(window.offlineFixtureReady));
  await page.evaluate(() => {
    window.offlineFixture.setOnline(true);
    window.offlineFixture.holdTransport();
    window.offlineFixture.startSync();
  });
  await expect
    .poll(async () => (await page.evaluate(() => window.offlineFixture.snapshot())).transportCalls)
    .toHaveLength(1);
  await secondPage.evaluate(() => {
    window.offlineFixture.setOnline(true);
    window.offlineFixture.startSync();
  });
  await secondPage.waitForTimeout(50);
  expect(
    (await secondPage.evaluate(() => window.offlineFixture.snapshot())).transportCalls,
  ).toHaveLength(0);

  await page.evaluate(() => window.offlineFixture.releaseTransport());
  await page.evaluate(() => window.offlineFixture.awaitSync());
  await secondPage.evaluate(() => window.offlineFixture.awaitSync());
  const totalCalls =
    (await page.evaluate(() => window.offlineFixture.snapshot())).transportCalls.length +
    (await secondPage.evaluate(() => window.offlineFixture.snapshot())).transportCalls.length;
  expect(totalCalls).toBe(1);
  await secondPage.close();
});
