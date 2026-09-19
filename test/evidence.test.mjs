/**
 * §10.2 `run_evidence`: the evidence registry.
 *
 * Its whole point is that a claim can be asked "which criterion does this speak
 * to, and does the artifact still hash to what you registered?" — so the tests are
 * about the two ways that question gets faked: calling a pointer hash a content
 * hash, and counting evidence that was never registered.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EVIDENCE_KINDS,
  buildEvidence,
  evidenceCoverage,
  nextEvidenceId,
  renderEvidenceSummary,
  resolveCitedIds,
} from '../src/evidence.js'

const criteria = [{ id: 'C1' }, { id: 'C2' }]
const hash = { hashOf: 'file', hash: 'a'.repeat(64) }
const context = { criteria, round: 3, at: 1000, hash }

test('ids are minted in sequence and survive deletions', () => {
  assert.equal(nextEvidenceId([]), 'E1')
  assert.equal(nextEvidenceId([{ id: 'E1' }, { id: 'E2' }]), 'E3')
  // The highest wins, so removing an old record cannot hand out its id again.
  assert.equal(nextEvidenceId([{ id: 'E9' }, { id: 'E2' }]), 'E10')
  assert.equal(nextEvidenceId([{ id: 'nonsense' }]), 'E1')
})

test('one record carries what a reader needs to re-check it', () => {
  const { record } = buildEvidence([], { kind: 'file', pointer: 'report.md', addresses: ['C1'], note: '结果表' }, context)
  assert.equal(record.id, 'E1')
  assert.equal(record.kind, 'file')
  assert.equal(record.pointer, 'report.md')
  assert.deepEqual(record.addresses, ['C1'])
  assert.equal(record.hashOf, 'file')
  assert.equal(record.hash, 'a'.repeat(64))
  assert.equal(record.round, 3)
  assert.equal(record.at, 1000)
  assert.equal(record.note, '结果表')
})

test('a bad kind or an empty pointer is refused, not stored', () => {
  assert.match(buildEvidence([], { kind: 'vibe', pointer: 'x' }, context).error, /kind/)
  assert.match(buildEvidence([], { kind: 'file', pointer: '   ' }, context).error, /pointer/)
  assert.match(buildEvidence([], {}, context).error, /kind/)
  for (const kind of EVIDENCE_KINDS) {
    assert.equal(buildEvidence([], { kind, pointer: 'x' }, context).error, undefined)
  }
})

test('evidence cannot point at a criterion the contract does not have', () => {
  const result = buildEvidence([], { kind: 'command', pointer: 'npm test', addresses: ['C1', 'C7'] }, context)
  assert.match(result.error, /C7/)
})

test('coverage names the criteria with no evidence behind them', () => {
  const records = [
    { id: 'E1', addresses: ['C1'] },
    { id: 'E2', addresses: ['C1'] },
  ]
  assert.deepEqual(evidenceCoverage(records, criteria), { covered: ['C1'], missing: ['C2'], records: 2 })
  assert.deepEqual(evidenceCoverage([], criteria), { covered: [], missing: ['C1', 'C2'], records: 0 })
})

test('a claim citing an unregistered id is separated, not counted', () => {
  const records = [{ id: 'E1', kind: 'file', pointer: 'a.md' }]
  const { found, missing } = resolveCitedIds(records, ['E1', 'E4'])
  assert.deepEqual(found.map((record) => record.id), ['E1'])
  assert.deepEqual(missing, ['E4'])
})

test('the summary says which hash it is and what is still uncovered', () => {
  const { record } = buildEvidence([], { kind: 'file', pointer: 'report.md', addresses: ['C1'] }, context)
  const text = renderEvidenceSummary(record, evidenceCoverage([record], criteria))
  assert.match(text, /已登记证据 E1 · file · report\.md/)
  assert.match(text, /文件内容哈希/)
  assert.match(text, /1\/2 条标准/)
  assert.match(text, /还没有证据的是 C2/)

  // A pointer hash must not be described as a content hash.
  const pointer = buildEvidence([], { kind: 'url', pointer: 'https://x/y' }, { ...context, hash: { hashOf: 'pointer', hash: 'b'.repeat(64) } }).record
  assert.match(renderEvidenceSummary(pointer, evidenceCoverage([pointer], criteria)), /指针哈希/)

  // And a record that addresses nothing says so rather than looking aligned.
  assert.match(renderEvidenceSummary(pointer, evidenceCoverage([pointer], criteria)), /没有指出对应哪条标准/)
})
