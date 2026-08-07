import { FormatRegistry } from '@sinclair/typebox';

// TypeBox's Value.Check fails any string carrying an unregistered format,
// so every format annotation used in these contracts is registered here
// (imported for its side effect from index.ts).

const DATE_TIME =
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, no nested quantifiers; linear on all inputs
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => DATE_TIME.test(value));
}
if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => UUID.test(value));
}
