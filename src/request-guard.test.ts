import { describe, expect, it } from 'vitest';

import {
  applyBaselineHeaders,
  BASELINE_RESPONSE_HEADERS,
  hostName,
  refuseUntrustedRequest,
  type RequestGuardPolicy,
} from './request-guard.js';

const web = 'http://127.0.0.1:3001';
const loopback: RequestGuardPolicy = { allowedOrigin: web, loopbackBound: true };
const networked: RequestGuardPolicy = { allowedOrigin: web, loopbackBound: false };

const request = (
  method: string,
  origin: string | null,
  host: string | null = '127.0.0.1:4001',
) => ({
  method,
  origin,
  host,
});

describe('a write from a web page on another origin', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('is refused for %s', (method) => {
    const refused = refuseUntrustedRequest(request(method, 'http://evil.example'), loopback);
    expect(refused?.status).toBe(403);
    expect(refused?.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('is refused for a sibling origin on the same machine, and for the opaque "null" origin', () => {
    expect(refuseUntrustedRequest(request('POST', 'http://localhost:3001'), loopback)?.code).toBe(
      'ORIGIN_NOT_ALLOWED',
    );
    expect(refuseUntrustedRequest(request('POST', 'null'), loopback)?.code).toBe(
      'ORIGIN_NOT_ALLOWED',
    );
  });

  it('is refused on a networked bind too, where authentication is on by default', () => {
    expect(refuseUntrustedRequest(request('POST', 'http://evil.example'), networked)?.code).toBe(
      'ORIGIN_NOT_ALLOWED',
    );
  });
});

describe('what is still allowed', () => {
  it('a write from the configured web origin', () => {
    expect(refuseUntrustedRequest(request('POST', web), loopback)).toBeNull();
  });

  it('a write that names no origin — a script, curl or a test is not a page acting for a stranger', () => {
    expect(refuseUntrustedRequest(request('POST', null), loopback)).toBeNull();
  });

  it('reads and preflights from any origin, because CORS already withholds the response', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(refuseUntrustedRequest(request(method, 'http://evil.example'), loopback)).toBeNull();
    }
  });
});

describe('a request addressed to a name that is not loopback (DNS rebinding)', () => {
  it('is refused on a loopback bind, whatever the method', () => {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const refused = refuseUntrustedRequest(
        request(method, null, 'attacker.example:4001'),
        loopback,
      );
      expect(refused?.code).toBe('HOST_NOT_ALLOWED');
    }
  });

  it('accepts every loopback spelling, with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:4000',
      '127.0.0.1:4001',
      '[::1]:4001',
      '[::1]',
      'LOCALHOST:4000',
    ]) {
      expect(refuseUntrustedRequest(request('GET', null, host), loopback)).toBeNull();
    }
  });

  it('is not judged on a bind to a real interface, which has its own authentication', () => {
    expect(refuseUntrustedRequest(request('GET', null, 'ledger.lan:4000'), networked)).toBeNull();
  });

  it('a lookalike host is not a loopback name', () => {
    for (const host of [
      '127.0.0.1.evil.example:4001',
      'localhost.evil.example',
      '127.0.0.2:4001',
    ]) {
      expect(refuseUntrustedRequest(request('GET', null, host), loopback)?.code).toBe(
        'HOST_NOT_ALLOWED',
      );
    }
  });
});

describe('hostName', () => {
  it('drops the port and the IPv6 brackets', () => {
    expect(hostName('localhost:4000')).toBe('localhost');
    expect(hostName('[::1]:4000')).toBe('::1');
    expect(hostName('[::1]')).toBe('::1');
    expect(hostName('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('baseline response headers', () => {
  it('sets X-Content-Type-Options: nosniff on every response through the transport hook', () => {
    const set = new Map<string, string>();
    applyBaselineHeaders((name, value) => set.set(name, value));
    expect(set.get('X-Content-Type-Options')).toBe('nosniff');
    expect([...set.keys()].sort()).toEqual(Object.keys(BASELINE_RESPONSE_HEADERS).sort());
  });
});

describe('refusal message', () => {
  it('does not echo the configured origin back to the page that was refused', () => {
    const refused = refuseUntrustedRequest(
      { method: 'POST', origin: 'http://evil.example', host: '127.0.0.1:4001' },
      { allowedOrigin: 'http://127.0.0.1:3001', loopbackBound: true },
    );
    expect(refused?.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(refused?.message).not.toContain('127.0.0.1');
    expect(refused?.message).not.toContain('3001');
  });
});
