#!/usr/bin/env node
/**
 * One-shot local OAuth helper for Geni.com
 * Run: node geni-auth.js
 * Opens your browser, captures the callback, saves tokens to geni-tokens.json
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, 'geni-config.json'), 'utf-8'));
const TOKENS_PATH = join(__dirname, 'geni-tokens.json');
const PORT = 3000;

const authUrl = `https://www.geni.com/platform/oauth/authorize?client_id=${config.client_id}&redirect_uri=${encodeURIComponent(config.redirect_uri)}&response_type=code`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('status');

    if (error === 'unauthorized' || !code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authorization denied.</h1><p>You can close this tab.</p>');
      console.error('[geni-auth] Authorization denied by user.');
      server.close();
      process.exit(1);
    }

    // Exchange code for tokens
    console.log('[geni-auth] Got authorization code. Exchanging for tokens...');

    try {
      const tokenUrl = 'https://www.geni.com/platform/oauth/request_token';
      const params = new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        redirect_uri: config.redirect_uri,
        code,
        grant_type: 'authorization_code',
      });

      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }

      const tokens = await resp.json();

      // Save tokens with timestamp
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        obtained_at: Date.now(),
        expires_at: Date.now() + (tokens.expires_in * 1000),
      };

      writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2), 'utf-8');

      console.log('[geni-auth] Tokens saved to geni-tokens.json');
      console.log(`[geni-auth] Access token expires in ${Math.round(tokens.expires_in / 3600)} hours`);
      console.log('[geni-auth] Copy geni-tokens.json and geni-config.json to your server.');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authorized!</h1>
        <p>Access token saved. Expires in ${Math.round(tokens.expires_in / 3600)} hours.</p>
        <p>The bot will auto-refresh using the refresh token.</p>
        <p>You can close this tab.</p>`);
    } catch (err) {
      console.error('[geni-auth] Token exchange failed:', err.message);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>Token exchange failed</h1><pre>${err.message}</pre>`);
    }

    console.log('[geni-auth] Auth complete. Server staying up for privacy/terms/deauthorize endpoints.');
    return;
  }

  if (url.pathname === '/deauthorize') {
    console.log('[geni-auth] Deauthorize callback received:', Object.fromEntries(url.searchParams));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }

  if (url.pathname === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>Privacy Policy — RoRo Family Tree Bot</title></head>
<body style="font-family:Georgia,serif;max-width:600px;margin:40px auto;padding:0 20px;color:#333">
<h1>Privacy Policy</h1>
<p><strong>RoRo Family Tree Bot</strong> is a private family history tool for the Sampson-Kahn family.</p>
<ul>
<li>We access your Geni.com family tree data solely to sync it with our private family records.</li>
<li>We do not share your data with any third parties.</li>
<li>We do not store Geni credentials — we use OAuth tokens that you can revoke at any time from your Geni account.</li>
<li>Only authorized family members can interact with the bot.</li>
</ul>
<p>Contact: mreider@gmail.com</p>
</body></html>`);
    return;
  }

  if (url.pathname === '/terms') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>Terms of Service — RoRo Family Tree Bot</title></head>
<body style="font-family:Georgia,serif;max-width:600px;margin:40px auto;padding:0 20px;color:#333">
<h1>Terms of Service</h1>
<p><strong>RoRo Family Tree Bot</strong> is a private, non-commercial family history tool.</p>
<ul>
<li>This application is for personal use by members of the Sampson-Kahn family.</li>
<li>The bot syncs family tree data between Geni.com and our private records.</li>
<li>We make no guarantees about accuracy of genealogical data — all information should be independently verified.</li>
<li>You may revoke access at any time through your Geni account settings.</li>
</ul>
<p>Contact: mreider@gmail.com</p>
</body></html>`);
    return;
  }

  // Root page
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>RoRo Family Tree Bot</title></head>
<body style="font-family:Georgia,serif;max-width:600px;margin:40px auto;padding:0 20px;color:#333">
<h1>RoRo Family Tree Bot</h1>
<p>A private family history tool for the Sampson-Kahn family.</p>
<p><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></p>
</body></html>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[geni-auth] Listening on http://localhost:${PORT}`);
  console.log(`[geni-auth] Opening browser for Geni authorization...`);
  console.log(`[geni-auth] If browser doesn't open, go to:\n${authUrl}\n`);

  // Open browser (macOS)
  try {
    execSync(`open "${authUrl}"`);
  } catch {
    // If open fails, user can click the URL above
  }
});
