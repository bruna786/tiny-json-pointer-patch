# tiny-json-pointer-patch

Applies RFC 6902 JSON Patch operations to read, write, or delete nested values in parsed JSON documents, using RFC 6901 JSON Pointers.

## Usage

```js
import { applyPatch, get, PatchError } from 'tiny-json-pointer-patch';

const doc = { users: [{ name: 'Ada' }, { name: 'Grace' }] };

// Read a value at a JSON Pointer.
get(doc, '/users/1/name'); // 'Grace'

// Apply a patch. The input document is not mutated.
const next = applyPatch(doc, [
  { op: 'replace', path: '/users/0/name', value: 'Ada Lovelace' },
  { op: 'add', path: '/users/-', value: { name: 'Katherine' } },
  { op: 'remove', path: '/users/1' },
]);
// next === { users: [{ name: 'Ada Lovelace' }, { name: 'Katherine' }] }

try {
  applyPatch(doc, [{ op: 'remove', path: '/users/5' }]);
} catch (err) {
  if (err instanceof PatchError) {
    console.error(err.path); // '/users/5'
  }
}
```

## Why this exists

JSON Pointer and JSON Patch are small specs, but the fiddly parts are the ones that bite in practice: escaping (`~0` and `~1` must be decoded left to right, so `~01` is not `/`), array indices that must be canonical decimal integers with no leading zeros, and the `move` rule that forbids moving a value into one of its own descendants. This library handles those cases explicitly and reports failures as a `PatchError` carrying the offending pointer in `err.path`.

The main trade-off is purity versus allocation. `applyPatch` deep-clones the document and returns a new one, which is the safe default when the document is shared; `applyPatchInPlace` mutates and returns the same document for callers who know they own it. Because `add` and `replace` may target the root pointer `''`, both functions return the resulting document — a caller who keeps the original root reference must use the returned value instead.

## Edge cases to know about

- The empty pointer `''` refers to the whole document. `add` and `replace` at `''` replace the root and return a new root value; `remove` at `''` throws.
- Array indices must match `0` or `[1-9][0-9]*`. `01` is rejected, and out-of-bounds indices throw.
- `add` on an array accepts `-` to append, and also accepts an index equal to the array length.
- `test` compares structurally (objects, arrays, and primitives), not by reference.

## API

- `parsePointer(pointer: string): string[]` — decode a pointer into reference tokens.
- `get(doc, pointer: string): unknown` — read the value at a pointer.
- `applyPatch(doc, patch: Operation[]): unknown` — apply a patch to a clone of `doc`.
- `applyPatchInPlace(doc, patch: Operation[]): unknown` — apply a patch to `doc` in place.
- `PatchError` — thrown for malformed pointers and failed operations; carries `path` when known.
