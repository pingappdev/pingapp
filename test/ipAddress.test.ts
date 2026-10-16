import { describe, expect, it } from 'vitest';
import { normalizeIpAddress, resolveClientIp } from '../src/lib/ipAddress.js';

describe('trusted client IP resolution', () => {
  it('canonicalizes IPv4, IPv6 and IPv4-mapped IPv6', () => {
    expect(normalizeIpAddress('192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIpAddress('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normalizeIpAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIpAddress('fe80::1%eth0')).toBeNull();
    expect(normalizeIpAddress('192.0.2.1:443')).toBeNull();
  });

  it('ignores forwarded headers unless the immediate peer is explicitly trusted', () => {
    expect(resolveClientIp('198.51.100.8', {
      'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.10',
    }, ['127.0.0.1'])).toBe('198.51.100.8');
    expect(resolveClientIp('::ffff:198.51.100.8', {
      'cf-connecting-ip': '203.0.113.9',
    }, ['198.51.100.8'])).toBe('203.0.113.9');
  });

  it('walks a forwarded chain from the trusted socket peer and stops at the first untrusted hop', () => {
    expect(resolveClientIp('2001:db8::2', {
      'x-forwarded-for': '2001:db8::1, 198.51.100.7',
    }, ['2001:db8::2', '198.51.100.7'])).toBe('2001:db8::1');
    expect(resolveClientIp('127.0.0.1', {
      'x-forwarded-for': '203.0.113.4, invalid, 127.0.0.1',
    }, ['127.0.0.1'])).toBe('127.0.0.1');
  });

  it('prefers a valid Cloudflare client address only behind a trusted proxy', () => {
    expect(resolveClientIp('127.0.0.1', { 'cf-connecting-ip': '203.0.113.4' }, ['127.0.0.1']))
      .toBe('203.0.113.4');
    expect(resolveClientIp('127.0.0.1', { 'cf-connecting-ip': 'bad' }, ['127.0.0.1']))
      .toBe('127.0.0.1');
  });
});
