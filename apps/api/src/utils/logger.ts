import { pino, type Logger, type LoggerOptions } from 'pino';
import { SECRET_ENV_KEYS } from '@airaos/config';
import { config } from '../config.js';
import { redactString } from './redaction.js';

/**
 * Structured logging with a redaction pass. Two layers protect against secret
 * leakage: pino's own path-based redaction for known field names, and a
 * formatter hook that runs the message through the value-shaped patterns.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-airaos-token"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'apiToken',
  '*.apiToken',
  'passwordCipher',
  '*.passwordCipher',
  'secretCipher',
  '*.secretCipher',
  ...SECRET_ENV_KEYS.map((key) => `env.${key}`),
];

function buildOptions(): LoggerOptions {
  const cfg = config();
  return {
    level: cfg.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: {
      service: 'airaos-infra-api',
      appEnv: cfg.APP_ENV,
    },
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        if (typeof object.msg === 'string') {
          return { ...object, msg: redactString(object.msg) };
        }
        return object;
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Pretty output is a developer convenience only; production emits JSON.
    transport:
      cfg.isDevelopment && process.env.LOG_PRETTY !== 'false'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
        : undefined,
  };
}

let rootLogger: Logger | null = null;

export function logger(): Logger {
  if (!rootLogger) {
    rootLogger = pino(buildOptions());
  }
  return rootLogger;
}

export function loggerOptions(): LoggerOptions {
  return buildOptions();
}
