import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, Session, isStartFailure, type Ticket } from './session';
const ticket = (status: Ticket['status']): Ticket => ({ session_token: 'test-session', status, position: 1, expires_in: 30, session_seconds: 300 });
const immediate = async () => {};
function transport(events: string[]) { return { connect: async (token: string) => { events.push(`connect:${token}`); }, disconnect: async () => { events.push('disconnect'); }, sendCommand: async (command: string) => { events.push(command); } }; }
test('waits for admission and passes the session token to streaming', async () => {
  const events: string[] = [];
  const run = new Session(async (path, options) => {
    events.push(path);
    if (path === '/join') assert.deepEqual(options?.headers, { 'X-Orbis-API-Key': 'user-key' });
    else assert.deepEqual(options?.headers, { Authorization: 'Bearer test-session' });
    return ticket(path === '/join' ? 'waiting' : 'active');
  }, immediate);
  await run.start('user-key', 'A forest', () => transport(events), () => {});
  await run.leave();
  assert.deepEqual(events, ['/join', '/status', 'connect:test-session', 'start', '/leave', 'disconnect']);
});
test('cancelling an in-flight join releases its eventual ticket without connecting', async () => {
  let resolve!: (value: Ticket) => void;
  const response = new Promise<Ticket>(r => { resolve = r; });
  const events: string[] = [];
  const run = new Session(async path => { events.push(path); return path === '/join' ? response : ticket('releasing'); }, immediate);
  const starting = run.start('key', 'prompt', () => transport(events), () => {});
  const leaving = run.leave();
  resolve(ticket('active'));
  await Promise.all([starting, leaving]);
  assert.deepEqual(events, ['/join', '/leave']);
});
test('failed release remains retryable and disconnects browser resources', async () => {
  const events: string[] = []; let fail = true; let attempts = 0;
  const run = new Session(async path => { if (path === '/leave') { attempts++; if (fail) throw new TypeError('Network unavailable'); } return ticket('active'); }, immediate);
  await run.start('key', 'prompt', () => transport(events), () => {});
  await assert.rejects(run.leave());
  assert.equal(attempts, 3); assert.equal(events.at(-1), 'disconnect');
  fail = false; await run.leave(); assert.equal(attempts, 4);
});
test('401 during release is treated as already released', async () => {
  const run = new Session(async path => { if (path === '/leave') throw new ApiError(401); return ticket('active'); }, immediate);
  await run.start('key', 'prompt', () => transport([]), () => {});
  await run.leave();
});
test('cancelling during connect prevents start and disconnects after connect finishes', async () => {
  let finish!: () => void;
  const events: string[] = [];
  const run = new Session(async path => { events.push(path); return ticket('active'); }, immediate);
  const starting = run.start('key', 'prompt', () => ({ ...transport(events), connect: () => new Promise<void>(r => { finish = r; }) }), () => {});
  await new Promise(r => setImmediate(r));
  const leaving = run.leave(); finish();
  await Promise.all([starting, leaving]);
  assert.deepEqual(events, ['/join', '/leave', 'disconnect']);
});

test('recognizes failed starts in model, wire, and flattened messages', () => {
  const message = { type: 'command_error', data: { command: 'start', reason: 'Generation failed to start. Please try again later.' } };
  assert.equal(isStartFailure(message), true);
  assert.equal(isStartFailure({ scope: 'application', data: message }), true);
  assert.equal(isStartFailure({ type: 'command_error', command: 'start' }), true);
  assert.equal(isStartFailure({ type: 'command_error', data: { command: 'set_prompt' } }), false);
  assert.equal(isStartFailure({ type: 'state' }), false);
  assert.equal(isStartFailure(null), false);
});
