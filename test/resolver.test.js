// Dependency-free test for the Groups-tab session.info overlay resolver.
// Run: node test/resolver.test.js
// Uses the production functions, with no Hermes or npm dependencies.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'plugin.js'), 'utf8')

function extract(opening) {
  const i = src.indexOf(opening)
  assert.notStrictEqual(i, -1, 'opening not found: ' + opening)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(i, j + 1)
    }
  }
  throw new Error('unbalanced function: ' + opening)
}

// A private scope avoids leaking declarations into the test process.
const resolveLiveSessionId = new Function(
  src.match(/^const asRecord = value =>.*$/m)[0] + '\n' +
  extract('const memberKey = member => {') + '\n' +
  extract('async function resolveLiveSessionId') + '\nreturn resolveLiveSessionId'
)()

const STALE = 'stale'
const LIVE = 'live'
const member = { name: 'azaraki' }
const legacyRoom = { sessions: { azaraki: STALE } }
const room = { roomId: 'room-id', sessions: { azaraki: STALE } }
const empty = { request: async () => ({ sessions: [] }) }
const failed = { request: async () => { throw new Error('offline') } }
const live = { sid: LIVE, live: true }
const stale = { sid: STALE, live: false }
const absent = { sid: null, live: false }
let checks = 0

function door(sessions) {
  return {
    request: async (method, params) => {
      assert.strictEqual(method, 'session.list')
      assert.deepStrictEqual(params, { include_hidden: true, limit: 500 })
      return { sessions }
    }
  }
}

async function check(label, rpc, targetRoom, expected, group = 'Nani', targetMember = member) {
  assert.deepStrictEqual(await resolveLiveSessionId(rpc, targetMember, group, targetRoom), expected, label)
  checks++
}

async function main() {
  await check('legacy exact title beats stale pointer',
    door([{ id: LIVE, title: 'Group: Nani' }]), legacyRoom, live)
  await check('empty live list keeps unmigrated persisted pointer', empty, legacyRoom, stale)
  await check('compressed root resolves to its live tip',
    door([{ id: 'root', resolved_id: LIVE, title: 'Group: Nani' }]), legacyRoom, live)
  await check('RPC failure keeps unmigrated persisted pointer', failed, legacyRoom, stale)

  // Current Hermes titles use the immutable room id plus a delimited thread.
  await check('current room and thread title beats stale pointer',
    door([{ id: LIVE, title: 'Group: room-id · topic-1' }]), room, live)
  await check('display rename retains durable room identity',
    door([{ id: LIVE, title: 'Group: room-id · topic-1' }]), room, live, 'Renamed')
  await check('legacy room can also use a current thread title',
    door([{ id: LIVE, title: 'Group: Nani · topic-1' }]), legacyRoom, live)
  await check('legacy exact durable-id title is still supported',
    door([{ id: LIVE, title: 'Group: room-id' }]), room, live)
  await check('same display name with a new room id must not match the old room',
    door([{ id: 'old', title: 'Group: old-room-id · topic-1' }]), room, stale)
  await check('room prefix collision does not match',
    door([{ id: 'other', title: 'Group: room-id-2 · topic-1' }]), room, stale)
  await check('empty suffix, wrong delimiter and malformed titles do not match',
    door([
      null,
      { id: 'bad', title: 42 },
      { id: 'bad', title: 'Group: room-id · ' },
      { id: 'bad', title: 'Group: room-id ·    ' },
      { id: 'bad', title: 'Group: room-id ·topic-1' },
      { id: 'bad', title: 'Group: room-id extra' },
      { title: 'Group: room-id · topic-1' }
    ]), room, stale)

  // Room storage has no selected-thread field: never choose the first thread.
  await check('multiple live threads suppress the overlay, not revive a stale pointer',
    door([
      { id: 'thread-a', title: 'Group: room-id · topic-a' },
      { id: 'thread-b', title: 'Group: room-id · topic-b' }
    ]), room, absent)
  await check('legacy and current live sessions are also ambiguous',
    door([
      { id: 'legacy', title: 'Group: room-id' },
      { id: LIVE, title: 'Group: room-id · topic-1' }
    ]), room, absent)
  await check('multiple compressed roots with the same resolved tip are unambiguous',
    door([
      { id: 'root-a', resolved_id: LIVE, title: 'Group: room-id · topic-1' },
      { id: 'root-b', resolved_id: LIVE, title: 'Group: room-id · topic-1' }
    ]), room, live)

  const migrated = { roomId: 'room-id', sessions: {
    azaraki: STALE, 'thread:topic-1::azaraki': 'stored-thread',
    'thread:topic-1::someone-else': 'other-member'
  } }
  await check('unique persisted thread pointer replaces the migrated bare pointer', empty,
    migrated, { sid: 'stored-thread', live: false })
  await check('RPC failure uses the unique persisted thread pointer', failed,
    migrated, { sid: 'stored-thread', live: false })
  await check('multiple persisted threads suppress the overlay', empty,
    { sessions: { azaraki: STALE, 'thread:a::azaraki': 'a', 'thread:b::azaraki': 'b' } }, absent)
  await check('same persisted id under multiple thread keys is unambiguous', empty,
    { sessions: { 'thread:a::azaraki': LIVE, 'thread:b::azaraki': LIVE } }, { sid: LIVE, live: false })
  await check('another member migrating does not invalidate the bare pointer', empty,
    { sessions: { azaraki: STALE, 'thread:a::someone-else': 'other' } }, stale)
  await check('legacy true sentinel never becomes a session id', empty,
    { sessions: { azaraki: true } }, absent)
  await check('migrated sentinel does not revive the old bare pointer', empty,
    { sessions: { azaraki: STALE, 'thread:a::azaraki': true } }, absent)
  await check('source-qualified thread member keys keep their full identity', empty,
    { sessions: { 'thread:a::remote::azaraki': LIVE, 'thread:a::azaraki': 'other' } },
    { sid: LIVE, live: false }, 'Nani',
    { name: 'azaraki', connectionId: 'remote', sourceScoped: true })
  await check('malformed thread key and member suffix collision do not match', empty,
    { sessions: { 'thread:::azaraki': 'bad', 'thread:a::prefix::azaraki': 'other' } }, absent)
  await check('missing room and malformed live response degrade gracefully',
    { request: async () => ({ sessions: {} }) }, undefined, absent)

  console.log('resolver.test.js: ' + checks + '/' + checks + ' passed')
}

main().catch(err => {
  console.error('FAIL:', err.message)
  process.exit(1)
})
