import { applyLineEdits as applySharedLineEdits, numberedRead, snapshotVersion } from '@summonghost/line-edit';
import { z } from 'zod';

export const LINE_EDIT_BASE_TAG_HEX_LENGTH = 24;
export const LINE_EDIT_MAX_OPERATIONS = 100;

const LINE_EDIT_BASE_FORMAT = {
  length: LINE_EDIT_BASE_TAG_HEX_LENGTH,
  letterCase: 'upper',
} as const;

const replacementSchema = z
  .object({
    startLine: z.number().int().min(1).describe('First original line to replace, inclusive.'),
    endLine: z.number().int().min(1).describe('Last original line to replace, inclusive.'),
    content: z.string().describe('Complete replacement content. Use an empty string to delete the selected lines.'),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: 'endLine must be greater than or equal to startLine.',
    path: ['endLine'],
  });

const insertionSchema = z
  .object({
    afterLine: z
      .number()
      .int()
      .min(0)
      .describe('Original line after which to insert. Use 0 to insert before the first line.'),
    content: z.string().min(1).describe('Content to insert.'),
  })
  .strict();

export const lineEditOperationSchema = z.union([replacementSchema, insertionSchema]);
export type LineEditOperation = z.infer<typeof lineEditOperationSchema>;

export const lineEditToolParameters = z.object({
  path: z.string().describe('Absolute project file path.'),
  base: z
    .string()
    .regex(new RegExp(`^[A-F0-9]{${LINE_EDIT_BASE_TAG_HEX_LENGTH}}$`))
    .describe('Snapshot tag returned by the latest read or successful edit of this file.'),
  edits: z
    .array(lineEditOperationSchema)
    .min(1)
    .max(LINE_EDIT_MAX_OPERATIONS)
    .describe('Non-overlapping operations addressed against the original numbered lines.'),
});

export type LineEditToolInput = z.infer<typeof lineEditToolParameters>;

type LineAnchoredReadOptions = {
  path: string;
  content: string;
  sha256: string;
  offset?: number;
  limit?: number;
  maxLines: number;
  maxBytes: number;
};

export type LineAnchoredReadResult = {
  path: string;
  base: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
};

export type AppliedLineEdits = {
  content: string;
  editsApplied: number;
  firstChangedLine: number;
};

/** Compact display tag; edit execution always verifies it against the live full SHA-256. */
export function lineEditBaseTag(sha256: string): string {
  return snapshotVersion(sha256, LINE_EDIT_BASE_FORMAT);
}

/** Format a stable file snapshot as numbered lines suitable for line-anchored edits. */
export function lineAnchoredRead(options: LineAnchoredReadOptions): LineAnchoredReadResult {
  return {
    path: options.path,
    base: lineEditBaseTag(options.sha256),
    ...numberedRead({
      content: options.content,
      offset: options.offset,
      limit: options.limit,
      maxLines: options.maxLines,
      maxBytes: options.maxBytes,
    }),
  };
}

/** Apply every operation to the same original snapshot, never incrementally. */
export function applyLineEdits(original: string, operations: readonly LineEditOperation[]): AppliedLineEdits {
  const applied = applySharedLineEdits({
    content: original,
    edits: operations,
    maxEdits: LINE_EDIT_MAX_OPERATIONS,
    allowInsertionAtReplacementStart: true,
    mapEdit: (operation) =>
      'afterLine' in operation
        ? { startLine: operation.afterLine + 1, deleteLines: 0, content: operation.content }
        : {
            startLine: operation.startLine,
            deleteLines: operation.endLine - operation.startLine + 1,
            content: operation.content,
          },
  });
  return {
    content: applied.content,
    editsApplied: applied.editsApplied,
    firstChangedLine: applied.firstChangedLine,
  };
}
