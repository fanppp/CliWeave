/**
 * NDJSON 流解析器
 * 逐行 JSON.parse。借鉴 clowder-ai ndjson-parser.ts。
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export interface ParseError {
  __parseError: true;
  line: string;
  error: string;
}

export function isParseError(value: unknown): value is ParseError {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__parseError' in value &&
    (value as Record<string, unknown>).__parseError === true
  );
}

export async function* parseNDJSON(stream: Readable): AsyncGenerator<unknown> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      yield { __parseError: true, line: trimmed, error: 'Failed to parse JSON line' } satisfies ParseError;
    }
  }
}
