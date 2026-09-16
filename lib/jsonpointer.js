// lib/jsonpointer.js — A minimal RFC 6901-style JSON Pointer implementation
// (get + validate only). Admins bind field aliases to pointers; the agent never
// sees or supplies a pointer. No dependency needed for something this small.

// A pointer must start with '/', tokens are separated by '/', '~' is only legal
// as the escapes ~0 (~) and ~1 (/). '#' is rejected (fragment smuggling).
const POINTER_PATTERN = /^\/(?:~[01]|[^~#])*(?:\/(?:~[01]|[^~#]))*$|^\/$/

export function validatePointer(pointer, label = 'field pointer') {
  const value = String(pointer ?? '')
  if (!value || value === '/' || !POINTER_PATTERN.test(value)) {
    throw new Error(`${label} ${JSON.stringify(oneLineSafe(value, 80))} is not a valid JSON Pointer (RFC 6901 style, e.g. "/status" or "/health/ok").`)
  }
  // Bound the pointer itself so a config typo cannot request a 10k-segment walk.
  if (value.length > 512) {
    throw new Error(`${label} is too long (max 512 characters).`)
  }
  return value
}

// Split a pointer into decoded tokens: '/a/b~1c' → ['a', 'b/c'].
export function pointerTokens(pointer) {
  const value = String(pointer ?? '')
  if (value === '' || value === '/') return []
  return value.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
}

// Resolve a pointer against parsed JSON. Returns { found, value } — missing is
// not an error: field selection turns it into a warning (graceful degradation).
// Array indexes must be canonical non-negative integers ('0', '17'); '-', whose
// meaning in RFC 6901 is append-only, never matches an existing element.
export function getByPointer(root, pointer) {
  const tokens = pointerTokens(pointer)
  let current = root
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length) {
        return { found: false, value: undefined }
      }
      current = current[Number(token)]
      continue
    }
    if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false, value: undefined }
      current = current[token]
      continue
    }
    return { found: false, value: undefined }
  }
  return { found: true, value: current }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function oneLineSafe(value, maxLength) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, maxLength)
}
