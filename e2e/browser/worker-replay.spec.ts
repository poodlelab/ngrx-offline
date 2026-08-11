import { APIRequestContext, Page, expect, test } from '@playwright/test';

interface DemoCapability {
  readonly workspaceId: string;
  readonly secret: string;
}

test('worker completes the related queue after page close and the app consumes receipts', async ({
  context,
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome', 'Worker lifecycle coverage runs in Chrome.');

  await page.goto('/ngrx-offline/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByRole('button', { name: 'Simulate offline' }).click();
  await page.getByRole('button', { name: 'Journal studio', exact: true }).click();
  await page.getByRole('button', { name: 'Save day to the journal' }).click();
  await expect(page.getByText('7 active')).toBeVisible();

  const capability = await readCapability(page);
  await page.getByRole('button', { name: 'Sync in worker' }).click();
  await expect(
    page.getByText('Worker sync started. You may close this page while it finishes.'),
  ).toBeVisible();
  await page.close();

  await expect.poll(() => remoteEntityCount(request, capability), { timeout: 15_000 }).toBe(7);

  const reopened = await context.newPage();
  await reopened.goto('/ngrx-offline/');
  await reopened.getByRole('button', { name: 'Sync Center', exact: true }).click();
  await expect(reopened.locator('.id-map code:last-child')).toHaveCount(7);
  expect(await reopened.locator('.id-map code:last-child').allTextContents()).not.toContain(
    'waiting',
  );
});

test('worker and foreground replay do not deliver an operation twice', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome', 'Worker lifecycle coverage runs in Chrome.');

  await page.goto('/ngrx-offline/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByRole('button', { name: 'Simulate offline' }).click();
  await page.getByRole('button', { name: 'Journal studio', exact: true }).click();
  await page.getByRole('button', { name: 'Save day to the journal' }).click();
  const capability = await readCapability(page);

  await page.getByRole('button', { name: 'Sync in worker' }).click();
  await page.getByRole('button', { name: 'Restore connection' }).click();

  await expect.poll(() => remoteEntityCount(request, capability), { timeout: 15_000 }).toBe(7);
  await expect(page.locator('.id-map code:last-child')).toHaveCount(7);
  expect(await page.locator('.id-map code:last-child').allTextContents()).not.toContain('waiting');
  expect(await remoteEntityCount(request, capability)).toBe(7);
});

async function readCapability(page: Page): Promise<DemoCapability> {
  return page.evaluate(() => {
    const value = localStorage.getItem('ngrx-offline-showcase-workspace');
    if (value === null) throw new Error('Demo capability was not created.');
    return JSON.parse(value) as DemoCapability;
  });
}

async function remoteEntityCount(
  request: APIRequestContext,
  capability: DemoCapability,
): Promise<number> {
  const response = await request.get('http://127.0.0.1:8787/v1/snapshot', {
    headers: {
      Authorization: `Bearer ${capability.workspaceId}.${capability.secret}`,
    },
  });
  if (!response.ok()) return 0;
  const snapshot = (await response.json()) as Record<string, unknown>;
  return ['trips', 'travelDays', 'placeVisits', 'memories', 'dayReflections'].reduce(
    (total, key) => total + (Array.isArray(snapshot[key]) ? snapshot[key].length : 0),
    0,
  );
}
