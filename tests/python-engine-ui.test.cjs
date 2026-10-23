const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
let browser, page, errors;
before(async () => {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});
after(async () => { await browser?.close(); });
beforeEach(async () => {
    page = await browser.newPage();
    errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://acas-server.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
        const file = path.join(__dirname, '..', 'appServer/ui', relative);
        const contentType = relative.endsWith('.js') ? 'text/javascript' :
            relative.endsWith('.css') ? 'text/css' : relative.endsWith('.html') ? 'text/html' : 'application/octet-stream';
        try { await route.fulfill({ contentType, body: await fs.readFile(file) }); }
        catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.addInitScript(() => {
        const noop = () => {};
        window.added = [];
        window.pickedPath = 'C:\\Chess tools\\maia2_uci.py';
        window.engineAPI = {
            getSavedEngines: async () => [],
            addEngine: async (...args) => { window.added.push(args); return true; },
            onRenderEngineGrid: noop, onAddConsoleView: noop, onRemoveConsoleView: noop,
            onRefreshEngineCards: noop, onLog: noop
        };
        window.serverAPI = { sendEnginesList: async () => {}, onListening: noop,
            onClientChange: noop, onUnauthorized: noop };
        window.fileAPI = { pickFile: async () => window.pickedPath };
        window.electronAPI = { getVersion: async () => 'test' };
        window.toastAPI = { onMessage: noop };
    });
    await page.goto('http://acas-server.test/');
});
afterEach(async () => {
    await page.close();
    assert.deepEqual(errors, []);
});

test('Python picker asks for interpreter and passes its full path unchanged', async () => {
    await page.click('#addEngineBtn');
    await page.fill('#acas-input', 'C:\\My Python\\python.exe');
    await page.click('#acas-ok');
    await page.waitForFunction(() => document.querySelector('#acas-message').textContent === 'Engine name:');
    await page.fill('#acas-input', 'Maia-2 Python');
    await page.click('#acas-ok');
    await page.waitForFunction(() => window.added.length === 1);
    assert.deepEqual(await page.evaluate(() => window.added[0]), [
        { name: 'maia2_uci.py', path: 'C:\\Chess tools\\maia2_uci.py', pythonExecutable: 'C:\\My Python\\python.exe' },
        'Maia-2 Python'
    ]);
});

test('canceling interpreter prompt adds nothing', async () => {
    await page.click('#addEngineBtn');
    await page.click('#acas-cancel');
    assert.deepEqual(await page.evaluate(() => window.added), []);
    assert.equal(await page.locator('dialog[open]').count(), 0);
});

test('native engine skips Python prompt and remains compatible', async () => {
    await page.evaluate(() => { window.pickedPath = 'C:\\Engines\\stockfish.exe'; });
    await page.click('#addEngineBtn');
    assert.equal(await page.textContent('#acas-message'), 'Engine name:');
    await page.click('#acas-ok');
    await page.waitForFunction(() => window.added.length === 1);
    assert.deepEqual(await page.evaluate(() => window.added[0]), [
        { name: 'stockfish.exe', path: 'C:\\Engines\\stockfish.exe' }, 'stockfish.exe'
    ]);
});

test('canceling name prompt does not add a native engine', async () => {
    await page.evaluate(() => { window.pickedPath = '/home/user/stockfish'; });
    await page.click('#addEngineBtn');
    await page.click('#acas-cancel');
    assert.deepEqual(await page.evaluate(() => window.added), []);
});
