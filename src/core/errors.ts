export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'RING_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'REPORT_NOT_FOUND'
  | 'DUPLICATE_NODE'
  | 'DUPLICATE_RING'
  | 'INVALID_NODE_NAME'
  | 'INVALID_WEIGHT'
  | 'TOO_MANY_VNODES'
  | 'EMPTY_RING'
  | 'NODE_NOT_FOUND'
  | 'INVALID_JSON';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;
  readonly status: number;

  constructor(code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.field = field;
    this.status = STATUS[code];
  }
}

export const STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  INVALID_JSON: 400,
  EMPTY_RING: 409,
  DUPLICATE_NODE: 409,
  DUPLICATE_RING: 409,
  TOO_MANY_VNODES: 409,
  INVALID_NODE_NAME: 422,
  INVALID_WEIGHT: 422,
  NODE_NOT_FOUND: 422,
  RING_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  REPORT_NOT_FOUND: 404,
};

export function fail(code: ErrorCode, message: string, field?: string): never {
  throw new AppError(code, message, field);
}
