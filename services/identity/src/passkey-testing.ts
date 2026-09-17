import { createHash } from 'node:crypto';

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoCBOR, isoUint8Array } from '@simplewebauthn/server/helpers';

export interface SoftwarePasskey {
  id: string;
  userHandle: string;
  register: (options: PublicKeyCredentialCreationOptionsJSON) => Promise<RegistrationResponseJSON>;
  authenticate: (
    options: PublicKeyCredentialRequestOptionsJSON,
  ) => Promise<AuthenticationResponseJSON>;
}

function bytes(source: ArrayBuffer | Uint8Array | Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(source);
}

function rpIdHash(rpID: string): Uint8Array<ArrayBuffer> {
  return bytes(createHash('sha256').update(rpID).digest());
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  return isoUint8Array.concat(parts);
}

function flags(up: boolean, uv: boolean, at: boolean): number {
  return (up ? 1 : 0) | (uv ? 4 : 0) | (at ? 64 : 0);
}

function counterBytes(value: number): Uint8Array<ArrayBuffer> {
  const valueBytes = new Uint8Array(4);
  new DataView(valueBytes.buffer).setUint32(0, value, false);
  return valueBytes;
}

function clientData(
  type: 'webauthn.create' | 'webauthn.get',
  challenge: string,
  origin: string,
): string {
  return JSON.stringify({ type, challenge, origin, crossOrigin: false });
}

async function coseKey(publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const raw = bytes(await crypto.subtle.exportKey('raw', publicKey));
  const x = bytes(raw.subarray(1, 33));
  const y = bytes(raw.subarray(33, 65));
  return bytes(
    isoCBOR.encode(
      new Map<number, number | Uint8Array<ArrayBuffer>>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    ),
  );
}

function derInteger(component: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let value = component;
  while (value.length > 1 && value[0] === 0) value = bytes(value.subarray(1));
  if ((value[0] ?? 0) & 0x80) {
    const prefixed = new Uint8Array(value.length + 1);
    prefixed.set(value, 1);
    value = prefixed;
  }
  const out = new Uint8Array(2 + value.length);
  out[0] = 0x02;
  out[1] = value.length;
  out.set(value, 2);
  return out;
}

function p1363ToDer(signature: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const half = signature.length / 2;
  const r = derInteger(bytes(signature.subarray(0, half)));
  const s = derInteger(bytes(signature.subarray(half)));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

async function sign(privateKey: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const signature = bytes(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data),
  );
  return isoBase64URL.fromBuffer(p1363ToDer(signature));
}

export async function softwarePasskey(origin: string): Promise<SoftwarePasskey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const id = isoBase64URL.fromBuffer(credentialId);
  let userHandle = '';
  let signCount = 0;

  return {
    id,
    get userHandle() {
      return userHandle;
    },
    async register(options) {
      userHandle = options.user.id;
      const json = clientData('webauthn.create', options.challenge, origin);
      const clientDataJSON = isoBase64URL.fromUTF8String(json);
      const credId = credentialId;
      const aaguid = new Uint8Array(16);
      const credIdLen = new Uint8Array([0, credId.length]);
      const authData = concat(
        rpIdHash(options.rp.id ?? ''),
        new Uint8Array([flags(true, true, true)]),
        counterBytes(0),
        aaguid,
        credIdLen,
        credId,
        await coseKey(pair.publicKey),
      );
      const attestationObject = bytes(
        isoCBOR.encode(
          new Map<string, string | Map<string, never> | Uint8Array<ArrayBuffer>>([
            ['fmt', 'none'],
            ['attStmt', new Map<string, never>()],
            ['authData', authData],
          ]),
        ),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON,
          attestationObject: isoBase64URL.fromBuffer(attestationObject),
        },
      };
    },
    async authenticate(options) {
      const rpID = options.rpId ?? '';
      const json = clientData('webauthn.get', options.challenge, origin);
      const clientDataJSON = isoBase64URL.fromUTF8String(json);
      signCount += 1;
      const authData = concat(
        rpIdHash(rpID),
        new Uint8Array([flags(true, true, false)]),
        counterBytes(signCount),
      );
      const hash = bytes(createHash('sha256').update(json).digest());
      const signature = await sign(pair.privateKey, concat(authData, hash));
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON,
          authenticatorData: isoBase64URL.fromBuffer(authData),
          signature,
          userHandle,
        },
      };
    },
  };
}
