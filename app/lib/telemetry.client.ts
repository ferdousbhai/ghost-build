import type { PublicRuntimeConfig } from './publicConfig';
import type * as Sentry from '@sentry/react';
import type { PostHog } from 'posthog-js';

let sentryInitialized = false;
let sentryPromise: Promise<typeof Sentry> | null = null;
let posthogPromise: Promise<PostHog> | null = null;

function loadSentry() {
  sentryPromise ??= import('@sentry/react');
  return sentryPromise;
}

async function loadPosthog() {
  posthogPromise ??= import('posthog-js').then((module) => module.default);
  return posthogPromise;
}

export async function initTelemetry(publicConfig: PublicRuntimeConfig) {
  await Promise.all([initSentry(publicConfig), initPosthog(publicConfig)]);
}

export async function captureMessage(message: string, context?: Record<string, unknown>) {
  const sentry = await loadSentry();
  sentry.captureMessage(message, context);
}

export async function captureException(error: unknown, context?: Record<string, unknown>) {
  const sentry = await loadSentry();
  sentry.captureException(error, context);
}

export async function setTelemetryExtra(key: string, value: unknown) {
  const sentry = await loadSentry();
  sentry.setExtra(key, value);
}

export async function setTelemetryUser(user: { id?: string; username?: string; email?: string }) {
  const sentry = await loadSentry();
  sentry.setUser(user);
}

export async function openFeedbackForm() {
  const sentry = await loadSentry();
  const form = await sentry.getFeedback()?.createForm();
  form?.appendToDom();
  form?.open();
}

async function initSentry(publicConfig: PublicRuntimeConfig) {
  if (sentryInitialized || !publicConfig.sentry.dsn) {
    return;
  }

  sentryInitialized = true;
  const sentry = await loadSentry();

  sentry.init({
    dsn: publicConfig.sentry.dsn,
    environment: 'production',
    tracesSampleRate: 1,
    integrations: [
      sentry.feedbackIntegration({
        colorScheme: 'system',
        autoInject: false,
        showName: false,
        showEmail: false,
      }),
      sentry.browserTracingIntegration(),
      sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
        maskAllInputs: false,
      }),
    ],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
  });
}

async function initPosthog(publicConfig: PublicRuntimeConfig) {
  const key = publicConfig.posthog.key;
  if (!key) {
    return;
  }

  const posthog = await loadPosthog();
  posthog.init(key, {
    api_host: publicConfig.posthog.host,
    ui_host: 'https://us.posthog.com/',
    debug: false,
    enable_recording_console_log: false,
    capture_pageview: true,
    persistence: 'memory',
  });
}
