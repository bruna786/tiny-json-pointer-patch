// tiny-json-pointer-patch — RFC 6901 JSON Pointer + RFC 6902 JSON Patch,
// implemented with zero dependencies.
//
// Design notes:
//
// * The library operates on plain parsed JSON values (objects, arrays, strings,
//   numbers, booleans, null). It does not parse or serialize JSON itself; that
//   is the caller's job. This keeps the surface tiny and lets callers choose
//   their own parser.
//
// * `applyPatch` is pure: it clones the document and returns a new one. This is
//   the safe default because JSON Patch is frequently applied to state that is
//   shared between callers. `applyPatchInPlace` is offered for callers who own
//   the document and want to avoid the clone.
//
// * Errors are reported as a `PatchError` with a `path` property so callers can
//   tell *which* operation failed, not just that something failed.

/**
 * Error thrown for malformed pointers and failed patch operations.
 *
 * We attach the offending JSON Pointer as `err.path` when we have one. RFC
 * 6902 does not mandate an error shape, so this is our own convention; tests
 * rely on it, so it is part of the public contract.
 */
export class PatchError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'PatchError';
    if (path !== undefined) {
      this.path = path;
    }
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArray = (v) => Array.isArray(v);

/**
 * Decode a single RFC 6901 reference token.
 *
 * The spec says `~1` -> `/` and `~0` -> `~`, and that these must be applied
 * left to right so that `~01` decodes to `~1` (not `/`). A naive chained
 * `replace` gets this wrong; we scan once.
 */
function decodeToken(token) {
  let out = '';
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch !== '~') {
      out += ch;
      continue;
    }
    const next = token[i + 1];
    if (next === '0') {
      out += '~';
      i++;
    } else if (next === '1') {
      out += '/';
      i++;
    } else {
      // A `~` not followed by 0 or 1 is invalid per RFC 6901 section 3.
      throw new PatchError(`invalid escape sequence in reference token: ${JSON.stringify(token)}`);
    }
  }
  return out;
}

/**
 * Encode a single reference token for use in a JSON Pointer.
 * Order matters: `~` must be escaped before `/`.
 */
export function encodeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Parse a JSON Pointer string into an array of decoded reference tokens.
 *
 * The empty string is the whole document and yields `[]`.
 * A non-empty pointer must start with `/`.
 *
 * Note: RFC 6901 also allows an empty reference token (a trailing `/` or `//`),
 * which addresses a property whose name is the empty string. We accept that.
 */
export function parsePointer(pointer) {
  if (typeof pointer !== 'string') {
    throw new PatchError('JSON Pointer must be a string');
  }
  if (pointer === '') {
    return [];
  }
  if (pointer[0] !== '/') {
    throw new PatchError(`JSON Pointer must start with '/': ${JSON.stringify(pointer)}`);
  }
  return pointer.slice(1).split('/').map(decodeToken);
}

/**
 * Resolve a parsed JSON Pointer against a document.
 *
 * Returns the value at the pointer. Throws `PatchError` if any step is missing.
 * The pointer must already be parsed; use `get` to resolve a string pointer.
 */
export function resolvePointer(doc, tokens) {
  let cur = doc;
  for (const token of tokens) {
    if (isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        throw new PatchError(`invalid array index: ${JSON.stringify(token)}`);
      }
      const idx = Number(token);
      if (idx >= cur.length) {
        throw new PatchError(`array index out of bounds: ${idx}`);
      }
      cur = cur[idx];
    } else if (isObject(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) {
        throw new PatchError(`missing property: ${JSON.stringify(token)}`);
      }
      cur = cur[token];
    } else {
      throw new PatchError(`cannot descend into non-container at token ${JSON.stringify(token)}`);
    }
  }
  return cur;
}

/**
 * Read the value at a JSON Pointer.
 */
export function get(doc, pointer) {
  return resolvePointer(doc, parsePointer(pointer));
}

/**
 * Deep-clone a parsed JSON value.
 *
 * We do not use `structuredClone` because it is not present in all supported
 * runtimes and because we only ever need to clone JSON-shaped data. The
 * recursion is fine for JSON documents, which are finite trees.
 */
export function clone(value) {
  if (isArray(value)) {
    return value.map(clone);
  }
  if (isObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = clone(value[k]);
    }
    return out;
  }
  return value;
}

function parentAndKey(doc, tokens) {
  if (tokens.length === 0) {
    throw new PatchError('cannot modify the whole document with this operation');
  }
  const parentTokens = tokens.slice(0, -1);
  const key = tokens[tokens.length - 1];
  const parent = resolvePointer(doc, parentTokens);
  return { parent, key };
}

function arrayIndexFor(parent, key, { allowAppend }) {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) {
    throw new PatchError(`invalid array index: ${JSON.stringify(key)}`);
  }
  const idx = Number(key);
  const max = allowAppend ? parent.length : parent.length - 1;
  if (idx > max) {
    throw new PatchError(`array index out of bounds: ${idx}`);
  }
  return idx;
}

function assertNoExtraMembers(op, allowed) {
  for (const k of Object.keys(op)) {
    if (!allowed.includes(k)) {
      throw new PatchError(`unexpected member in operation: ${JSON.stringify(k)}`);
    }
  }
}

/**
 * Apply a single RFC 6902 operation to a document in place.
 *
 * Returns the (possibly new) document, because `add` and `replace` on the
 * whole document replace the root value rather than mutating it.
 */
