import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
function functionSource(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

for (const path of ['/', '/u/amigo', '/c/current/clipes']) {
  test(`navigation to ${path} keeps the connected room and broadcast`, async () => {
    let disconnected = 0;
    const context = {
      location: { pathname: path, search: '' }, URLSearchParams,
      state: { me: {}, room: {}, channel: { id: 'current' }, local: { video: {} } },
      $: () => ({ pause() {} }),
      leave: async () => { disconnected++; },
      showHome() {}, showProfile() {}, showClipsPage() {},
    };
    vm.createContext(context);
    vm.runInContext(functionSource('async function route()', '// ---------------- login'), context);
    await context.route();
    assert.equal(disconnected, 0);
    assert.ok(context.state.local.video);
  });
}

test('switching to a different channel disconnects the previous room', async () => {
  let disconnected = 0;
  const context = {
    location: { pathname: '/c/other', search: '' }, URLSearchParams,
    state: { me: {}, room: {}, channel: { id: 'current' } },
    $: () => ({ pause() {} }), leave: async () => { disconnected++; }, showChannel() {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource('async function route()', '// ---------------- login'), context);
  await context.route();
  assert.equal(disconnected, 1);
});

test('opening a channel connects without a second click', async () => {
  let joined = 0;
  const context = {
    state: { channel: { id: 'only', name: 'Único servidor' } }, document: {},
    $: () => ({}), fillMark() {}, show() {}, renderClipShelf() {},
    loadChannel: async () => true, refreshJoinStatus() {}, join: async () => { joined++; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('async function showChannel(', 'async function refreshJoinStatus('), context);
  await context.showChannel('only');
  assert.equal(joined, 1);
});

test('returning to the connected channel does not reconnect', async () => {
  let joined = 0;
  const context = {
    state: { room: {}, channel: { id: 'only', name: 'Único servidor' } }, document: {},
    show() {}, renderClipShelf() {}, join: async () => { joined++; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('async function showChannel(', 'async function refreshJoinStatus('), context);
  await context.showChannel('only');
  assert.equal(joined, 0);
});

for (const connected of [false, true]) {
  test(connected ? 'Meus canais stays open even on the first visit with a room connected' : 'a single channel is selected automatically on arrival', async () => {
    const navigations = [];
    const element = () => ({ append() {}, replaceChildren() {}, dataset: {} });
    const context = {
      state: { room: connected ? {} : null }, document: { createElement: element },
      $: element, show() {}, toast() {}, makeMark: element, ico: element,
      api: async () => ({ channels: [{ id: 'only', name: 'Canal', role: 'owner' }] }),
      navigate: async path => { navigations.push(path); },
    };
    vm.createContext(context);
    vm.runInContext(functionSource('async function showHome(', '// ---------------- convite'), context);
    await context.showHome();
    assert.deepEqual(navigations, connected ? [] : ['/c/only']);
  });
}
