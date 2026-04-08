import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@google-cloud/tasks",
    "@google-cloud/storage",
    "firebase-admin",
    "google-auth-library",
    "googleapis",
  ],
};

export default withSentryConfig(nextConfig, {
  org:     process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent:  !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  sourcemaps:  { disable: true },
  webpack: {
    reactComponentAnnotation: { enabled: true },
    automaticVercelMonitors:  true,
    treeshake: { removeDebugLogging: true },
  },
});