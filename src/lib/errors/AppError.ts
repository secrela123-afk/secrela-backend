/**
 * Application error with an HTTP status and stable machine-readable code.
 * Controllers/services throw this; the error middleware turns it into JSON.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly isOperational: boolean;

  constructor(
    statusCode: number,
    message: string,
    options?: {
      code?: string;
      details?: unknown;
      isOperational?: boolean;
    },
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = options?.code ?? "APP_ERROR";
    this.details = options?.details;
    this.isOperational = options?.isOperational ?? true;
  }
}