export function applyOperation(doc, op) {
  if (!isObject(op)) {
    throw new PatchError('operation must be an object');
  }
  if (typeof op.op !== 'string') {
    throw new PatchError('operation is missing a string "op" member');
  }
  if (typeof op.path !== 'string') {
    throw new PatchError('operation is missing a string "path" member', op.path);
  }
  const tokens = parsePointer(op.path);

  switch (op.op) {
    case 'add': {
      assertNoExtraMembers(op, ['op', 'path', 'value']);
      if (!Object.prototype.hasOwnProperty.call(op, 'value')) {
        throw new PatchError('add operation requires a "value" member', op.path);
      }
      if (tokens.length === 0) {
        return clone(op.value);
      }
      const { parent, key } = parentAndKey(doc, tokens);
      if (isArray(parent)) {
        // RFC 6902: for arrays, `-` means append. We also allow an index equal
        // to the length, which is the same as appending.
        if (key === '-') {
          parent.push(clone(op.value));
        } else {
          const idx = arrayIndexFor(parent, key, { allowAppend: true });
          parent.splice(idx, 0, clone(op.value));
        }
      } else if (isObject(parent)) {
        parent[key] = clone(op.value);
      } else {
        throw new PatchError(`cannot add to non-container at ${op.path}`, op.path);
      }
      return doc;
    }

    case 'remove': {
      assertNoExtraMembers(op, ['op', 'path']);
      if (tokens.length === 0) {
        throw new PatchError('cannot remove the whole document', op.path);
      }
      const { parent, key } = parentAndKey(doc, tokens);
      if (isArray(parent)) {
        const idx = arrayIndexFor(parent, key, { allowAppend: false });
        parent.splice(idx, 1);
      } else if (isObject(parent)) {
        if (!Object.prototype.hasOwnProperty.call(parent, key)) {
          throw new PatchError(`missing property: ${JSON.stringify(key)}`, op.path);
        }
        delete parent[key];
      } else {
        throw new PatchError(`cannot remove from non-container at ${op.path}`, op.path);
      }
      return doc;
    }

    case 'replace': {
      assertNoExtraMembers(op, ['op', 'path', 'value']);
      if (!Object.prototype.hasOwnProperty.call(op, 'value')) {
        throw new PatchError('replace operation requires a "value" member', op.path);
      }
      if (tokens.length === 0) {
        return clone(op.value);
      }
      const { parent, key } = parentAndKey(doc, tokens);
      if (isArray(parent)) {
        const idx = arrayIndexFor(parent, key, { allowAppend: false });
        parent[idx] = clone(op.value);
      } else if (isObject(parent)) {
        if (!Object.prototype.hasOwnProperty.call(parent, key)) {
          throw new PatchError(`missing property: ${JSON.stringify(key)}`, op.path);
        }
        parent[key] = clone(op.value);
      } else {
        throw new PatchError(`cannot replace in non-container at ${op.path}`, op.path);
      }
      return doc;
    }

    case 'move': {
      assertNoExtraMembers(op, ['op', 'path', 'from']);
      if (typeof op.from !== 'string') {
        throw new PatchError('move operation requires a string "from" member', op.path);
      }
      const fromTokens = parsePointer(op.from);
      if (fromTokens.length === 0) {
        throw new PatchError('cannot move the whole document', op.path);
      }
      const value = resolvePointer(doc, fromTokens);
      // RFC 6902: the "from" location must not be a proper prefix of "path".
      if (tokens.length > fromTokens.length && fromTokens.every((t, i) => t === tokens[i])) {
        throw new PatchError('cannot move a value into one of its own children', op.path);
      }
      doc = applyOperation(doc, { op: 'remove', path: op.from });
      return applyOperation(doc, { op: 'add', path: op.path, value });
    }

    case 'copy': {
      assertNoExtraMembers(op, ['op', 'path', 'from']);
      if (typeof op.from !== 'string') {
        throw new PatchError('copy operation requires a string "from" member', op.path);
      }
      const value = resolvePointer(doc, parsePointer(op.from));
      return applyOperation(doc, { op: 'add', path: op.path, value: clone(value) });
    }

    case 'test': {
      assertNoExtraMembers(op, ['op', 'path', 'value']);
      if (!Object.prototype.hasOwnProperty.call(op, 'value')) {
        throw new PatchError('test operation requires a "value" member', op.path);
      }
      const actual = resolvePointer(doc, tokens);
      if (!deepEqual(actual, op.value)) {
        throw new PatchError('test operation failed', op.path);
      }
      return doc;
    }

    default:
      throw new PatchError(`unknown operation: ${JSON.stringify(op.op)}`, op.path);
  }
}

/**
 * Structural equality for parsed JSON values.
 *
 * `NaN` is not representable in JSON, so we do not special-case it; numbers
 * compare with `===`, which is exact for the IEEE-754 values JSON can carry.
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (isArray(a) && isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Apply a patch to a clone of `doc`, leaving `doc` untouched.
 *
 * The patch must be an array of operations. Operations are applied in order;
 * the first failure aborts the whole patch and throws `PatchError`.
 */
export function applyPatch(doc, patch) {
  return applyPatchInPlace(clone(doc), patch);
}

/**
 * Apply a patch to `doc` in place and return the resulting document.
 *
 * Because `add` and `replace` can replace the root, the return value is the
 * document to use going forward; callers who hold a reference to the original
 * root should use the return value rather than the original reference.
 */
export function applyPatchInPlace(doc, patch) {
  if (!isArray(patch)) {
    throw new PatchError('patch must be an array of operations');
  }
  let out = doc;
  for (const op of patch) {
    out = applyOperation(out, op);
  }
  return out;
}
