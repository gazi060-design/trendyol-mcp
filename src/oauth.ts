import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod/v4';
import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import express, { type Express, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

const random = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const now = () => Math.floor(Date.now() / 1000);
const scope = 'trendyol';
type Grant = { clientId: string; params: AuthorizationParams; expires: number };
type Pending = Grant & { csrf: string; attempts: number };
type Token = { clientId: string; expires: number };

/** Single-owner OAuth provider. The SDK handles OAuth parsing, client auth and S256 PKCE. */
export class OwnerOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Grant>();
  private access = new Map<string, Token>();
  private refresh = new Map<string, Token>();
  private loginAttempts: number[] = [];
  readonly resource: URL;
  readonly clientsStore = {
    getClient: (id: string) => this.clients.get(id),
    registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull => {
      if (this.clients.size >= 1000) throw new InvalidRequestError('Client registration capacity reached');
      if (!client.redirect_uris.length || client.redirect_uris.some(uri => {
        const url = new URL(uri);
        return url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || !!url.port || !!url.username || !!url.password || !!url.hash;
      })) throw new InvalidRequestError('Only HTTPS ChatGPT redirect URIs are allowed');
      if (client.token_endpoint_auth_method !== 'none' && client.token_endpoint_auth_method !== 'client_secret_post') {
        throw new InvalidRequestError('Unsupported client authentication method');
      }
      const registered = { ...client, client_id: random(), client_id_issued_at: now() };
      this.clients.set(registered.client_id, registered);
      this.save();
      return registered;
    }
  };

  constructor(readonly issuer: URL, private password: string, private stateFile?: string) {
    if (issuer.protocol !== 'https:' || issuer.pathname !== '/' || issuer.search || issuer.hash || issuer.username || issuer.password) {
      throw new Error('MCP_PUBLIC_URL must be an HTTPS origin, e.g. https://mcp.kigagu.com');
    }
    if (password.length < 32) throw new Error('MCP_OAUTH_PASSWORD must be at least 32 characters');
    this.resource = new URL('/mcp', issuer);
    if (stateFile && existsSync(stateFile)) {
      const token = z.object({ clientId: z.string(), expires: z.number().int() });
      const state = z.object({ issuer: z.string(), passwordHash: z.string(), clients: z.array(z.tuple([z.string(), OAuthClientInformationFullSchema])), access: z.array(z.tuple([z.string(), token])), refresh: z.array(z.tuple([z.string(), token])) }).parse(JSON.parse(readFileSync(stateFile, 'utf8')));
      // Changing the owner password or public URL revokes existing connections.
      if (state.issuer === issuer.href && equal(state.passwordHash, hash(password))) {
        this.clients = new Map(state.clients);
        this.access = new Map(state.access);
        this.refresh = new Map(state.refresh);
      }
    }
  }

  private save() {
    if (!this.stateFile) return;
    const state = { issuer: this.issuer.href, passwordHash: hash(this.password), clients: [...this.clients], access: [...this.access], refresh: [...this.refresh] };
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
    renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  private clean() {
    for (const map of [this.pending, this.codes, this.access, this.refresh]) {
      for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
      if (map.size >= 1000) throw new InvalidRequestError('Authorization capacity reached');
    }
  }

  private checkResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href) throw new InvalidRequestError('Invalid resource');
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.clean();
    this.checkResource(params.resource);
    if (params.scopes?.some(s => s !== scope)) throw new InvalidScopeError('Unsupported scope');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('Invalid S256 challenge');
    const id = random(), csrf = random();
    this.pending.set(id, { clientId: client.client_id, params, csrf, expires: now() + 300, attempts: 0 });
    res.cookie('mcp_oauth_request', id, { secure: true, httpOnly: true, sameSite: 'lax', path: '/oauth/approve', maxAge: 300000 });
    res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.type('html').send(`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Trendyol MCP bağlantısı</title><h1>Trendyol MCP bağlantısı</h1><p>ChatGPT'ye yapılandırılmış Trendyol mağazalarına erişim izni ver. Veri değiştirme işlemleri ayrıca onayını ister.</p><form method="post" action="/oauth/approve"><input type="hidden" name="request" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label>Bağlantı şifresi <input name="password" type="password" required autocomplete="current-password" maxlength="512"></label><button type="submit">Bağlantıya izin ver</button></form></html>`);
  }

  approve(id: string, csrf: string, cookie: string | undefined, password: string): string {
    this.loginAttempts = this.loginAttempts.filter(t => t > now() - 60);
    if (this.loginAttempts.length >= 30) throw new InvalidRequestError('Too many login attempts. Try again in one minute.');
    this.loginAttempts.push(now());
    const grant = this.pending.get(id);
    if (!grant || grant.expires <= now() || !equal(cookie ?? '', id) || !equal(csrf, grant.csrf)) {
      throw new InvalidRequestError('Invalid or expired authorization request. Restart connection in ChatGPT.');
    }
    grant.attempts++;
    if (grant.attempts >= 5) this.pending.delete(id);
    if (!equal(password, this.password)) throw new InvalidRequestError('Incorrect connection password');
    this.pending.delete(id);
    const code = random();
    this.codes.set(hash(code), { clientId: grant.clientId, params: grant.params, expires: now() + 60 });
    const redirect = new URL(grant.params.redirectUri);
    redirect.searchParams.set('code', code);
    if (grant.params.state !== undefined) redirect.searchParams.set('state', grant.params.state);
    redirect.searchParams.set('iss', this.issuer.href);
    return redirect.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const grant = this.codes.get(hash(code));
    if (!grant || grant.expires <= now() || grant.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return grant.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    const grant = this.codes.get(hash(code));
    if (!grant || grant.expires <= now() || grant.clientId !== client.client_id || redirectUri !== grant.params.redirectUri) {
      throw new InvalidGrantError('Invalid authorization code or redirect URI');
    }
    this.checkResource(resource);
    this.codes.delete(hash(code));
    return this.issue(client.client_id);
  }

  private issue(clientId: string): OAuthTokens {
    this.clean();
    const access = random(), refresh = random();
    this.access.set(hash(access), { clientId, expires: now() + 3600 });
    this.refresh.set(hash(refresh), { clientId, expires: now() + 7 * 86400 });
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    const entry = this.refresh.get(hash(token));
    if (!entry || entry.expires <= now() || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (scopes?.some(s => s !== scope)) throw new InvalidScopeError('Unsupported scope');
    this.checkResource(resource);
    this.refresh.delete(hash(token));
    return this.issue(client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.access.get(hash(token));
    if (!entry || entry.expires <= now()) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: entry.clientId, scopes: [scope], expiresAt: entry.expires, resource: this.resource };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    for (const map of [this.access, this.refresh]) {
      const key = hash(request.token);
      if (map.get(key)?.clientId === client.client_id) map.delete(key);
    }
    this.save();
  }
}

export function installOAuth(app: Express): OwnerOAuthProvider | undefined {
  const publicUrl = process.env.MCP_PUBLIC_URL?.trim();
  const password = process.env.MCP_OAUTH_PASSWORD?.trim();
  if (!publicUrl && !password) return undefined;
  if (!publicUrl || !password) throw new Error('Set both MCP_PUBLIC_URL and MCP_OAUTH_PASSWORD to enable OAuth');
  const provider = new OwnerOAuthProvider(new URL(publicUrl), password, process.env.MCP_OAUTH_STATE_FILE);
  app.use(mcpAuthRouter({ provider, issuerUrl: provider.issuer, resourceServerUrl: provider.resource, scopesSupported: [scope], resourceName: 'Trendyol MCP' }));
  app.post('/oauth/approve', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('mcp_oauth_request='))?.slice('mcp_oauth_request='.length);
    try {
      for (const key of ['request', 'csrf', 'password']) if (typeof req.body[key] !== 'string') throw new InvalidRequestError('Invalid form');
      const redirect = provider.approve(req.body.request, req.body.csrf, cookie, req.body.password);
      res.clearCookie('mcp_oauth_request', { secure: true, httpOnly: true, sameSite: 'lax', path: '/oauth/approve' });
      res.redirect(303, redirect);
    } catch (error) {
      res.status(400).type('text').send(error instanceof InvalidRequestError ? error.message : 'Authorization failed');
    }
  });
  return provider;
}

export function oauthChallenge(provider: OwnerOAuthProvider): string {
  return `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(provider.resource)}", scope="${scope}"`;
}
