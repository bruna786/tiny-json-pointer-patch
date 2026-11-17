import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePointer,
  get,
  applyPatch,
  applyPatchInPlace,
  PatchError,
} from '../src/index.js';

test('parsePointer handles the empty pointer and escapes', () => {
  assert.deepEqual(parsePointer(''), []);
  assert.deepEqual(parsePointer('/a/b'), ['a', 'b']);
  assert.deepEqual(parsePointer('/a~1b'), ['a/b']);
  assert.deepEqual(parsePointer('/a~0b'), ['a~b']);
  // `~01` must decode to `~1`, not `/`: escapes are applied left to right.
  assert.deepEqual(parsePointer('/a~01b'), ['a~1b']);
  // Empty reference tokens are legal.
  assert.deepEqual(parsePointer('//'), ['', '']);
});

test('parsePointer rejects malformed pointers', () => {
  assert.throws(() => parsePointer('a'), PatchError);
  assert.throws(() => parsePointer('/a~2'), PatchError);
  assert.throws(() => parsePointer(42), PatchError);
});

test('get resolves nested values and reports missing ones', () => {
  const doc = { a: { b: [10, 20, 30] } };
  assert.equal(get(doc, ''), doc);
  assert.equal(get(doc, '/a/b/1'), 20);
  assert.throws(() => get(doc, '/a/b/3'), PatchError);
  assert.throws(() => get(doc, '/a/c'), PatchError);
  assert.throws(() => get(doc, '/a/b/01'), PatchError);
});

test('add inserts into arrays and objects', () => {
  const doc = { a: [1, 3], b: {} };
  const out = applyPatch(doc, [
    { op: 'add', path: '/a/1', value: 2 },
    { op: 'add', path: '/a/-', value: 4 },
    { op: 'add', path: '/b/x', value: true },
  ]);
  assert.deepEqual(out, { a: [1, 2, 3, 4], b: { x: true } });
  // The original must be untouched.
  assert.deepEqual(doc, { a: [1, 3], b: {} });
});

test('add can replace the root', () => {
  const out = applyPatch({ a: 1 }, [{ op: 'add', path: '', value: [1, 2] }]);
  assert.deepEqual(out, [1, 2]);
});

test('remove deletes object members and array elements', () => {
  const doc = { a: [1, 2, 3], b: { c: 1, d: 2 } };
  const out = applyPatch(doc, [
    { op: 'remove', path: '/a/1' },
    { op: 'remove', path: '/b/c' },
  ]);
  assert.deepEqual(out, { a: [1, 3], b: { d: 2 } });
  assert.throws(() => applyPatch(doc, [{ op: 'remove', path: '/b/missing' }]), PatchError);
});

test('replace requires the target to exist', () => {
  const doc = { a: [1, 2], b: {} };
  const out = applyPatch(doc, [
    { op: 'replace', path: '/a/0', value: 9 },
    { op: 'replace', path: '/b', value: { ok: true } },
  ]);
  assert.deepEqual(out, { a: [9, 2], b: { ok: true } });
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: '/a/2', value: 0 }]), PatchError);
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: '/b/x', value: 0 }]), PatchError);
});

test('move relocates a value', () => {
  const doc = { a: { b: 1 }, c: {} };
  const out = applyPatch(doc, [{ op: 'move', from: '/a/b', path: '/c/d' }]);
  assert.deepEqual(out, { a: {}, c: { d: 1 } });
});

test('move refuses to move a value into its own child', () => {
  const doc = { a: { b: { c: 1 } } };
  assert.throws(() => applyPatch(doc, [{ op: 'move', from: '/a', path: '/a/b/c' }]), PatchError);
});

test('copy duplicates without aliasing', () => {
  const doc = { a: { b: [1, 2] } };
  const out = applyPatch(doc, [{ op: 'copy', from: '/a/b', path: '/a/c' }]);
  assert.deepEqual(out, { a: { b: [1, 2], c: [1, 2] } });
  out.a.c.push(3);
  assert.deepEqual(out.a.b, [1, 2]);
});

test('test compares structurally and aborts the patch on mismatch', () => {
  const doc = { a: { b: 1 } };
  const out = applyPatch(doc, [{ op: 'test', path: '/a', value: { b: 1 } }]);
  assert.deepEqual(out, doc);
  assert.throws(() => applyPatch(doc, [{ op: 'test', path: '/a', value: { b: 2 } }]), PatchError);
  assert.throws(() => applyPatch(doc, [{ op: 'test', path: '/a', value: { b: 1, c: 2 } }]), PatchError);
});

test('a failing operation aborts the patch and leaves the original alone', () => {
  const doc = { a: 1 };
  assert.throws(
    () => applyPatch(doc, [
      { op: 'add', path: '/b', value: 2 },
      { op: 'remove', path: '/missing' },
    ]),
    PatchError,
  );
  assert.deepEqual(doc, { a: 1 });
});

test('applyPatchInPlace mutates the supplied document', () => {
  const doc = { a: 1 };
  const out = applyPatchInPlace(doc, [{ op: 'add', path: '/b', value: 2 }]);
  assert.equal(out, doc);
  assert.deepEqual(doc, { a: 1, b: 2 });
});

test('invalid operations are rejected', () => {
  assert.throws(() => applyPatch({}, [{ op: 'frobnicate', path: '' }]), PatchError);
  assert.throws(() => applyPatch({}, [{ op: 'add', path: '/a' }]), PatchError);
  assert.throws(() => applyPatch({}, [{ op: 'add', path: '/a', value: 1, extra: 1 }]), PatchError);
  assert.throws(() => applyPatch({}, { op: 'add', path: '/a', value: 1 }), PatchError);
});

test('PatchError carries the failing path', () => {
  try {
    applyPatch({ a: {} }, [{ op: 'remove', path: '/a/b' }]);
    assert.fail('expected a PatchError');
  } catch (err) {
    assert.ok(err instanceof PatchError);
    assert.equal(err.path, '/a/b');
  }
});
