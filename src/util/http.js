'use strict';

class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  badRequest: (message, details) => new HttpError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Avtorizatsiya talab qilinadi.') => new HttpError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Ruxsat yo‘q.') => new HttpError(403, 'FORBIDDEN', message),
  notFound: (message = 'Topilmadi.') => new HttpError(404, 'NOT_FOUND', message),
  conflict: (code, message) => new HttpError(409, code, message),
  payloadTooLarge: () => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'So‘rov hajmi juda katta.'),
  unsupportedMediaType: () => new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json talab qilinadi.'),
  unprocessable: (code, message, details) => new HttpError(422, code, message, details),
  tooManyRequests: (retryAfterMs) =>
    new HttpError(429, 'RATE_LIMITED', 'Juda ko‘p so‘rov. Birozdan so‘ng qayta urinib ko‘ring.', {
      retryAfterMs,
    }),
  internal: () => new HttpError(500, 'INTERNAL', 'Ichki xatolik.'),
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(errors.payloadTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function readJson(req, limit) {
  const contentType = req.headers['content-type'] || '';
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    throw errors.unsupportedMediaType();
  }

  const raw = await readRawBody(req, limit);
  if (!raw.length) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw errors.badRequest('JSON noto‘g‘ri shakllangan.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errors.badRequest('So‘rov tanasi obyekt bo‘lishi kerak.');
  }
  return parsed;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
}

module.exports = {
  HttpError,
  errors,
  sendJson,
  sendNoContent,
  readJson,
  parseCookies,
  clientIp,
  applySecurityHeaders,
};
