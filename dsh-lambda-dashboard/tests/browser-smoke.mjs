import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const assets = {
  '/react.js': path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.production.min.js'),
  '/react-dom.js': path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.production.min.js'),
  '/client.js': fileURLToPath(new URL('../lib/client.js', import.meta.url)),
};
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>window.__ModuleLoader__={load(row){window.plugin=row.factory(()=>React)}}</script>
<script src="/client.js"></script><script>
plugin.apply({effect(fn){fn()},slots:{inject(name,fn){return fn()},register(options,component){if(options.name==='main')ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(component));return ()=>{}}}});
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader('content-type', assets[request.url] ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(assets[request.url] ? fs.readFileSync(assets[request.url]) : html);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const temporaryRoot = path.resolve(process.env.TEMP_TEST_ROOT ?? os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, 'dsh-lambda-browser-test-'));
const browser = spawn(process.env.EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
const browserExit = once(browser, 'exit');
let sequence = 0;
let buffer = Buffer.alloc(0);
const pending = new Map();
browser.stdio[4].on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let boundary;
  while ((boundary = buffer.indexOf(0)) >= 0) {
    const message = JSON.parse(buffer.subarray(0, boundary).toString());
    buffer = buffer.subarray(boundary + 1);
    const task = pending.get(message.id);
    if (!task) continue;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(Error(`CDP ${message.error.code}`));
    else task.resolve(message.result);
  }
});
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
try {
  const target = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` }, sessionId);
  const result = await command('Runtime.evaluate', {
    expression: `new Promise((resolve,reject)=>{const deadline=Date.now()+5000;function check(){if(document.querySelector('header')){resolve({title:document.querySelector('strong').textContent,url:document.querySelector('a').href,buttons:document.querySelectorAll('button').length,warning:document.body.textContent.includes('明文传输风险'),fallback:document.querySelector('[role=alert]').textContent,frames:document.querySelectorAll('iframe,webview').length});return}if(Date.now()>deadline){reject(Error('page not rendered'));return}setTimeout(check,50)}check()})`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  assert.ok(!result.exceptionDetails);
  assert.equal(result.result.value.title, 'Lambda额度管理');
  assert.equal(result.result.value.url, 'http://47.115.165.231:30179/');
  assert.equal(result.result.value.buttons, 0);
  assert.equal(result.result.value.warning, false);
  assert.ok(result.result.value.fallback.includes('浏览器模式请独立打开'));
  assert.equal(result.result.value.frames, 0);
  console.log('BROWSER_SMOKE_PASSED: real React rendering, HTTP-only URL, no warning banner, browser fallback');
} finally {
  try { await command('Browser.close'); } catch { browser.kill(); }
  await browserExit;
  for (const task of pending.values()) clearTimeout(task.timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(path.resolve(profile)), temporaryRoot);
  assert.ok(path.basename(profile).startsWith('dsh-lambda-browser-test-'));
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('CLEANUP_PASSED: browser, fixture server, temporary profile closed');
}
