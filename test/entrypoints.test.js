import test from 'node:test';
import assert from 'node:assert/strict';

// These two modules are the app's only entry points. Before this test existed,
// `new Resolver()` threw at module load in the deployed bundle and every single
// invocation failed — the UI showed a dead button and no error. Nothing caught
// it because no test ever imported the entry points.
test('the resolver entry point loads and exports a handler', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.handler, 'function');
});

test('the queue worker entry point loads and exports a handler', async () => {
  const mod = await import('../src/worker.js');
  assert.equal(typeof mod.handler, 'function');
});

test('every resolver key the frontend calls is defined', async () => {
  const { readFileSync } = await import('node:fs');
  const backend = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const frontend = readFileSync(new URL('../src/frontend/index.jsx', import.meta.url), 'utf8');
  const invoked = [...new Set([...frontend.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]))];
  assert.ok(invoked.length > 0, 'frontend should invoke at least one resolver');
  for (const key of invoked) {
    assert.ok(backend.includes(`define('${key}'`), `resolver must define '${key}'`);
  }
});

test('every resolver goes through the admin gate', async () => {
  const { readFileSync } = await import('node:fs');
  const backend = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(!/resolver\.define\('/.test(backend), 'resolvers must be defined through the admin-only helper');
  assert.ok(backend.includes('const define = (key, fn) => resolver.define(key, adminOnly(fn));'));
});

test('group changes are only ever made as the signed-in admin, never as the app', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/reclaim.js', import.meta.url), 'utf8');
  const writes = [...src.matchAll(/requestJira\([\s\S]*?method: '(DELETE|POST)'/g)];
  assert.ok(writes.length >= 2, 'reclaim and undo calls should be present');
  assert.ok(!/asApp\(\)/.test(src), 'reclaim.js must not use asApp()');
  for (const file of ['../src/lib/jira.js', '../src/worker.js']) {
    const other = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/method: '(DELETE|POST|PUT)'/.test(other), `${file} must stay read-only`);
  }
});

test('the manifest has exactly one write scope', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  const scopes = [...manifest.matchAll(/^\s+- ((?:read|write|manage|delete|storage):[\w:-]+)/gm)].map((m) => m[1]);
  const writeScopes = scopes.filter((s) => !s.startsWith('read:') && s !== 'storage:app');
  assert.deepEqual(writeScopes, ['manage:jira-configuration']);
});
