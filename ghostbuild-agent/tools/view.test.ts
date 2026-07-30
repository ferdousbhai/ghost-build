import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { viewParameters, viewToolInputParameters } from './view.js';

describe('view tool parameters', () => {
  it('uses a provider-compatible fixed-length array schema', () => {
    const schema = z.toJSONSchema(viewParameters) as unknown as {
      properties: {
        view_range: {
          items?: unknown;
          maxItems?: number;
          minItems?: number;
          prefixItems?: unknown;
        };
      };
    };
    const range = schema.properties.view_range;

    expect(range.items).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(range.minItems).toBe(2);
    expect(range.maxItems).toBe(2);
    expect(range.prefixItems).toBeUndefined();
  });

  it('enforces bounded increasing ranges without legacy sentinels', () => {
    expect(viewParameters.parse({ path: '/home/project/src/app.ts', view_range: [1, 201] }).view_range).toEqual([
      1, 201,
    ]);
    expect(viewParameters.safeParse({ path: '/home/project/src/app.ts', view_range: [1, 202] }).success).toBe(false);
    expect(viewParameters.safeParse({ path: '/home/project/src/app.ts', view_range: [2, 2] }).success).toBe(false);
    expect(viewToolInputParameters.safeParse({ path: '/home/project/src/app.ts', view_range: [1, -1] }).success).toBe(
      false,
    );
  });
});
