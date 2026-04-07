import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://47d5f6ea1484600d7e48410b60e4b96f@o4511034125123584.ingest.de.sentry.io/4511034126893136",
  tracesSampleRate: 1,
  enableLogs: true,
  sendDefaultPii: true,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release:     process.env.SENTRY_RELEASE     ?? "unknown",
});