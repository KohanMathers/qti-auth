import type { RpcResult } from '@qtiauth/bus';
import {
  type ResolvedAccessToken,
  type ResolveAccessTokenRequest,
  resolveAccessTokenResponseSchema,
} from '@qtiauth/service-kit';

export type AccessTokenResolution =
  { status: 'ok'; token: ResolvedAccessToken } | { status: 'none' } | { status: 'unavailable' };

export interface AccessTokenResolver {
  resolve: (token: string) => Promise<AccessTokenResolution>;
}

export interface AccessTokenResolverOptions {
  resolve: (request: ResolveAccessTokenRequest) => Promise<RpcResult<unknown>>;
  onError: (message: string, error: unknown) => void;
}

export function createAccessTokenResolver(
  options: AccessTokenResolverOptions,
): AccessTokenResolver {
  return {
    resolve: async (token) => {
      const result = await options.resolve({ token });
      if (result.status !== 'ok') {
        if (result.status === 'error') {
          options.onError(
            'access token resolution failed',
            new Error(`${result.code}: ${result.message}`),
          );
        }
        return { status: 'unavailable' };
      }
      const parsed = resolveAccessTokenResponseSchema.safeParse(result.data);
      if (!parsed.success) {
        options.onError('oidc returned an invalid access token', parsed.error);
        return { status: 'unavailable' };
      }
      if (parsed.data.token === null) return { status: 'none' };
      return { status: 'ok', token: parsed.data.token };
    },
  };
}
