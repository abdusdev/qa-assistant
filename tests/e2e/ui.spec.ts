import { expect, test, type Page } from '@playwright/test';

/** Types into the form and starts a run. The demo AI and fixture tickets keep it offline. */
async function start(page: Page, mode: 'Ticket' | 'List' | 'Sprint' | 'Epic', value: string) {
  await page.goto('/');
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByLabel(new RegExp(`^${mode}`)).fill(value);
  await page.getByRole('button', { name: 'Generate test cases' }).click();
}

const draftBanner = (page: Page) => page.getByTestId('draft-banner');

test.describe('the web interface, offline', () => {
  test('has no banner across the top, and says AI draft next to the cases', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Generate test cases' })).toBeVisible();
    await expect(draftBanner(page)).toHaveCount(0);

    await start(page, 'Ticket', 'EVAL-1');
    await expect(page).toHaveURL(/#\/jobs\//);
    await expect(page.getByTestId('job-status')).toContainText('Finished');
    await expect(draftBanner(page)).toBeVisible();
    await expect(draftBanner(page)).toContainText('AI draft: needs QA review');
    await expect(
      page.getByRole('region', { name: 'Results' }).getByTestId('draft-banner'),
    ).toBeVisible();
  });

  test('shows the full ticket text that was fetched, with the run', async ({ page }) => {
    await start(page, 'Ticket', 'EVAL-1');
    await expect(page.getByTestId('job-status')).toContainText('Finished');

    const manifest = page.getByTestId('ticket-manifest');
    await expect(manifest).toBeVisible();
    await expect(manifest.getByText('Tickets fetched from Jira')).toBeVisible();
    const ticket = page.getByTestId('ticket-text-EVAL-1');
    await expect(ticket).toContainText('Bulk shipment creation for selected orders');
    await expect(ticket).toContainText('At most 100 orders can be selected for one bulk action.');
    await expect(ticket).toContainText('Acceptance criteria');
    await expect(ticket).toContainText('A courier outage leaves failed orders without shipments');
    await expect(ticket).toContainText('characters');
  });

  test('shows every ticket of a list run, each with its own text', async ({ page }) => {
    await start(page, 'List', 'EVAL-1 EVAL-2');
    await expect(page.getByTestId('job-status')).toContainText('Finished');

    await expect(page.getByTestId('ticket-text-EVAL-1')).toContainText('At most 100 orders');
    await expect(page.getByTestId('ticket-text-EVAL-2')).toContainText(
      'Rates are outdated. Fetch new rates before shipping this order.',
    );
  });

  test('the run timeline ends with every step done', async ({ page }) => {
    await start(page, 'Ticket', 'EVAL-1');
    await expect(page.getByTestId('job-status')).toContainText('Finished');

    const steps = page.getByTestId('run-timeline').getByRole('listitem');
    await expect(steps).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(steps.nth(i)).toHaveAttribute('data-state', 'done');
    }
  });

  test('a list with one missing ticket still shows the text of the ones that were found', async ({
    page,
  }) => {
    await start(page, 'List', 'EVAL-1 EVAL-99');

    await expect(page.getByTestId('job-status')).toContainText('Finished');
    await expect(page.getByTestId('ticket-text-EVAL-1')).toBeVisible();
  });

  test('a list run shows progress, then the cases grouped by flow step', async ({ page }) => {
    await start(page, 'List', 'EVAL-1 EVAL-2');

    await expect(page.getByTestId('job-status')).toContainText('Finished');
    await expect(page.getByRole('progressbar', { name: 'Tickets finished' })).toHaveAttribute(
      'aria-valuenow',
      '2',
    );
    await expect(page.getByText('EVAL-1', { exact: true }).first()).toBeVisible();

    const results = page.getByRole('region', { name: 'Results' });
    await expect(results.getByRole('group').first()).toBeVisible();
    await expect(results.getByText('1. Happy path')).toBeVisible();
    await expect(
      results.getByRole('heading', { name: /Check the main behaviour of EVAL-1/ }),
    ).toBeVisible();
    await expect(
      results.getByRole('heading', { name: /Check the main behaviour of EVAL-2/ }),
    ).toBeVisible();
    // A case shows its steps and expected result.
    await expect(results.getByText('Perform the action from the ticket').first()).toBeVisible();
    await expect(results.getByText('Expected result').first()).toBeVisible();
  });

  test('a missing key is a visible note and the other tickets still show', async ({ page }) => {
    await start(page, 'List', 'EVAL-1 EVAL-99');

    await expect(page.getByTestId('job-status')).toContainText('Finished');
    await expect(page.getByText('EVAL-99').first()).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Check the main behaviour of EVAL-1/ }),
    ).toBeVisible();
  });

  test('a run that fails shows why, and offers a way back', async ({ page }) => {
    await start(page, 'Ticket', 'EVAL-404');

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The run failed');
    await expect(alert).toContainText('EVAL-404');
    await page.getByRole('button', { name: 'Start another run' }).click();
    await expect(page.getByRole('heading', { name: 'Generate test cases' })).toBeVisible();
  });

  test('an empty form is refused with a message, without sending anything', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Generate test cases' }).click();

    await expect(page.getByRole('alert')).toHaveText('Enter a ticket key.');
    await expect(page).not.toHaveURL(/#\/jobs\//);
  });

  test('sprint and epic modes show the filters', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Issue types')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sprint', exact: true }).click();

    await expect(page.getByLabel('Issue types')).toBeVisible();
    await expect(page.getByLabel('Statuses')).toBeVisible();
    await expect(page.getByLabel('Most tickets')).toBeVisible();
  });

  test('the search narrows the cases and says how many are shown', async ({ page }) => {
    await start(page, 'List', 'EVAL-1 EVAL-2');
    await expect(page.getByTestId('job-status')).toContainText('Finished');

    await page.getByLabel('Search').fill('EVAL-2');

    await expect(page.getByText('Showing 2 of 4')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Check the main behaviour of EVAL-1/ }),
    ).toHaveCount(0);
  });

  test('a finished run is in the history and can be opened again', async ({ page }) => {
    await start(page, 'Ticket', 'EVAL-3');
    await expect(page.getByTestId('job-status')).toContainText('Finished');

    await page.getByRole('link', { name: 'New run' }).click();
    const history = page.getByRole('region', { name: 'Earlier runs' });
    await expect(history.getByRole('listitem').first()).toBeVisible();

    await history
      .getByRole('link', { name: /EVAL-3/ })
      .first()
      .click();

    await expect(page).toHaveURL(/#\/runs\//);
    await expect(draftBanner(page)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Check the main behaviour of EVAL-3/ }),
    ).toBeVisible();
  });

  test('an unknown run says so', async ({ page }) => {
    await page.goto('/#/runs/7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11');

    await expect(page.getByRole('alert')).toContainText('There is no such run');
  });

  test('a run that is no longer on the server says so', async ({ page }) => {
    await page.goto('/#/jobs/not-a-real-job');

    await expect(page.getByRole('alert')).toContainText('no longer on the server');
  });

  test('works on a phone-sized screen without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await start(page, 'List', 'EVAL-1 EVAL-2');
    await expect(page.getByTestId('job-status')).toContainText('Finished');

    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );

    expect(overflow).toBeLessThanOrEqual(0);
    await expect(draftBanner(page)).toBeVisible();
  });
});
