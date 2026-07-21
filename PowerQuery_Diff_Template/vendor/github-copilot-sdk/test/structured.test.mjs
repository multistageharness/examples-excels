import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSchema,
  extractJson,
  renderStructuredInput,
  buildStructuredPrompt,
  buildRepairPrompt,
  parseStructuredResponse,
} from '../src/structured.mjs';

const PERSON_SCHEMA = {
  type: 'object',
  required: ['name', 'age'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    role: { enum: ['admin', 'user'] },
  },
};

test('validateSchema accepts conforming objects', () => {
  const { valid, errors } = validateSchema(
    { name: 'Ada', age: 36, tags: ['x'], role: 'admin' },
    PERSON_SCHEMA,
  );
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test('validateSchema reports missing/extra/typed/range errors with paths', () => {
  const { valid, errors } = validateSchema(
    { age: 200, extra: 1, tags: ['a', 'b', 'c', 'd'], role: 'root' },
    PERSON_SCHEMA,
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('missing required property "name"')));
  assert.ok(errors.some((e) => e.includes('unexpected property "extra"')));
  assert.ok(errors.some((e) => e.includes('200 > maximum 150')));
  assert.ok(errors.some((e) => e.includes('at most 3 items')));
  assert.ok(errors.some((e) => e.includes('not in enum')));
});

test('validateSchema: integers satisfy number; type unions; nested paths', () => {
  assert.equal(validateSchema(3, { type: 'number' }).valid, true);
  assert.equal(validateSchema(3.5, { type: 'integer' }).valid, false);
  assert.equal(validateSchema(null, { type: ['string', 'null'] }).valid, true);

  const nested = validateSchema(
    { items: [{ qty: 'two' }] },
    {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { qty: { type: 'integer' } } } },
      },
    },
  );
  assert.equal(nested.valid, false);
  assert.match(nested.errors[0], /\$\.items\[0\]\.qty/);
});

test('extractJson handles fences, bare JSON, embedded objects, and garbage', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(extractJson('```\n[1,2]\n```').value, [1, 2]);
  assert.deepEqual(extractJson('  {"a":1}  ').value, { a: 1 });
  assert.deepEqual(
    extractJson('Sure! Here is the data: {"a":{"b":"with } brace"}} hope it helps').value,
    { a: { b: 'with } brace' } },
  );
  assert.deepEqual(extractJson('the array is [1,2,3] ok').value, [1, 2, 3]);
  assert.ok(extractJson('no json here').error);
  assert.ok(extractJson('').error);
  assert.ok(extractJson(null).error);
});

test('prompt builders embed schema, input, and errors', () => {
  const prompt = buildStructuredPrompt({
    task: 'Extract the person.',
    input: { text: 'Ada, 36' },
    schema: PERSON_SCHEMA,
  });
  assert.match(prompt, /Extract the person\./);
  assert.match(prompt, /<input>/);
  assert.match(prompt, /"required"/);
  assert.match(prompt, /ONLY a JSON value/);

  const repair = buildRepairPrompt({ errors: ['$.name: missing'], schema: PERSON_SCHEMA });
  assert.match(repair, /not valid/);
  assert.match(repair, /\$\.name: missing/);

  assert.match(renderStructuredInput({ a: 1 }, 'data'), /<data>/);
});

test('parseStructuredResponse combines extraction and validation', () => {
  const ok = parseStructuredResponse('{"name":"Ada","age":36}', PERSON_SCHEMA);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'Ada');

  const bad = parseStructuredResponse('{"age":36}', PERSON_SCHEMA);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0].includes('missing required property'));

  const noJson = parseStructuredResponse('I cannot do that', PERSON_SCHEMA);
  assert.equal(noJson.ok, false);
  assert.match(noJson.errors[0], /no parseable JSON/);
});
