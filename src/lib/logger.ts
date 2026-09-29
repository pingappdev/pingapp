import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'phone', '*.phone', 'body.phone', 'req.body.phone',
      'code', '*.code', 'otp', 'to', '*.to',
      'headers.cookie', 'req.headers.cookie',
      'signature', '*.signature', 'SEVEN_API_KEY',
    ],
    censor: '[redacted]',
  },
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
