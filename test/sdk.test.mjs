import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defineElements } from '../dist/index.js';
import { createIlluna } from '../dist/server.js';
import { sqliteStorage } from '../dist/storage/sqlite.js';

const definitions = defineElements({
  'normal.title': { pages: ['normal'], description: 'Normal calculator heading', valueType: 'string', defaultValue: 'Calculator', constraints: { maxLength: 40 } },
  'normal.size': { pages: ['normal'], description: 'Font size in pixels', valueType: 'number', defaultValue: 16, constraints: { min: 14, max: 28 } },
  'normal.hint': { pages: ['normal'], description: 'Show the help text', valueType: 'boolean', defaultValue: true },
  'scientific.title': { pages: ['scientific'], description: 'Scientific calculator heading', valueType: 'string', defaultValue: 'Scientific' },
});
const alice = { userId: 'alice', sessionId: 'session-a' };
const bob = { userId: 'bob', sessionId: 'session-b' };
const response = updates => ({ message: 'Proposed changes', updates: updates.map(([id, new_value]) => ({ id, field: 'Value', new_value })) });
async function setup(t, transport, elements = definitions) {
  const sdk = createIlluna({ appId: 'test', elements, storage: sqliteStorage(':memory:'), transport });
  await sdk.initialize(); t.after(() => sdk.close()); return sdk;
}
test('adapt sends current page descriptions, types, defaults and latest values, then persists typed updates', async t => {
  let sent;
  const sdk = await setup(t, async payload => { sent = payload; return response([['normal.size', '22'], ['normal.hint', 'false']]); });
  await sdk.setValue(alice, { pageId: 'normal', revision: 0, id: 'normal.title', value: 'My calculator' });
  const result = await sdk.adapt(alice, { pageId: 'normal', revision: 1, message: 'Larger, no hint' });
  assert.equal(sent.contract_version, 'illuna.ui.v1');
  assert.deepEqual(Object.keys(sent.ui_elements).sort(), ['normal.hint', 'normal.size', 'normal.title']);
  assert.deepEqual(sent.ui_elements['normal.size'], { description: 'Font size in pixels', type: 'number', value: 16, default_value: 16, constraints: { min: 14, max: 28 } });
  assert.equal(sent.ui_elements['normal.title'].value, 'My calculator');
  assert.equal(sent.user_id, 'alice'); assert.equal(sent.page_id, 'normal');
  assert.equal(result.values['normal.size'], 22); assert.equal(result.values['normal.hint'], false);
  assert.equal(result.applied.length, 2);
  assert.equal((await sdk.getState(bob, 'normal')).values['normal.size'], 16);
  assert.deepEqual((await sdk.getState(alice, 'scientific')).values, { 'scientific.title': 'Scientific' });
});
test('explicit global definitions join the page; inactive pages never do', async t => {
  let sent;
  const sdk = await setup(t, async p => { sent = p; return response([]); }, { ...definitions, 'global.tone': { pages: ['*'], description: 'Global tone', valueType: 'string', defaultValue: 'neutral' } });
  await sdk.adapt(alice, { pageId: 'scientific', revision: 0, message: 'Hello' });
  assert.deepEqual(Object.keys(sent.ui_elements).sort(), ['global.tone', 'scientific.title']);
});
test('out-of-page, invalid type, out-of-range and conflicting duplicates reject the whole batch', async t => {
  for (const bad of [
    response([['normal.title', 'Changed'], ['scientific.title', 'Hacked']]),
    response([['normal.size', 99]]), response([['normal.hint', 'yes']]),
    response([['normal.title', 'One'], ['normal.title', 'Two']]),
    { message: 'Bad', updates: [{ id: 'normal.title', field: 'description', new_value: 'Changed' }] },
    { message: 'Incomplete' }, null,
  ]) {
    const sdk = await setup(t, async () => bad);
    await assert.rejects(sdk.adapt(alice, { pageId: 'normal', revision: 0, message: 'Change' }));
    const state = await sdk.getState(alice, 'normal');
    assert.equal(state.values['normal.title'], 'Calculator'); assert.equal(state.revision, 0);
  }
});
test('a late model response cannot overwrite newer settings', async t => {
  let finish, entered;
  const started = new Promise(r => { entered = r; });
  const sdk = await setup(t, () => new Promise(r => { finish = r; entered(); }));
  const pending = sdk.adapt(alice, { pageId: 'normal', revision: 0, message: 'Rename' });
  await started;
  await sdk.setValue(alice, { pageId: 'normal', revision: 0, id: 'normal.title', value: 'Newer choice' });
  finish(response([['normal.title', 'Old response']]));
  await assert.rejects(pending, { code: 'CONFLICT' });
  assert.equal((await sdk.getState(alice, 'normal')).values['normal.title'], 'Newer choice');
});
test('persistent overrides survive restart/default changes, while reset uses the new default', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'illuna-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'ui.sqlite');
  const make = elements => createIlluna({ appId: 'test', elements, storage: sqliteStorage(filename), transport: async () => response([]) });
  const first = make(definitions); await first.initialize();
  await first.setValue(alice, { pageId: 'normal', revision: 0, id: 'normal.title', value: 'Personal' }); await first.close();
  const second = make({ ...definitions, 'normal.title': { ...definitions['normal.title'], defaultValue: 'New default' } });
  await second.initialize();
  assert.equal((await second.getState(alice, 'normal')).values['normal.title'], 'Personal');
  assert.equal((await second.getState(bob, 'normal')).values['normal.title'], 'New default');
  const revision = (await second.getState(alice, 'normal')).revision;
  await second.reset(alice, { pageId: 'normal', revision });
  assert.equal((await second.getState(alice, 'normal')).values['normal.title'], 'New default'); await second.close();
});
test('HTTP handler binds identity and catalog server-side, and enforces authorization and JSON', async t => {
  let sent;
  const sdk = await setup(t, async p => { sent = p; return response([]); });
  const handler = sdk.createNodeHandler({ getIdentity: req => req.headers.authorization === 'test' ? alice : null, authorizePage: (_, page) => page === 'normal' });
  const server = createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/illuna`;
  assert.equal((await fetch(url + '/state?pageId=normal')).status, 401);
  assert.equal((await fetch(url + '/state?pageId=scientific', { headers: { authorization: 'test' } })).status, 403);
  const post = (body, more = {}) => fetch(url + '/adapt', { method: 'POST', headers: { authorization: 'test', 'content-type': 'application/json', ...more }, body: JSON.stringify(body) });
  const result = await post({ pageId: 'normal', revision: 0, message: 'Hello', user_id: 'bob', ui_elements: { 'scientific.title': 'Fake' } });
  assert.equal(result.status, 200); assert.equal(sent.user_id, 'alice'); assert.ok(!Object.hasOwn(sent.ui_elements, 'scientific.title'));
  assert.equal((await post({ pageId: 'normal', revision: 0, message: 'Hi' }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post({}, { 'content-type': 'text/plain' })).status, 415);
});
test('upstream failures and unknown pages make no changes', async t => {
  const sdk = await setup(t, async () => { throw new Error('private connection details'); });
  await assert.rejects(sdk.adapt(alice, { pageId: 'normal', revision: 0, message: 'Hello' }), { code: 'UPSTREAM_ERROR', message: 'Illuna could not be reached' });
  await assert.rejects(sdk.getState(alice, 'unknown'), { code: 'UNKNOWN_PAGE' });
  assert.equal((await sdk.getState(alice, 'normal')).revision, 0);
});
