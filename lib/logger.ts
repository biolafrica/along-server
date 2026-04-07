import * as Sentry from '@sentry/nextjs';

const SERVICE     = 'along-server';
const ENVIRONMENT = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';
const RELEASE     = process.env.SENTRY_RELEASE     ?? 'unknown';

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

function emit(severity: Severity, event: string, fields: Record<string, unknown>): void {
  const entry = {
    severity,
    event,
    service:     SERVICE,
    environment: ENVIRONMENT,
    release:     RELEASE,
    timestamp:   new Date().toISOString(),
    ...fields,
  };

  if (severity === 'ERROR' || severity === 'CRITICAL') {
    console.error(JSON.stringify(entry));
  } else if (severity === 'WARNING') {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

function serialiseError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorStack:   error.stack,
      errorName:    error.name,
    };
  }
  return { errorMessage: String(error) };
}


export const logger = {

  info(event: string, fields: Record<string, unknown> = {}): void {
    emit('INFO', event, fields);
  },

  error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    const errorFields = serialiseError(error);
    emit('ERROR', event, { ...fields, ...errorFields });

    const err = error instanceof Error ? error : new Error(String(error));
    Sentry.withScope(scope => {
      scope.setExtra('event', event);
      Object.entries(fields).forEach(([k, v]) => scope.setExtra(k, v));
      Sentry.captureException(err);
    });
  },


  warn(
    event: string,
    fields: Record<string, unknown> = {},
    sentryLevel?: Sentry.SeverityLevel
  ): void {
    emit('WARNING', event, fields);

    if (sentryLevel) {
      Sentry.withScope(scope => {
        Object.entries(fields).forEach(([k, v]) => scope.setExtra(k, v));
        Sentry.captureMessage(event, sentryLevel);
      });
    }
  },

  db(event: string, fields: Record<string, unknown> & { durationMs: number }): void {
    const SLOW_THRESHOLD_MS = 500;
    const isSlow = fields.durationMs > SLOW_THRESHOLD_MS;

    emit(isSlow ? 'WARNING' : 'INFO', event, {
      ...fields,
      slow:  isSlow,
      layer: 'database',
    });

    if (isSlow) {
      Sentry.withScope(scope => {
        Object.entries(fields).forEach(([k, v]) => scope.setExtra(k, v));
        Sentry.captureMessage(
          `Slow Firestore operation: ${event} (${fields.durationMs}ms)`,
          'warning'
        );
      });
    }
  },

  critical(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    const errorFields = serialiseError(error);
    emit('CRITICAL', event, { ...fields, ...errorFields });

    const err = error instanceof Error ? error : new Error(String(error));
    Sentry.withScope(scope => {
      scope.setLevel('fatal');
      scope.setExtra('event', event);
      Object.entries(fields).forEach(([k, v]) => scope.setExtra(k, v));
      Sentry.captureException(err);
    });
    Sentry.captureMessage(event, 'fatal');
  },
};


type ApiHandler = (req: Request) => Promise<Response>;

export function withApiLogging(routeName: string, handler: ApiHandler): ApiHandler {
  return async (req: Request) => {
    const startMs = Date.now();
    const method  = req.method;
    const path    = new URL(req.url).pathname;

    try {
      const response = await handler(req);

      logger.info('request_completed', {
        layer:      'request',
        routeName,
        method,
        path,
        statusCode: response.status,
        durationMs: Date.now() - startMs,
      });

      return response;

    } catch (err) {
      logger.error('request_failed', err, {
        layer:      'request',
        routeName,
        method,
        path,
        durationMs: Date.now() - startMs,
      });

      throw err;
    }
  };
}


export async function dbOperation<T>(
  event: string,
  collection: string,
  docId: string,
  operation: () => Promise<T>
): Promise<T> {
  const startMs = Date.now();

  try {
    const result = await operation();

    logger.db(event, { collection, docId, durationMs: Date.now() - startMs });

    return result;

  } catch (err) {
    logger.error(`${event}_failed`, err, {
      layer:      'database',
      collection,
      docId,
      durationMs: Date.now() - startMs,
    });

    throw err;
  }
}