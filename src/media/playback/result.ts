/**
 * A small, generic errors-as-values wrapper, distinct from src/media/index/build-index.ts's
 * IndexResult (an ad hoc, non-generic shape tailored to buildIndex's own return type). Kept
 * separate rather than reused so Task 1's already-shipped, already-tested types stay untouched.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
