import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOAuth, OwnerOAuthProvider } from '../dist/oauth.js';

const password = 'a'.repeat(64);
const issuer = new URL('https://mcp.kigagu.com');

test('OAuth discovery, owner consent, PKCE, single-use grants, refresh rotation and persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
  const stateFile = join(dir, 'oauth.json');
  process.env.MCP_PUBLIC_URL = issuer.href;
  process.env.MCP_OAUTH_PASSWORD = password;
  process.env.MCP_OAUTH_STATE_FILE = stateFile;
  const app = express();
  const provider = installOAuth(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, headers = {}) => fetch(base + path, { method: 'POST', body: new URLSearchParams(data), headers, redirect: 'manual' });
  try {
    const metadata = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.equal(metadata.registration_endpoint, issuer.href + 'register');
    const resource = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(resource.resource, issuer.href + 'mcp');
    const redirectUri = 'https://chatgpt.com/connector/oauth/test';
    const registration = await fetch(base + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    assert.throws(() => provider.clientsStore.registerClient({ redirect_uris: ['https://evil.example/callback'], token_endpoint_auth_method: 'none' }));
    const verifier = 'b'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = await fetch(base + '/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'original-state', scope: 'trendyol', resource: resource.resource }));
    assert.equal(auth.status, 200);
    assert.match(auth.headers.get('content-security-policy'), /form-action 'self' https:\/\/chatgpt\.com;/);
    const html = await auth.text();
    const request = html.match(/name="request" value="([^"]+)"/)[1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    assert.match(auth.headers.get('set-cookie'), /HttpOnly/);
    assert.match(auth.headers.get('set-cookie'), /Secure/);
    assert.equal((await post('/oauth/approve', { request, csrf, password })).status, 400);
    assert.equal((await post('/oauth/approve', { request, csrf: 'wrong', password }, { Cookie: cookie })).status, 400);
    assert.equal((await post('/oauth/approve', { request, csrf, password: 'wrong' }, { Cookie: cookie })).status, 400);
    const approval = await post('/oauth/approve', { request, csrf, password }, { Cookie: cookie });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'original-state');
    const tokenRequest = { grant_type: 'authorization_code', client_id: client.client_id, code: callback.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirectUri, resource: resource.resource };
    assert.equal((await post('/token', { ...tokenRequest, code_verifier: 'c'.repeat(64) })).status, 400);
    assert.equal((await post('/token', { ...tokenRequest, resource: 'https://evil.example/mcp' })).status, 400);
    assert.equal((await post('/token', { ...tokenRequest, redirect_uri: 'https://chatgpt.com/other' })).status, 400);
    const tokenResponse = await post('/token', tokenRequest);
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.equal((await provider.verifyAccessToken(tokens.access_token)).resource.href, resource.resource);
    assert.equal((await post('/token', tokenRequest)).status, 400);
    assert.equal((await post('/oauth/approve', { request, csrf, password }, { Cookie: cookie })).status, 400);
    const restarted = new OwnerOAuthProvider(issuer, password, stateFile);
    assert.equal(restarted.clientsStore.getClient(client.client_id).client_id, client.client_id);
    await restarted.verifyAccessToken(tokens.access_token);
    const refresh = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: resource.resource };
    const refreshed = await post('/token', refresh);
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.equal((await post('/token', refresh)).status, 400);
    await provider.revokeToken(client, { token: next.access_token });
    await assert.rejects(provider.verifyAccessToken(next.access_token));
    const changedPassword = new OwnerOAuthProvider(issuer, 'd'.repeat(64), stateFile);
    await assert.rejects(changedPassword.verifyAccessToken(tokens.access_token));
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth fails closed on invalid configuration and expired tokens', async () => {
  assert.throws(() => new OwnerOAuthProvider(new URL('http://mcp.kigagu.com'), password));
  assert.throws(() => new OwnerOAuthProvider(issuer, 'short'));
  const provider = new OwnerOAuthProvider(issuer, password);
  await assert.rejects(provider.verifyAccessToken('unknown'));
  await assert.rejects(provider.exchangeRefreshToken({ client_id: 'unknown' }, 'unknown'));
  const original = Date.now;
  try {
    // An expired authorization request cannot be approved.
    let html, cookie;
    const client = provider.clientsStore.registerClient({ redirect_uris: ['https://chatgpt.com/connector/oauth/test'], token_endpoint_auth_method: 'none' });
    const res = { cookie(_name, value) { cookie = value; }, set() {}, type() { return this; }, send(value) { html = value; } };
    await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'a'.repeat(43) }, res);
    const request = html.match(/name="request" value="([^"]+)"/)[1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    Date.now = () => original() + 301000;
    assert.throws(() => provider.approve(request, csrf, cookie, password));
  } finally { Date.now = original; }
});
