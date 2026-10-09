import { expect, test } from '@playwright/test';

test('the app starts and reports healthy', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: 'ok' });
});
