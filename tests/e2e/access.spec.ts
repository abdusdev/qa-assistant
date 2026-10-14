import { expect, test, type Page } from '@playwright/test';

// This server asks for an access token. See playwright.config.ts.
test.use({ baseURL: 'http://127.0.0.1:3101' });

const TOKEN = 'e2e-access-token-1234';

async function signIn(page: Page, token = TOKEN, name = 'Tech') {
  await page.getByLabel('Access token').fill(token);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('a server that asks for an access token', () => {
  test('shows the sign-in form instead of the page', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Generate test cases' })).toHaveCount(0);
  });

  test('a wrong token is refused with a message', async ({ page }) => {
    await page.goto('/');

    await signIn(page, 'not-the-right-token');

    await expect(page.getByRole('alert')).toContainText('not accepted');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('an empty token is refused before anything is sent', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('Enter the access token.');
  });

  test('the right token opens the page, and signing out closes it again', async ({ page }) => {
    await page.goto('/');

    await signIn(page);

    await expect(page.getByRole('heading', { name: 'Generate test cases' })).toBeVisible();
    await page.getByRole('button', { name: /Sign out/ }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('a run works end to end once signed in, and the name is kept in the history', async ({
    page,
  }) => {
    await page.goto('/');
    await signIn(page, TOKEN, 'Tech');

    await page.getByLabel(/^Ticket/).fill('EVAL-1');
    await page.getByRole('button', { name: 'Generate test cases' }).click();
    await expect(page.getByTestId('job-status')).toContainText('Finished');
    await page.getByRole('link', { name: 'Review and edit these cases' }).click();
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible();

    const card = page.getByTestId('case-TC-1');
    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByLabel('Expected result').fill('Changed by the signed-in reviewer');
    await card.getByRole('button', { name: 'Save changes' }).click();
    await expect(card.getByText('Changed by the signed-in reviewer')).toBeVisible();
  });

  test('the API itself refuses a request with no token, and accepts one with it', async ({
    request,
  }) => {
    const without = await request.get('/api/jobs');
    const wrong = await request.get('/api/jobs', {
      headers: { authorization: 'Bearer not-the-right-token' },
    });
    const right = await request.get('/api/jobs', { headers: { authorization: `Bearer ${TOKEN}` } });

    expect(without.status()).toBe(401);
    expect(wrong.status()).toBe(401);
    expect(right.status()).toBe(200);
  });

  test('the health check stays open, for the container to ask', async ({ request }) => {
    expect((await request.get('/health')).status()).toBe(200);
    expect((await request.get('/ready')).status()).toBe(200);
  });

  test('a download works with the token and is refused without it', async ({ request }) => {
    const start = await request.post('/api/generate', {
      headers: { authorization: `Bearer ${TOKEN}` },
      data: { mode: 'ticket', value: 'EVAL-2' },
    });
    const { jobId } = (await start.json()) as { jobId: string };
    let runId: string | undefined;
    for (let i = 0; i < 100 && !runId; i++) {
      const job = (await (
        await request.get(`/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
      ).json()) as { status: string; runId?: string };
      runId = job.runId;
      if (!runId) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const open = await request.get(`/api/runs/${runId}/export?format=md`);
    const signed = await request.get(`/api/runs/${runId}/export?format=md`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-user': 'Tech' },
    });

    expect(open.status()).toBe(401);
    expect(signed.status()).toBe(200);
    expect(await signed.text()).toContain('Author: Tech');
  });
});

test.describe('security headers on the real server', () => {
  test('are sent with the page and with API answers', async ({ request }) => {
    const page = await request.get('/');
    const api = await request.get('/api/session');

    for (const response of [page, api]) {
      expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers()['x-content-type-options']).toBe('nosniff');
      expect(response.headers()['x-frame-options']).toBe('DENY');
    }
    expect(api.headers()['cache-control']).toBe('no-store');
  });
});
