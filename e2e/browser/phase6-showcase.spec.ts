import { expect, test } from '@playwright/test';

test('teaches the complete relationship scenario and survives an offline reload', async ({
  context,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome', 'Service-worker reload coverage runs in Chrome.');

  await page.goto('/ngrx-offline/');
  await expect(
    page.getByRole('heading', { name: 'Build an offline travel journal with NgRx' }),
  ).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);

  await page.getByRole('button', { name: 'Journal studio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create related records offline' })).toBeVisible();
  await page.getByRole('button', { name: 'Save day to the journal' }).click();

  await expect(page.getByText('7 active')).toBeVisible();
  await expect(page.getByText('Lisbon in the margins')).toBeVisible();
  await expect(page.getByText('A slow morning in Alfama')).toBeVisible();
  await expect(page.getByText('Miradouro da Senhora do Monte')).toBeVisible();
  await expect(page.locator('.id-map code', { hasText: 'waiting' })).toHaveCount(7);

  await page.reload();
  await expect(page.getByRole('button', { name: /Sync Center 7/ })).toBeVisible();
  await page.getByRole('button', { name: /Sync Center 7/ }).click();
  await expect(page.getByText('7 active')).toBeVisible();
  await expect(page.getByText('Lisbon in the margins')).toBeVisible();

  await context.setOffline(false);
});

test('automatically synchronizes a newly saved journal while online', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome', 'The live demo API journey runs once in Chrome.');

  await page.goto('/ngrx-offline/');
  await page.getByRole('button', { name: 'Journal studio', exact: true }).click();
  await page.getByRole('button', { name: 'Save day to the journal' }).click();
  await page.getByRole('button', { name: /Sync Center/ }).click();

  await expect(page.getByText('0 active')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.sync-summary').getByText('7', { exact: true })).toBeVisible();
  await expect(page.locator('.id-map code', { hasText: 'waiting' })).toHaveCount(0);
});

test('has a responsive, keyboard-operable documentation surface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ngrx-offline/');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Learn' }).click();
  await expect(page.getByRole('heading', { name: 'How the example works' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Reference a record created offline' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
