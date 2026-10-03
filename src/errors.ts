export type ErrorCode =
  | 'EMPTY_RING'
  | 'DUPLICATE_NODE'
  | 'INVALID_NODE'
  | 'INVALID_WEIGHT'
  | 'TOO_MANY_VNODES'
  | 'RING_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'NODE_NOT_FOUND'
  | 'REPORT_NOT_FOUND'
  | 'INVALID_BODY'
  | 'INVALID_QUERY'
  | 'DUPLICATE_KEY'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorStatusCode(code: ErrorCode): number {
  switch (code) {
    case 'RING_NOT_FOUND':
    case 'VERSION_NOT_FOUND':
    case 'NODE_NOT_FOUND':
    case 'REPORT_NOT_FOUND':
      return 404;
    case 'EMPTY_RING':
      return 409;
    default:
      return 400;
  }
}
