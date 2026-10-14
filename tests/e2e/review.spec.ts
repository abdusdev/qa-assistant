import { expect, test, type Page } from '@playwright/test';

/** Starts a run in the browser and opens it for review. Returns the address of the run page. */
async function reviewedRun(page: Page, value: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByLabel(/^List/).fill(value);
  await page.getByRole('button', { name: 'Generate test cases' }).click();
  await expect(page.getByTestId('job-status')).toContainText('Finished');
  await page.getByRole('link', { name: 'Review and edit these cases' }).click();
  await expect(page).toHaveURL(/#\/runs\//);
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible();
  return page.url();
}

const caseCard = (page: Page, code: string) => page.getByTestId(`case-${code}`);

test.describe('reviewing a run in the browser, offline', () => {
  test('an edit is saved and survives a reload', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1 EVAL-2');
    const card = caseCard(page, 'TC-1');

    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByLabel('Title').fill('Reworded by the reviewer');
    await card.getByLabel('Expected result').fill('A better expected result');
    await card.getByRole('button', { name: 'Save changes' }).click();

    await expect(card.getByRole('heading', { name: /Reworded by the reviewer/ })).toBeVisible();
    await expect(card.getByText('edited by QA')).toBeVisible();

    await page.reload();

    const again = caseCard(page, 'TC-1');
    await expect(again.getByRole('heading', { name: /Reworded by the reviewer/ })).toBeVisible();
    await expect(again.getByText('A better expected result')).toBeVisible();
    await expect(page.getByTestId('review-counts')).toContainText('1 edited');
  });

  test('a form that is not valid is refused with a reason and keeps what was typed', async ({
    page,
  }) => {
    await reviewedRun(page, 'EVAL-1');
    const card = caseCard(page, 'TC-1');

    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByLabel('Title').fill('abc');
    await card.getByRole('button', { name: 'Save changes' }).click();

    await expect(card.getByRole('alert')).toContainText('at least 5 characters');
    await expect(card.getByLabel('Title')).toHaveValue('abc');
  });

  test('a case can be added, then deleted, then restored', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1');

    await page.getByRole('button', { name: 'Add a case' }).click();
    const form = page.getByRole('form', { name: 'Edit case' });
    await form.getByLabel('Title').fill('A case QA wrote by hand');
    await form.getByLabel('Steps').fill('Open the page\nDo the thing');
    await form.getByLabel('Expected result').fill('The thing happens');
    await form.getByRole('button', { name: 'Add the case' }).click();

    const added = page.getByRole('article').filter({ hasText: 'A case QA wrote by hand' });
    await expect(added).toBeVisible();
    await expect(added.getByText('added by QA')).toBeVisible();
    await expect(page.getByTestId('review-counts')).toContainText('1 added');

    await added.getByRole('button', { name: 'Delete' }).click();
    await expect(added).toHaveCount(0);
    await page.getByText(/Deleted cases \(1\)/).click();
    await page.getByRole('button', { name: 'Restore' }).click();

    await expect(
      page.getByRole('article').filter({ hasText: 'A case QA wrote by hand' }),
    ).toBeVisible();
  });

  test('approving counts cases, and approve all approves the rest', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1 EVAL-2');
    const summary = page.getByTestId('review-summary');
    await expect(summary).toContainText('0 of 4 approved');

    await caseCard(page, 'TC-1').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(summary).toContainText('1 of 4 approved');
    await expect(caseCard(page, 'TC-1').getByRole('button', { name: 'Approved' })).toBeVisible();

    await page.getByRole('button', { name: 'Approve all' }).click();
    await expect(summary).toContainText('4 of 4 approved');
  });

  test('editing an approved case takes the approval back', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1');
    const card = caseCard(page, 'TC-1');
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Approved' })).toBeVisible();

    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByLabel('Expected result').fill('Changed after it was approved');
    await card.getByRole('button', { name: 'Save changes' }).click();

    await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  });

  test('a case moves up and down inside its step', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1');
    const codes = () =>
      page
        .getByRole('article')
        .evaluateAll((nodes) =>
          nodes.map((node) => /^TC-[0-9]+/.exec(node.querySelector('h4')?.textContent ?? '')?.[0]),
        );
    expect(await codes()).toEqual(['TC-1', 'TC-2']);

    await caseCard(page, 'TC-2').getByRole('button', { name: 'Move TC-2 up' }).click();

    await expect.poll(codes).toEqual(['TC-2', 'TC-1']);
    await expect(
      caseCard(page, 'TC-2').getByRole('button', { name: 'Move TC-2 up' }),
    ).toBeDisabled();
  });

  test('downloads contain the edited version and the AI draft notice', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1 EVAL-2');
    const card = caseCard(page, 'TC-1');
    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByLabel('Title').fill('Reworded for the download');
    await card.getByRole('button', { name: 'Save changes' }).click();
    await expect(card.getByRole('heading', { name: /Reworded for the download/ })).toBeVisible();

    const link = (name: string) => page.getByRole('link', { name, exact: true });
    const markdown = await page.request.get((await link('Markdown').getAttribute('href'))!);
    const csv = await page.request.get((await link('CSV (Excel)').getAttribute('href'))!);
    const word = await page.request.get((await link('Word').getAttribute('href'))!);

    expect(markdown.ok()).toBe(true);
    const md = await markdown.text();
    expect(md).toContain('AI draft: needs QA review');
    // The tickets come first, with their full text, before any case.
    expect(md).toContain('## Tickets covered');
    expect(md).toContain('### EVAL-1: Bulk shipment creation for selected orders');
    expect(md).toContain('At most 100 orders can be selected for one bulk action.');
    expect(md.indexOf('## Tickets covered')).toBeLessThan(md.indexOf('### TC-1'));
    expect(md).toContain('Reworded for the download');
    expect(md).toContain('Edited by QA');
    expect(await csv.text()).toContain('Reworded for the download');
    expect(word.headers()['content-type']).toContain('wordprocessingml');
    expect((await word.body()).subarray(0, 2).toString()).toBe('PK');
  });

  test('"approved cases only" changes the download links', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1');
    await caseCard(page, 'TC-1').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByTestId('review-summary')).toContainText('1 of 2 approved');

    await page.getByLabel('Approved cases only').check();
    const href = await page
      .getByRole('link', { name: 'Markdown', exact: true })
      .getAttribute('href');

    expect(href).toContain('approved=true');
    const text = await (await page.request.get(href!)).text();
    expect(text).toContain('### TC-1:');
    expect(text).not.toContain('### TC-2:');
  });

  test('writing one ticket again replaces its cases and leaves the other ticket', async ({
    page,
  }) => {
    await reviewedRun(page, 'EVAL-1 EVAL-2');
    await expect(page.getByTestId('review-counts')).toContainText('4 kept');

    const ticketRow = page.getByRole('region', { name: 'Tickets' }).getByRole('listitem').first();
    await ticketRow.getByRole('button', { name: /again/ }).click();
    await expect(page.getByRole('alertdialog')).toContainText('replaces the AI');
    await page.getByRole('button', { name: 'Replace the cases' }).click();

    await expect(page.getByText(/was written again/)).toBeVisible();
    // EVAL-1's two cases were swapped for two new ones; EVAL-2's cases are untouched.
    await expect(page.getByTestId('review-counts')).toContainText('2 deleted');
    await expect(page.getByText(/Deleted cases \(2\)/)).toBeVisible();
    await expect(caseCard(page, 'TC-5')).toBeVisible();
    await expect(caseCard(page, 'TC-3')).toBeVisible();
  });

  test('the person can change their mind before writing a ticket again', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1');
    const ticketRow = page.getByRole('region', { name: 'Tickets' }).getByRole('listitem').first();

    await ticketRow.getByRole('button', { name: /again/ }).click();
    await page.getByRole('button', { name: 'Keep what I have' }).click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByTestId('review-counts')).toContainText('0 deleted');
  });

  test('the draft banner stays on the review page', async ({ page }) => {
    await reviewedRun(page, 'EVAL-1');

    await expect(page.getByTestId('draft-banner')).toContainText('AI draft: needs QA review');
  });
});
