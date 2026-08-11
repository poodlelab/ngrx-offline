import { expect, test } from '@playwright/test';

test('serializes two pages through the IndexedDB lease when Web Locks are disabled', async ({
  context,
  page,
}) => {
  await page.goto('/e2e/browser/foreground-fixture.html?reset&noLocks');
  await page.waitForFunction(() => Boolean(window.phase3Ready));
  await page.evaluate(() => window.phase3Fixture.queue());
  const secondPage = await context.newPage();
  await secondPage.goto('/e2e/browser/foreground-fixture.html?noLocks');
  await secondPage.waitForFunction(() => Boolean(window.phase3Ready));

  await page.evaluate(() => {
    window.phase3Fixture.setOnline(true);
    window.phase3Fixture.holdTransport();
    window.phase3Fixture.startSync();
  });
  await expect
    .poll(async () => (await page.evaluate(() => window.phase3Fixture.snapshot())).transportCalls)
    .toHaveLength(1);
  await secondPage.evaluate(() => {
    window.phase3Fixture.setOnline(true);
    window.phase3Fixture.startSync();
  });
  await secondPage.waitForTimeout(75);
  expect((await secondPage.evaluate(() => window.phase3Fixture.snapshot())).transportCalls).toEqual(
    [],
  );

  await page.evaluate(() => window.phase3Fixture.releaseTransport());
  await Promise.all([
    page.evaluate(() => window.phase3Fixture.awaitSync()),
    secondPage.evaluate(() => window.phase3Fixture.awaitSync()),
  ]);
  const calls =
    (await page.evaluate(() => window.phase3Fixture.snapshot())).transportCalls.length +
    (await secondPage.evaluate(() => window.phase3Fixture.snapshot())).transportCalls.length;
  expect(calls).toBe(1);
});

test('detects Background Sync as an optional Chrome capability', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome', 'Background Sync is asserted in stable Chrome.');
  await page.goto('/ngrx-offline/');
  const supported = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const sync = (
      registration as ServiceWorkerRegistration & {
        readonly sync?: { register(tag: string): Promise<void> };
      }
    ).sync;
    return typeof sync?.register === 'function';
  });
  expect(supported).toBe(true);
});

test('supports touch navigation at the configured mobile viewport', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Mobile project only.');
  await page.goto('/ngrx-offline/');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await page.getByRole('button', { name: 'Learn' }).tap();
  await expect(page.getByRole('heading', { name: 'How the example works' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
});
