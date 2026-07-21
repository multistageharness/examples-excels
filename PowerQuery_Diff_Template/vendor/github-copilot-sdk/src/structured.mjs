/**
 * Structured input/output support.
 *
 * Output: the harness asks the model for JSON conforming to a JSON Schema,
 * extracts the JSON from the reply (fenced block or bare object), validates
 * it against the schema with a dependency-free validator, and (in the
 * harness) re-asks with the validation errors on failure.
 *
 * Input: `renderStructuredInput()` turns a structured payload into a stable,
 * fenced JSON block so callers can pass objects instead of hand-built
 * prompt strings.
 */

export class StructuredOutputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StructuredOutputError';
    Object.assign(this, details);
  }
}

/* ------------------------------------------------------------------ *
 * Minimal JSON Schema validation (draft-07 core subset:
 * type, properties, required, items, enum, const, nullable,
 * additionalProperties:false, min/max for numbers/strings/arrays).
 * ------------------------------------------------------------------ */

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(declared, actual) {
  if (declared === actual) return true;
  // JSON Schema: integers satisfy "number"
  return declared === 'number' && actual === 'integer';
}

/**
 * Validate `value` against a JSON Schema subset.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSchema(value, schema, pathPrefix = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { valid: true, errors };

  const actual = typeOf(value);

  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${pathPrefix}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${pathPrefix}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.type) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.some((t) => typeMatches(t, actual))) {
      errors.push(`${pathPrefix}: expected type ${declared.join('|')}, got ${actual}`);
      return { valid: false, errors }; // structural mismatch — stop descending
    }
  }

  if (actual === 'object') {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${pathPrefix}: missing required property "${req}"`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) {
        errors.push(...validateSchema(value[key], sub, `${pathPrefix}.${key}`).errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${pathPrefix}: unexpected property "${key}"`);
      }
    }
  }

  if (actual === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${pathPrefix}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${pathPrefix}: expected at most ${schema.maxItems} items, got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateSchema(item, schema.items, `${pathPrefix}[${i}]`).errors);
      });
    }
  }

  if (actual === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${pathPrefix}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${pathPrefix}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) {
      errors.push(`${pathPrefix}: string does not match pattern ${schema.pattern}`);
    }
  }

  if (actual === 'number' || actual === 'integer') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${pathPrefix}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${pathPrefix}: ${value} > maximum ${schema.maximum}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * JSON extraction from model replies
 * ------------------------------------------------------------------ */

/**
 * Extract the first parseable JSON value from model output. Handles fenced
 * ```json blocks, bare objects/arrays, and surrounding prose.
 * @returns {{ value: any }|{ error: string }}
 */
export function extractJson(text) {
  if (text == null) return { error: 'empty response' };
  const s = String(text);

  // 1. fenced ```json ... ``` (or bare ```) blocks, preferred
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of s.matchAll(fenceRe)) {
    try {
      return { value: JSON.parse(match[1]) };
    } catch {
      // try the next fence
    }
  }

  // 2. whole-string parse
  try {
    return { value: JSON.parse(s.trim()) };
  } catch {
    // fall through
  }

  // 3. first balanced {...} or [...] span
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = s.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth += 1;
      if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return { value: JSON.parse(s.slice(start, i + 1)) };
          } catch {
            break; // unbalanced/invalid — give up on this opener
          }
        }
      }
    }
  }

  return { error: 'no parseable JSON found in response' };
}

/* ------------------------------------------------------------------ *
 * Prompt construction
 * ------------------------------------------------------------------ */

/** Render structured input as a stable fenced JSON block. */
export function renderStructuredInput(input, label = 'input') {
  return [`<${label}>`, '```json', JSON.stringify(input, null, 2), '```', `</${label}>`].join('\n');
}

/**
 * Build the structured-output prompt: task + optional structured input +
 * schema contract + output rules.
 */
export function buildStructuredPrompt({ task, input, schema, label }) {
  const parts = [task];
  if (input !== undefined) {
    parts.push('', renderStructuredInput(input, label ?? 'input'));
  }
  parts.push(
    '',
    'Respond with ONLY a JSON value that conforms to this JSON Schema — no prose, no markdown fences:',
    JSON.stringify(schema, null, 2),
  );
  return parts.join('\n');
}

/** Build the repair prompt sent after a failed parse/validation. */
export function buildRepairPrompt({ errors, schema }) {
  return [
    'Your previous response was not valid against the required JSON Schema.',
    `Problems:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    '',
    'Respond again with ONLY a corrected JSON value conforming to the schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/**
 * Parse + validate a model reply against a schema.
 * @returns {{ ok: true, value: any }|{ ok: false, errors: string[] }}
 */
export function parseStructuredResponse(text, schema) {
  const extracted = extractJson(text);
  if ('error' in extracted) return { ok: false, errors: [extracted.error] };
  const { valid, errors } = validateSchema(extracted.value, schema);
  return valid ? { ok: true, value: extracted.value } : { ok: false, errors };
}
