import pako from 'pako';
import { DesignSpec } from '../types.js';
import { base64ToUint8, uint8ToBase64 } from '../blueprint/codec.js';
import { normalizeSpec } from './yamlCodec.js';

function toBase64Url(bytes: Uint8Array): string {
  return uint8ToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return base64ToUint8(b64);
}

export function encodeSpecToUrlHash(spec: DesignSpec): string {
  const json = JSON.stringify(spec);
  const deflated = pako.deflate(json, { level: 9 });
  return `#spec=${toBase64Url(deflated)}`;
}

export function decodeSpecFromUrlHash(hash: string): DesignSpec | null {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(clean);
  const encoded = params.get('spec');
  if (!encoded) return null;

  const bytes = fromBase64Url(encoded);
  const json = pako.inflate(bytes, { to: 'string' });
  const parsed = JSON.parse(json) as Partial<DesignSpec>;
  return normalizeSpec(parsed);
}
