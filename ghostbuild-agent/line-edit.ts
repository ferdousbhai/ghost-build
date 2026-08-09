import { z } from 'zod';

export const LINE_EDIT_BASE_TAG_HEX_LENGTH = 24;
export const LINE_EDIT_MAX_OPERATIONS = 100;

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
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('A line-edit base tag requires a SHA-256 file digest.');
  }
  return sha256.slice(0, LINE_EDIT_BASE_TAG_HEX_LENGTH).toUpperCase();
}

/** Format a stable file snapshot as numbered lines suitable for line-anchored edits. */
export function lineAnchoredRead(options: LineAnchoredReadOptions): LineAnchoredReadResult {
  const lines = logicalLines(options.content);
  const offset = options.offset ?? 1;
  if (!Number.isInteger(offset) || offset < 1) {
    throw new Error('Read offset must be a positive line number.');
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('Read limit must be a positive number of lines.');
  }
  if (lines.length === 0) {
    if (offset !== 1) {
      throw new Error(`Offset ${offset} is beyond end of file (0 lines).`);
    }
    return {
      path: options.path,
      base: lineEditBaseTag(options.sha256),
      content: '',
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
    };
  }
  if (offset > lines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines).`);
  }

  const lineLimit = Math.min(options.limit ?? options.maxLines, options.maxLines);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let index = offset - 1; index < lines.length && selected.length < lineLimit; index += 1) {
    const rendered = `${index + 1}:${lines[index]}`;
    const renderedBytes = byteLength(rendered) + (selected.length > 0 ? 1 : 0);
    if (selected.length === 0 && renderedBytes > options.maxBytes) {
      throw new Error(`Line ${index + 1} exceeds the ${options.maxBytes}-byte read cap.`);
    }
    if (selectedBytes + renderedBytes > options.maxBytes) {
      break;
    }
    selected.push(rendered);
    selectedBytes += renderedBytes;
  }

  const endLine = offset + selected.length - 1;
  const truncated = endLine < lines.length;
  return {
    path: options.path,
    base: lineEditBaseTag(options.sha256),
    content: selected.join('\n'),
    startLine: offset,
    endLine,
    totalLines: lines.length,
    truncated,
    ...(truncated ? { nextOffset: endLine + 1 } : {}),
  };
}

/** Apply every operation to the same original snapshot, never incrementally. */
export function applyLineEdits(original: string, operations: readonly LineEditOperation[]): AppliedLineEdits {
  if (operations.length === 0) {
    throw new Error('edits must contain at least one line operation.');
  }
  if (operations.length > LINE_EDIT_MAX_OPERATIONS) {
    throw new Error(`Apply at most ${LINE_EDIT_MAX_OPERATIONS} line operations in one edit.`);
  }

  const { bom, text } = stripBom(original);
  const ending = detectLineEnding(text);
  const normalized = normalizeToLf(text);
  const hadFinalNewline = normalized.endsWith('\n');
  const lines = logicalLines(normalized);
  const planned = operations.map((operation, operationIndex) => planOperation(operation, operationIndex, lines.length));
  assertOperationsDoNotOverlap(planned);

  const nextLines = [...lines];
  for (const operation of [...planned].sort(compareForApplication)) {
    nextLines.splice(operation.index, operation.deleteCount, ...operation.contentLines);
  }

  const nextNormalized = `${nextLines.join('\n')}${hadFinalNewline && nextLines.length > 0 ? '\n' : ''}`;
  const next = bom + restoreLineEndings(nextNormalized, ending);
  if (next === original) {
    throw new Error('The line edit produced no changes.');
  }
  return {
    content: next,
    editsApplied: planned.length,
    firstChangedLine: Math.min(...planned.map((operation) => operation.index + 1)),
  };
}

type PlannedOperation = {
  operationIndex: number;
  index: number;
  deleteCount: number;
  startLine?: number;
  endLine?: number;
  afterLine?: number;
  contentLines: string[];
};

function planOperation(operation: LineEditOperation, operationIndex: number, totalLines: number): PlannedOperation {
  if ('afterLine' in operation) {
    if (operation.afterLine > totalLines) {
      throw new Error(
        `edits[${operationIndex}].afterLine ${operation.afterLine} is beyond end of file (${totalLines} lines).`,
      );
    }
    return {
      operationIndex,
      index: operation.afterLine,
      deleteCount: 0,
      afterLine: operation.afterLine,
      contentLines: replacementLines(operation.content),
    };
  }
  if (operation.endLine < operation.startLine) {
    throw new Error(`edits[${operationIndex}].endLine must be greater than or equal to startLine.`);
  }
  if (operation.endLine > totalLines) {
    throw new Error(
      `edits[${operationIndex}] ends at line ${operation.endLine}, beyond end of file (${totalLines} lines).`,
    );
  }
  return {
    operationIndex,
    index: operation.startLine - 1,
    deleteCount: operation.endLine - operation.startLine + 1,
    startLine: operation.startLine,
    endLine: operation.endLine,
    contentLines: replacementLines(operation.content),
  };
}

function assertOperationsDoNotOverlap(operations: readonly PlannedOperation[]): void {
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    const left = operations[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const right = operations[rightIndex]!;
      if (left.afterLine !== undefined && right.afterLine !== undefined) {
        if (left.afterLine === right.afterLine) {
          throw new Error(
            `edits[${left.operationIndex}] and edits[${right.operationIndex}] insert at the same original boundary; merge them into one insertion.`,
          );
        }
        continue;
      }
      const replacement = left.afterLine === undefined ? left : right;
      const insertion = left.afterLine !== undefined ? left : right.afterLine !== undefined ? right : undefined;
      if (insertion) {
        if (insertion.afterLine! >= replacement.startLine! && insertion.afterLine! < replacement.endLine!) {
          throw new Error(
            `edits[${insertion.operationIndex}] inserts inside the range replaced by edits[${replacement.operationIndex}].`,
          );
        }
        continue;
      }
      if (left.startLine! <= right.endLine! && right.startLine! <= left.endLine!) {
        throw new Error(
          `edits[${left.operationIndex}] and edits[${right.operationIndex}] overlap; merge them into one replacement.`,
        );
      }
    }
  }
}

function compareForApplication(left: PlannedOperation, right: PlannedOperation): number {
  if (left.index !== right.index) {
    return right.index - left.index;
  }
  // At one boundary, replace first and insert second so an insertion before a
  // replaced range is not consumed by the replacement splice.
  return right.deleteCount - left.deleteCount;
}

function logicalLines(value: string): string[] {
  const normalized = normalizeToLf(value);
  if (normalized.length === 0) {
    return [];
  }
  const withoutFinalNewline = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline.split('\n');
}

function replacementLines(value: string): string[] {
  return logicalLines(value);
}

function stripBom(value: string): { bom: string; text: string } {
  return value.startsWith('\uFEFF') ? { bom: '\uFEFF', text: value.slice(1) } : { bom: '', text: value };
}

function detectLineEnding(value: string): '\n' | '\r\n' {
  const crlf = value.indexOf('\r\n');
  const lf = value.indexOf('\n');
  return crlf !== -1 && (lf === -1 || crlf < lf) ? '\r\n' : '\n';
}

function normalizeToLf(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function restoreLineEndings(value: string, ending: '\n' | '\r\n'): string {
  return ending === '\r\n' ? value.replace(/\n/g, '\r\n') : value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
