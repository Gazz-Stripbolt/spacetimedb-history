// Browser tests: the demo page in headless Chromium, two people editing one board.
//
//   PAGE=http://127.0.0.1:3000/v1/database/hist-rust/route/ npx tsx tests/browser.test.mts
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

const PAGE = process.env.PAGE ?? 'http://127.0.0.1:3000/v1/database/hist-rust/route/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const browser = await chromium.launch();
async function open(): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${PAGE}${PAGE.includes('?') ? '&' : '?'}fresh=1&test=1`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('connected'));
  return page;
}
const noteCount = (p: Page) => p.locator('#board .note').count();
const notePos = (p: Page, i: number) => p.locator('#board .note').nth(i).evaluate((d) => [d.style.left, d.style.top]);

try {
  const ada = await open();
  const bo = await open();
  const start = await noteCount(ada);

  await test('adding a note shows up for everyone, with an activity entry', async () => {
    await ada.click('#add');
    await bo.waitForFunction((n) => document.querySelectorAll('#board .note').length === n + 1, start);
    await bo.waitForSelector('.entry >> text=added');
  });

  await test('drag to move, then Undo/Redo buttons put it back and forward again', async () => {
    const note = ada.locator('#board .note').last();
    const before = await note.evaluate((d) => [d.style.left, d.style.top]);
    const box = (await note.boundingBox())!;
    await ada.mouse.move(box.x + 20, box.y + 20);
    await ada.mouse.down();
    await ada.mouse.move(box.x + 140, box.y + 90, { steps: 5 });
    await ada.mouse.up();
    await ada.waitForFunction(() => document.querySelector('#undo')?.textContent === 'Undo move notes');
    await sleep(200);
    const moved = await notePos(ada, (await noteCount(ada)) - 1);
    assert.notDeepEqual(moved, before);
    await ada.click('#undo');
    await ada.waitForFunction(() => document.querySelector('#redo')?.textContent === 'Redo move notes');
    await sleep(200);
    assert.deepEqual(await notePos(bo, (await noteCount(bo)) - 1), before, 'back where it was, for Bo too');
    await ada.click('#redo');
    await sleep(400);
    assert.deepEqual(await notePos(bo, (await noteCount(bo)) - 1), moved);
  });

  await test('the time slider shows the board as it was, then returns to live', async () => {
    await ada.$eval('#time', (s: HTMLInputElement) => {
      s.value = '0';
      s.dispatchEvent(new Event('input'));
    });
    await ada.waitForSelector('#board.past');
    await sleep(300);
    assert.ok((await noteCount(ada)) <= start, 'the earliest moment has none of the new notes');
    await ada.click('#live');
    await ada.waitForSelector('#board:not(.past)');
    assert.equal(await noteCount(ada), start + 1);
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed`);
