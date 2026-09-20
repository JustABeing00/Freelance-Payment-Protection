import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const APP_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "UNPROCESSABLE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "INTERNAL",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

/**
 * Typed application error. Handlers throw these; the global error handler
 * maps them to stable `{ error: { code, message, details } }` envelopes.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(code: AppErrorCode, message: string, details?: unknown, expose = true) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
    this.expose = expose;
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError("BAD_REQUEST", message, details);
  }
  static unauthorized(message = "Authentication required"): AppError {
    return new AppError("UNAUTHORIZED", message);
  }
  static forbidden(message = "Access denied"): AppError {
    // Generic message avoids oracle leaks (see security-principles §4).
    return new AppError("FORBIDDEN", message);
  }
  static notFound(message = "Not found"): AppError {
    return new AppError("NOT_FOUND", message);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError("CONFLICT", message, details);
  }
  static unprocessable(message: string, details?: unknown): AppError {
    return new AppError("UNPROCESSABLE", message, details);
  }
  static internal(message = "Internal error"): AppError {
    return new AppError("INTERNAL", message, undefined, false);
  }
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ErrorBody = {
      error: { code: "NOT_FOUND", message: "Not found", requestId: request.id },
    };
    void reply.status(404).send(body);
  });

  app.setErrorHandler(
    (raw: FastifyError | AppError | Error, request: FastifyRequest, reply: FastifyReply) => {
      const isProd = process.env.NODE_ENV === "production";

      if (raw instanceof AppError) {
        const message = raw.expose || !isProd ? raw.message : "Internal error";
        const body: ErrorBody = {
          error: {
            code: raw.code,
            message,
            ...(raw.expose && raw.details !== undefined ? { details: raw.details } : {}),
            requestId: request.id,
          },
        };
        request.log.warn({ err: raw, code: raw.code }, "handled app error");
        void reply.status(raw.statusCode).send(body);
        return;
      }

      if ((raw as FastifyError).validation) {
        const body: ErrorBody = {
          error: {
            code: "BAD_REQUEST",
            message: "Invalid request",
            ...(!isProd ? { details: (raw as FastifyError).message } : {}),
            requestId: request.id,
          },
        };
        void reply.status(400).send(body);
        return;
      }

      const statusCode = (raw as FastifyError).statusCode;
      if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
        const body: ErrorBody = {
          error: { code: "BAD_REQUEST", message: raw.message, requestId: request.id },
        };
        void reply.status(statusCode).send(body);
        return;
      }

      request.log.error({ err: raw }, "unhandled error");
      const body: ErrorBody = {
        error: {
          code: "INTERNAL",
          message: "Internal error",
          ...(!isProd ? { details: raw.message } : {}),
          requestId: request.id,
        },
      };
      void reply.status(500).send(body);
    },
  );
}
