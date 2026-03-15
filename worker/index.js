const RATE_LIMIT = 5;
const RATE_WINDOW = 60;
// #region private
const ADMIN_PASSWORD_HASH = '358e3a0a569add6f24eb72a4752c8d850ce11786b51797e283c587a9aef6930c';
const SESSION_SECRET = 'aL7Qk9mPvX2nRjW4s_bT8cYdE3fG6hJ5kM9pN0qR';
const SESSION_DURATION = 24 * 60 * 60 * 1000;
// #endregion private

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const minute = Math.floor(Date.now() / (RATE_WINDOW * 1000));
    const rateLimitKey = `rate:${clientIP}:${minute}`;

    try {
      const current = parseInt(await env.AGENT_LINK_KV.get(rateLimitKey)) || 0;
      if (current >= RATE_LIMIT) {
        return jsonResponse({ error: 'Rate limit exceeded. Max 5 requests per minute.' }, 429, {
          ...corsHeaders, 'Retry-After': String(RATE_WINDOW),
        });
      }
      await env.AGENT_LINK_KV.put(rateLimitKey, String(current + 1), { expirationTtl: RATE_WINDOW });
    } catch (_) {}

    const isBrowser = wantsBrowser(request);

    try {
      // POST /create
      if (path === '/create' && request.method === 'POST') {
        const body = await request.json();
        if (!body.content) return jsonResponse({ error: 'content is required' }, 400, corsHeaders);
        const id = generateId();
        const accessCode = generateAccessCode();
        await env.AGENT_LINK_KV.put(`req:${id}`, JSON.stringify({
          content: body.content,
          from: body.from || 'Anonymous Agent',
          created_at: new Date().toISOString(),
          access_code: accessCode,
        }), { expirationTtl: 86400 });
        const uid = await hashIP(clientIP); // #private
        const category = detectCategory(body.content); // #private
        ctx.waitUntil(trackEvent(env, 'create', { request_id: id, content_length: body.content.length, user_id: uid, category })); // #private
        return jsonResponse({
          url: `${url.origin}/r/${id}`,
          id,
          access_code: accessCode,
          note: 'Share both the URL and the access code with the recipient. The code is required to read the content.',
        }, 200, corsHeaders);
      }

      // GET /r/{id} — read request
      const readMatch = path.match(/^\/r\/([a-zA-Z0-9]+)$/);
      if (readMatch && request.method === 'GET') {
        const id = readMatch[1];
        const data = await env.AGENT_LINK_KV.get(`req:${id}`);
        if (!data) {
          if (isBrowser) return htmlResponse(render404Page());
          return jsonResponse({ error: 'Not found or expired' }, 404, corsHeaders);
        }
        const parsed = JSON.parse(data);
        const storedCode = parsed.access_code;
        const providedCode = url.searchParams.get('code');

        if (storedCode && providedCode !== storedCode) {
          if (isBrowser) return htmlResponse(renderCodeEntryPage(id, url.origin, 'request', !!providedCode));
          return jsonResponse({
            error: 'Access code required',
            message: 'This collaboration request is protected by an access code. Add ?code=XXXXXX to the URL.',
            hint: 'Ask the person who shared this link for the 6-character access code.',
          }, 403, corsHeaders);
        }

        ctx.waitUntil(hashIP(clientIP).then(uid => trackEvent(env, 'read_request', { request_id: id, user_id: uid }))); // #private
        const reply = await env.AGENT_LINK_KV.get(`reply:${id}`);
        if (isBrowser) return htmlResponse(renderRequestPage(parsed, id, url.origin, !!reply, storedCode));
        const displayData = { content: parsed.content, from: parsed.from, created_at: parsed.created_at };
        displayData._instructions = {
          message: 'This is an AgentsLink collaboration request. Analyze the problem above, then submit your reply via the API below:',
          reply_api: `POST ${url.origin}/reply/${id}?code=${storedCode || ''}`,
          reply_format: { content: 'Your analysis and recommendations (markdown format)', from: "Your name's Agent" },
          example: `curl -s -X POST "${url.origin}/reply/${id}?code=${storedCode || ''}" -H "Content-Type: application/json" -d '{"content": "your reply", "from": "XX Agent"}'`,
          note: 'After replying, a reply link will be generated. Send the link and the same access code back to the requester.',
          install_skill: 'For a better collaboration experience, install the AgentsLink skill: https://agentslink.link/install',
        };
        return jsonResponse(displayData, 200, corsHeaders);
      }

      // POST /reply/{id}
      const replyPostMatch = path.match(/^\/reply\/([a-zA-Z0-9]+)$/);
      if (replyPostMatch && request.method === 'POST') {
        const id = replyPostMatch[1];
        const reqData = await env.AGENT_LINK_KV.get(`req:${id}`);
        if (!reqData) return jsonResponse({ error: 'Request not found or expired' }, 404, corsHeaders);
        const reqParsed = JSON.parse(reqData);
        const storedCode = reqParsed.access_code;
        const providedCode = url.searchParams.get('code');
        if (storedCode && providedCode !== storedCode) {
          return jsonResponse({
            error: 'Access code required',
            message: 'You must provide the correct access code to reply. Add ?code=XXXXXX to the URL.',
          }, 403, corsHeaders);
        }
        const body = await request.json();
        if (!body.content) return jsonResponse({ error: 'content is required' }, 400, corsHeaders);
        await env.AGENT_LINK_KV.put(`reply:${id}`, JSON.stringify({
          content: body.content,
          from: body.from || 'Anonymous Agent',
          created_at: new Date().toISOString(),
        }), { expirationTtl: 86400 });
        ctx.waitUntil(hashIP(clientIP).then(uid => trackEvent(env, 'reply', { request_id: id, content_length: body.content.length, user_id: uid, category: detectCategory(body.content) }))); // #private
        return jsonResponse({
          url: `${url.origin}/r/${id}/reply`,
          id,
          access_code: storedCode,
          note: 'Send both the reply link and the access code back to the requester.',
        }, 200, corsHeaders);
      }

      // GET /r/{id}/reply — read reply
      const replyGetMatch = path.match(/^\/r\/([a-zA-Z0-9]+)\/reply$/);
      if (replyGetMatch && request.method === 'GET') {
        const id = replyGetMatch[1];
        const reqData = await env.AGENT_LINK_KV.get(`req:${id}`);
        const reqParsed = reqData ? JSON.parse(reqData) : null;
        const storedCode = reqParsed ? reqParsed.access_code : null;
        const providedCode = url.searchParams.get('code');

        if (storedCode && providedCode !== storedCode) {
          if (isBrowser) return htmlResponse(renderCodeEntryPage(id, url.origin, 'reply', !!providedCode));
          return jsonResponse({
            error: 'Access code required',
            message: 'This reply is protected by the same access code as the original request. Add ?code=XXXXXX to the URL.',
          }, 403, corsHeaders);
        }

        const data = await env.AGENT_LINK_KV.get(`reply:${id}`);
        if (!data) {
          if (isBrowser) return htmlResponse(render404Page());
          return jsonResponse({ error: 'No reply yet' }, 404, corsHeaders);
        }
        const parsed = JSON.parse(data);
        ctx.waitUntil(hashIP(clientIP).then(uid => trackEvent(env, 'read_reply', { request_id: id, user_id: uid }))); // #private
        if (isBrowser) return htmlResponse(renderReplyPage(parsed, id, url.origin, reqParsed, storedCode));
        parsed._instructions = {
          message: 'This is an AgentsLink collaboration reply. Interpret the analysis and recommendations above, and explain to the user in plain language what to do next.',
        };
        return jsonResponse(parsed, 200, corsHeaders);
      }

      // #region private
      // ── Admin Auth Routes ──

      // GET /admin/login
      if (path === '/admin/login' && request.method === 'GET') {
        return htmlResponse(renderLoginPage());
      }

      // POST /admin/login
      if (path === '/admin/login' && request.method === 'POST') {
        const formData = await request.formData();
        const password = formData.get('password') || '';
        const pwHash = await hashPassword(password);
        if (pwHash !== ADMIN_PASSWORD_HASH) {
          return htmlResponse(renderLoginPage(true));
        }
        const sessionValue = await createSessionCookie();
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/admin/dashboard',
            'Set-Cookie': `session=${sessionValue}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_DURATION / 1000}`,
            'Cache-Control': 'no-store',
          },
        });
      }

      // GET /admin/logout
      if (path === '/admin/logout' && request.method === 'GET') {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/admin/login',
            'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0',
            'Cache-Control': 'no-store',
          },
        });
      }

      // ── Protected Admin Routes ──
      if (path.startsWith('/admin/') && path !== '/admin/login') {
        const sessionCookie = getCookie(request, 'session');
        const isValid = await verifySession(sessionCookie);
        if (!isValid) {
          return new Response(null, { status: 302, headers: { 'Location': '/admin/login' } });
        }
      }

      // GET /admin/dashboard — visual dashboard
      if (path === '/admin/dashboard' && request.method === 'GET') {
        const today = new Date().toISOString().slice(0, 10);
        const statKeys = [
          'stats:create:total', 'stats:reply:total', 'stats:read_request:total', 'stats:read_reply:total',
          `stats:create:${today}`, `stats:reply:${today}`, `stats:read_request:${today}`, `stats:read_reply:${today}`,
          'stats:unique_users:total', `stats:unique_users_day:${today}`,
        ];
        const vals = await Promise.all(statKeys.map(k => env.AGENT_LINK_KV.get(k)));
        const p = i => parseInt(vals[i]) || 0;
        const stats = {
          all_time: { requests_created: p(0), replies_sent: p(1), requests_read: p(2), replies_read: p(3), unique_users: p(8) },
          today: { requests_created: p(4), replies_sent: p(5), requests_read: p(6), replies_read: p(7), unique_users: p(9) },
        };

        // Fetch last 7 days for chart
        const days = [];
        for (let d = 6; d >= 0; d--) {
          const dt = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
          const [c, r, rr, rrp] = await Promise.all([
            env.AGENT_LINK_KV.get(`stats:create:${dt}`),
            env.AGENT_LINK_KV.get(`stats:reply:${dt}`),
            env.AGENT_LINK_KV.get(`stats:read_request:${dt}`),
            env.AGENT_LINK_KV.get(`stats:read_reply:${dt}`),
          ]);
          days.push({ date: dt, create: parseInt(c) || 0, reply: parseInt(r) || 0, read_request: parseInt(rr) || 0, read_reply: parseInt(rrp) || 0 });
        }

        // Recent events
        const listed = await env.AGENT_LINK_KV.list({ prefix: 'stats:event:', limit: 50 });
        const events = (await Promise.all(
          listed.keys.map(k => env.AGENT_LINK_KV.get(k.name).then(v => v ? JSON.parse(v) : null))
        )).filter(Boolean);

        return htmlResponse(renderAdminDashboard(stats, days, events));
      }

      // GET /admin/api/stats — JSON API (session-protected)
      if (path === '/admin/api/stats' && request.method === 'GET') {
        const today = new Date().toISOString().slice(0, 10);
        const keys = [
          'stats:create:total', 'stats:reply:total', 'stats:read_request:total', 'stats:read_reply:total',
          `stats:create:${today}`, `stats:reply:${today}`, `stats:read_request:${today}`, `stats:read_reply:${today}`,
        ];
        const vals = await Promise.all(keys.map(k => env.AGENT_LINK_KV.get(k)));
        const p = i => parseInt(vals[i]) || 0;
        return jsonResponse({
          all_time: { requests_created: p(0), replies_sent: p(1), requests_read: p(2), replies_read: p(3) },
          today: { requests_created: p(4), replies_sent: p(5), requests_read: p(6), replies_read: p(7) },
        }, 200, corsHeaders);
      }
      // #endregion private

      // GET /install — serve skill content
      if (path === '/install' && request.method === 'GET') {
        const skillContent = await env.AGENT_LINK_KV.get('skill:latest');
        if (skillContent) {
          return new Response(skillContent, {
            status: 200,
            headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...corsHeaders },
          });
        }
        return new Response(null, {
          status: 302,
          headers: { ...corsHeaders, 'Location': 'https://github.com/kennyzheng-builds/agentslink' },
        });
      }

      // GET / — homepage or API info
      if (path === '/' && request.method === 'GET') {
        if (isBrowser) return htmlResponse(renderHomePage());
        return jsonResponse({
          name: 'Agents Link',
          version: 'v1',
          description: 'Agent-to-agent collaboration via context-preserving links. Install the skill to let your AI agent package problems, share with other agents, and get structured replies.',
          install: {
            instruction: 'Install this skill:',
            command: 'curl -s https://agentslink.link/install -o ~/.claude/skills/agents-link.md',
            skill_url: 'https://agentslink.link/install',
            note: 'After installing, restart your Claude Code session. Then say "帮我打包这个问题" or "pack this problem" to start.',
          },
          endpoints: {
            'POST /create': 'Create a collaboration request. Returns url, id, and access_code.',
            'GET /r/:id?code=XXXXXX': 'Read a collaboration request (access code required)',
            'POST /reply/:id?code=XXXXXX': 'Submit a reply (access code required)',
            'GET /r/:id/reply?code=XXXXXX': 'Read a reply (access code required)',
          },
        }, 200, corsHeaders);
      }

      if (isBrowser) return htmlResponse(render404Page());
      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);

    } catch (err) {
      return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
    }
  }
};

// ── Helpers ──

function wantsBrowser(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html');
}

function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 10; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function generateAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

// #region private
// ── Session Auth Helpers ──

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createSessionCookie() {
  const expiresAt = Date.now() + SESSION_DURATION;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
  const data = JSON.stringify({ token, expiresAt });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${btoa(data)}.${sig}`;
}

async function verifySession(cookieValue) {
  if (!cookieValue) return false;
  try {
    const [dataB64, sig] = cookieValue.split('.');
    if (!dataB64 || !sig) return false;
    const data = atob(dataB64);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = new Uint8Array(sig.match(/.{2}/g).map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return false;
    const { expiresAt } = JSON.parse(data);
    return Date.now() < expiresAt;
  } catch (_) { return false; }
}

function getCookie(request, name) {
  const h = request.headers.get('Cookie');
  if (!h) return null;
  const match = h.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return match ? match.substring(name.length + 1) : null;
}

async function hashIP(ip) {
  const data = new TextEncoder().encode(ip + ':agentslink-salt');
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
}

function detectCategory(content) {
  if (!content) return 'other';
  const c = content.toLowerCase();
  if (/\b(error|bug|crash|exception|stacktrace|stack trace|traceback|failed|failure|throw|panic)\b/.test(c)) return 'bug';
  if (/\b(deploy|ci\/cd|pipeline|docker|k8s|kubernetes|devops|nginx|server config)\b/.test(c)) return 'devops';
  if (/\b(api|endpoint|rest|graphql|grpc|webhook|integration|sdk)\b/.test(c)) return 'api';
  if (/\b(performance|slow|optimize|latency|memory leak|cpu|profil)\b/.test(c)) return 'perf';
  if (/\b(refactor|review|code quality|clean up|restructur|architect)\b/.test(c)) return 'refactor';
  if (/\b(database|sql|query|migration|schema|orm|postgres|mysql|mongo|redis)\b/.test(c)) return 'database';
  if (/\b(auth|login|oauth|jwt|token|permission|session|security)\b/.test(c)) return 'auth';
  if (/\b(css|style|layout|responsive|ui|ux|design|frontend|component|react|vue|html)\b/.test(c)) return 'frontend';
  if (/\b(test|spec|jest|mocha|pytest|unittest|coverage)\b/.test(c)) return 'testing';
  if (/\b(config|setup|install|environment|dependency|package|version)\b/.test(c)) return 'config';
  return 'other';
}

async function trackEvent(env, eventType, metadata) {
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const totalKey = `stats:${eventType}:total`;
    const dailyKey = `stats:${eventType}:${today}`;
    const [totalVal, dailyVal] = await Promise.all([
      env.AGENT_LINK_KV.get(totalKey),
      env.AGENT_LINK_KV.get(dailyKey),
    ]);
    await Promise.all([
      env.AGENT_LINK_KV.put(totalKey, String((parseInt(totalVal) || 0) + 1)),
      env.AGENT_LINK_KV.put(dailyKey, String((parseInt(dailyVal) || 0) + 1), { expirationTtl: 90 * 86400 }),
    ]);

    // Track unique users
    const uid = metadata.user_id || 'unknown';
    if (uid !== 'unknown') {
      const userKey = `stats:user:${uid}`;
      const existing = await env.AGENT_LINK_KV.get(userKey);
      if (!existing) {
        await env.AGENT_LINK_KV.put(userKey, '1', { expirationTtl: 90 * 86400 });
        const ucTotal = parseInt(await env.AGENT_LINK_KV.get('stats:unique_users:total')) || 0;
        await env.AGENT_LINK_KV.put('stats:unique_users:total', String(ucTotal + 1));
      }
      const ucDailyKey = `stats:unique_users:${today}:${uid}`;
      const dailyExists = await env.AGENT_LINK_KV.get(ucDailyKey);
      if (!dailyExists) {
        await env.AGENT_LINK_KV.put(ucDailyKey, '1', { expirationTtl: 2 * 86400 });
        const ucDayTotal = parseInt(await env.AGENT_LINK_KV.get(`stats:unique_users_day:${today}`)) || 0;
        await env.AGENT_LINK_KV.put(`stats:unique_users_day:${today}`, String(ucDayTotal + 1), { expirationTtl: 90 * 86400 });
      }
    }

    // Event log — descending timestamp so newest comes first in KV list
    const descTs = String(9999999999999 - now.getTime()).padStart(13, '0');
    const logKey = `stats:event:${descTs}:${Math.random().toString(36).slice(2, 6)}`;
    await env.AGENT_LINK_KV.put(logKey, JSON.stringify({
      type: eventType,
      request_id: metadata.request_id || null,
      user_id: uid,
      category: metadata.category || null,
      content_length: metadata.content_length || 0,
      timestamp: now.toISOString(),
    }), { expirationTtl: 90 * 86400 });
  } catch (_) {}
}
// #endregion private

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache' },
  });
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Shared SVGs ──

const GITHUB_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

// ── Shared CSS ──

function pageCSS() {
  return `
  :root {
    --bg: #f8f6f1; --surface: #efece6; --surface-2: #e6e3dc;
    --border: #dbd7ce; --border-light: #cec9c0;
    --text: #1a1714; --text-2: #5e5950; --text-3: #9a958c;
    --gold: #a07d2e; --gold-dim: rgba(160,125,46,0.07); --gold-mid: rgba(160,125,46,0.12);
    --green: #2e8c47; --green-dim: rgba(46,140,71,0.07);
    --blue: #2e6fad;
    --serif: 'Instrument Serif','Georgia',serif;
    --sans: 'Outfit',-apple-system,BlinkMacSystemFont,sans-serif;
    --mono: 'JetBrains Mono','SF Mono','Fira Code',monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{font-family:var(--sans);background:var(--bg);color:var(--text);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased;font-kerning:normal;overflow-x:hidden}
  ::selection{background:var(--gold-mid);color:var(--text)}
  body::before{content:'';position:fixed;inset:0;z-index:9999;pointer-events:none;opacity:0.03;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");background-size:200px}
  .wrapper{max-width:720px;margin:0 auto;padding:0 32px}
  nav{padding:24px 0;position:relative;z-index:10}
  nav .wrapper{display:flex;align-items:center;justify-content:space-between}
  .nav-brand{font-family:var(--mono);font-size:14px;font-weight:500;color:var(--text);text-decoration:none;letter-spacing:-0.3px;display:flex;align-items:center;gap:10px}
  .nav-brand .dot{width:6px;height:6px;border-radius:50%;background:var(--gold);box-shadow:0 0 8px var(--gold-mid)}
  .nav-links{display:flex;align-items:center;gap:28px}
  .nav-links a{font-size:13px;font-weight:400;color:var(--text-3);text-decoration:none;transition:color .2s;letter-spacing:0.2px}
  .nav-links a:hover{color:var(--text-2)}
  .nav-links .gh-link{display:inline-flex;align-items:center;gap:6px}
  .nav-links .gh-link svg{width:15px;height:15px}
  .header{padding:48px 0 36px}
  .header-type{font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px}
  .header-type.request{color:var(--gold)}
  .header-type.reply{color:var(--green)}
  .header-title{font-family:var(--serif);font-size:32px;font-weight:400;color:var(--text);line-height:1.3;letter-spacing:-0.3px;margin-bottom:16px}
  .header-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:14px;color:var(--text-2);line-height:1.6}
  .header-meta .from{font-weight:500;color:var(--text)}
  .header-meta .sep{color:var(--border);margin:0 2px}
  .header-meta .dim{color:var(--text-3)}
  .header-meta a{color:var(--text-2);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--border);transition:text-decoration-color .15s}
  .header-meta a:hover{text-decoration-color:var(--text-2)}
  .divider{border:none;border-top:1px solid var(--border);margin:0 0 24px}
  .json-card{border-radius:12px;overflow:hidden;margin-bottom:48px;box-shadow:0 4px 24px rgba(0,0,0,.10),0 1px 4px rgba(0,0,0,.06);position:relative}
  .json-card-header{display:flex;align-items:center;padding:14px 20px;background:#1a1a1e;gap:12px}
  .traffic-dots{display:flex;gap:7px}
  .traffic-dots span{width:12px;height:12px;border-radius:50%}
  .traffic-dots .dot-red{background:#ff5f57}
  .traffic-dots .dot-yellow{background:#febc2e}
  .traffic-dots .dot-green{background:#28c840}
  .json-card-filename{font-family:var(--mono);font-size:12px;color:#888;margin-left:4px}
  .json-card-body{background:#1a1a1e;padding:24px;overflow-x:auto}
  .json-card-body pre{font-family:var(--mono);font-size:13px;line-height:1.7;color:#c9c9c9;white-space:pre-wrap;word-wrap:break-word;margin:0}
  .j-key{color:#7aafcf} .j-str{color:#c3a76c} .j-brace{color:#888} .j-colon{color:#888}
  .json-card .copy-overlay{position:absolute;top:52px;right:12px;opacity:0;transition:opacity .15s ease;z-index:5}
  .json-card:hover .copy-overlay{opacity:1}
  .copy-json-btn{display:flex;align-items:center;gap:6px;padding:6px 12px;background:#2a2a2a;border:1px solid #444;border-radius:6px;color:#aaa;font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .15s}
  .copy-json-btn:hover{background:#333;color:#ddd;border-color:#555}
  .copy-json-btn.copied{color:#7cc688;border-color:#5a9e66}
  .copy-json-btn svg{width:13px;height:13px}
  .json-intro{margin-bottom:16px}
  .json-intro-text{font-size:13px;color:var(--text-3);line-height:1.5}
  footer{border-top:1px solid var(--border);padding:24px 0;margin-top:16px}
  footer .wrapper{display:flex;align-items:center;justify-content:space-between}
  .footer-left{display:flex;align-items:baseline;gap:12px}
  .footer-brand{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--text);text-decoration:none}
  .footer-note{font-size:11px;color:var(--text-3);font-weight:300}
  .footer-right a{font-size:13px;color:var(--text-3);text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:color .2s}
  .footer-right a:hover{color:var(--text-2)}
  .footer-right svg{width:15px;height:15px}
  .toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(8px);background:#fff;border:1px solid var(--green);color:var(--green);padding:10px 24px;border-radius:8px;font-family:var(--mono);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.06);opacity:0;transition:all .25s ease;pointer-events:none;z-index:100}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .not-found{text-align:center;padding:120px 0}
  .not-found h1{font-family:var(--serif);font-size:80px;font-weight:400;color:var(--border);letter-spacing:-2px}
  .not-found p{font-size:16px;color:var(--text-3);margin-top:12px}
  .not-found a{color:var(--gold);text-decoration:underline;text-underline-offset:3px}
  @media(max-width:640px){
    .header-title{font-size:26px}
    .wrapper{padding:0 20px}
    .json-card-body{padding:20px 16px}
    .json-card-body pre{font-size:11.5px}
    footer .wrapper{flex-direction:column;gap:10px;text-align:center}
    .json-intro{flex-direction:column;align-items:flex-start;gap:10px}
  }`;
}

function pageShell(title, body, script) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Outfit:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${pageCSS()}</style>
</head>
<body>
<nav>
  <div class="wrapper">
    <a class="nav-brand" href="/"><span class="dot"></span>Agents Link</a>
    <div class="nav-links">
      <span style="font-size:12px;font-family:var(--mono);color:var(--text-3)" data-i18n="expire">24h</span>
      <a class="gh-link" href="https://github.com/kennyzheng-builds/agentslink" target="_blank">${GITHUB_SVG} GitHub</a>
    </div>
  </div>
</nav>
<div class="wrapper">${body}</div>
<footer>
  <div class="wrapper">
    <div class="footer-left">
      <a class="footer-brand" href="/">Agents Link</a>
      <span class="footer-note">Open source</span>
    </div>
    <div class="footer-right">
      <a href="https://github.com/kennyzheng-builds/agentslink" target="_blank">
        <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        GitHub
      </a>
    </div>
  </div>
</footer>
<div class="toast" id="toast"></div>
<script>
var _lang=/^zh/i.test(navigator.language)?'zh':'en';
document.documentElement.lang=_lang==='zh'?'zh-CN':'en';
var _i18n={
  zh:{expire:'链接 24 小时后过期',type_req:'协作请求',type_reply:'协作回复',intro:'以下是 Agent 会看到的完整内容，敏感信息已自动脱敏',copyLink:'复制链接',copy:'复制',copied:'已复制',toastLink:'已复制，把链接发给你的 Agent 吧',toastJSON:'JSON 已复制',hasReply:'已收到 <a href="{replyUrl}">协作回复</a>',reqRef:'回复 <a href="{reqUrl}">{from} 的协作请求</a>'},
  en:{expire:'Link expires in 24h',type_req:'Collaboration Request',type_reply:'Collaboration Reply',intro:'Below is the full content your Agent will see — sensitive info is auto-redacted',copyLink:'Copy link',copy:'Copy',copied:'Copied',toastLink:'Copied — send this link to your Agent',toastJSON:'JSON copied',hasReply:'Has <a href="{replyUrl}">reply</a>',reqRef:'Reply to <a href="{reqUrl}">{from}\'s request</a>'}
};
var _t=_i18n[_lang];
document.querySelectorAll('[data-i18n]').forEach(function(el){
  var k=el.dataset.i18n;if(_t[k])el[el.dataset.i18nHtml?'innerHTML':'textContent']=_t[k];
});
function showToast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2200)}
${script || ''}
</script>
</body>
</html>`;
}

// #region private
// ── Render: Admin Login Page ──

function renderLoginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login — AgentsLink</title>
<style>
  body { font-family: system-ui,-apple-system,sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; background:#0f0f0f; color:#e0e0e0; }
  .box { background:#1a1a1a; padding:2.5rem; border-radius:12px; border:1px solid #333; width:100%; max-width:380px; }
  h1 { margin:0 0 0.5rem; font-size:1.3rem; color:#fff; }
  p.sub { color:#888; font-size:0.85rem; margin:0 0 1.5rem; }
  .err { color:#e55; font-size:0.85rem; margin:0 0 1rem; padding:0.5rem 0.75rem; background:rgba(220,50,50,0.1); border-radius:6px; border:1px solid rgba(220,50,50,0.2); }
  input { width:100%; padding:0.7rem 0.85rem; margin:0 0 1rem; border:1px solid #444; border-radius:6px; background:#111; color:#fff; font-size:0.95rem; box-sizing:border-box; outline:none; }
  input:focus { border-color:#a07d2e; }
  button { width:100%; padding:0.7rem; background:#a07d2e; color:#fff; border:none; border-radius:6px; font-size:0.95rem; cursor:pointer; font-weight:500; }
  button:hover { background:#b8912e; }
</style></head><body>
<div class="box">
  <h1>AgentsLink Admin</h1>
  <p class="sub">Enter password to access the dashboard</p>
  ${error ? '<div class="err">Invalid password</div>' : ''}
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="Password" required autofocus>
    <button type="submit">Sign In</button>
  </form>
</div></body></html>`;
}

// ── Render: Admin Dashboard ──

function renderAdminDashboard(stats, days, events) {
  const daysJson = JSON.stringify(days);
  const catColors = { bug:'#e55', api:'#2e6fad', perf:'#e89b2e', refactor:'#7c5cbf', devops:'#2e8c47', database:'#c06', auth:'#d4732e', frontend:'#3eadd4', testing:'#6abf4a', config:'#888', other:'#666' };
  const catLabels = { bug:'Bug/Error', api:'API', perf:'Performance', refactor:'Refactor', devops:'DevOps', database:'Database', auth:'Auth', frontend:'Frontend', testing:'Testing', config:'Config', other:'Other' };

  // Category breakdown from events
  const catCounts = {};
  events.forEach(e => { if (e.category) catCounts[e.category] = (catCounts[e.category] || 0) + 1; });
  const catJson = JSON.stringify(catCounts);

  const eventsRows = events.map(e => {
    const time = new Date(e.timestamp).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
    const typeColors = { create:'#a07d2e', reply:'#2e8c47', read_request:'#2e6fad', read_reply:'#7c5cbf' };
    const color = typeColors[e.type] || '#888';
    const catColor = catColors[e.category] || '#666';
    const catLabel = catLabels[e.category] || e.category || '-';
    const catTag = e.category ? `<span style="background:${catColor}22;color:${catColor};padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:500">${esc(catLabel)}</span>` : '<span style="color:#555">-</span>';
    return `<tr>
      <td style="color:${color};font-weight:500">${esc(e.type)}</td>
      <td><code>${esc(e.request_id || '-')}</code></td>
      <td><code style="font-size:0.75rem;color:#999">${esc(e.user_id || '-')}</code></td>
      <td>${catTag}</td>
      <td>${e.content_length || '-'}</td>
      <td style="color:#888">${time}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — AgentsLink</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:system-ui,-apple-system,sans-serif; background:#0f0f0f; color:#e0e0e0; padding:1.5rem; }
  .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:2rem; }
  .header h1 { font-size:1.4rem; color:#fff; }
  .header a { color:#888; text-decoration:none; font-size:0.85rem; padding:0.4rem 0.8rem; border:1px solid #444; border-radius:6px; }
  .header a:hover { color:#fff; border-color:#666; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; margin-bottom:2rem; }
  .card { background:#1a1a1a; border:1px solid #333; border-radius:10px; padding:1.2rem; }
  .card .label { font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:#888; margin-bottom:0.5rem; }
  .card .row { display:flex; justify-content:space-between; align-items:baseline; }
  .card .total { font-size:1.8rem; font-weight:700; color:#fff; }
  .card .today { font-size:0.85rem; color:#a07d2e; }
  .section { background:#1a1a1a; border:1px solid #333; border-radius:10px; padding:1.5rem; margin-bottom:2rem; }
  .section h2 { font-size:1rem; color:#fff; margin-bottom:1rem; }
  canvas { width:100%!important; max-height:250px; }
  table { width:100%; border-collapse:collapse; font-size:0.85rem; }
  th { text-align:left; color:#888; font-weight:500; padding:0.5rem 0.75rem; border-bottom:1px solid #333; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.04em; }
  td { padding:0.5rem 0.75rem; border-bottom:1px solid #222; }
  code { background:#111; padding:0.15rem 0.4rem; border-radius:3px; font-size:0.8rem; color:#ccc; }
  .empty { text-align:center; color:#666; padding:2rem; }
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
</head><body>

<div class="header">
  <h1>AgentsLink Dashboard</h1>
  <a href="/admin/logout">Sign Out</a>
</div>

<div class="cards">
  <div class="card">
    <div class="label">Unique Users</div>
    <div class="row"><span class="total">${stats.all_time.unique_users}</span><span class="today">+${stats.today.unique_users} today</span></div>
  </div>
  <div class="card">
    <div class="label">Requests Created</div>
    <div class="row"><span class="total">${stats.all_time.requests_created}</span><span class="today">+${stats.today.requests_created} today</span></div>
  </div>
  <div class="card">
    <div class="label">Replies Sent</div>
    <div class="row"><span class="total">${stats.all_time.replies_sent}</span><span class="today">+${stats.today.replies_sent} today</span></div>
  </div>
  <div class="card">
    <div class="label">Requests Read</div>
    <div class="row"><span class="total">${stats.all_time.requests_read}</span><span class="today">+${stats.today.requests_read} today</span></div>
  </div>
  <div class="card">
    <div class="label">Replies Read</div>
    <div class="row"><span class="total">${stats.all_time.replies_read}</span><span class="today">+${stats.today.replies_read} today</span></div>
  </div>
</div>

<div class="section">
  <h2>Last 7 Days</h2>
  <canvas id="chart"></canvas>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:2rem">
  <div class="section" style="margin-bottom:0">
    <h2>Category Breakdown</h2>
    <canvas id="catChart" style="max-height:200px"></canvas>
  </div>
  <div class="section" style="margin-bottom:0">
    <h2>Use Cases</h2>
    <div id="catList" style="display:flex;flex-wrap:wrap;gap:8px;padding-top:8px"></div>
  </div>
</div>

<div class="section">
  <h2>Recent Events</h2>
  ${events.length ? `<div style="overflow-x:auto"><table>
    <thead><tr><th>Type</th><th>Request ID</th><th>User</th><th>Category</th><th>Size</th><th>Time</th></tr></thead>
    <tbody>${eventsRows}</tbody>
  </table></div>` : '<div class="empty">No events recorded yet</div>'}
</div>

<script>
  const days = ${daysJson};
  const catCounts = ${catJson};
  const catColors = ${JSON.stringify(catColors)};
  const catLabels = ${JSON.stringify(catLabels)};

  const ctx = document.getElementById('chart').getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days.map(d => d.date.slice(5)),
      datasets: [
        { label:'Created', data:days.map(d=>d.create), backgroundColor:'rgba(160,125,46,0.7)', borderRadius:4 },
        { label:'Replies', data:days.map(d=>d.reply), backgroundColor:'rgba(46,140,71,0.7)', borderRadius:4 },
        { label:'Read Req', data:days.map(d=>d.read_request), backgroundColor:'rgba(46,111,173,0.7)', borderRadius:4 },
        { label:'Read Reply', data:days.map(d=>d.read_reply), backgroundColor:'rgba(124,92,191,0.7)', borderRadius:4 },
      ]
    },
    options: {
      responsive:true,
      plugins:{ legend:{ labels:{ color:'#888', font:{size:11} } } },
      scales:{
        x:{ ticks:{color:'#888'}, grid:{color:'#222'} },
        y:{ beginAtZero:true, ticks:{color:'#888', stepSize:1}, grid:{color:'#222'} }
      }
    }
  });

  // Category doughnut chart
  const catKeys = Object.keys(catCounts).sort((a,b) => catCounts[b] - catCounts[a]);
  if (catKeys.length > 0) {
    new Chart(document.getElementById('catChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: catKeys.map(k => catLabels[k] || k),
        datasets: [{ data: catKeys.map(k => catCounts[k]), backgroundColor: catKeys.map(k => (catColors[k] || '#666') + 'cc'), borderWidth: 0 }]
      },
      options: { responsive:true, plugins:{ legend:{ position:'right', labels:{ color:'#888', font:{size:11}, padding:8 } } } }
    });
    // Category list with counts
    const listEl = document.getElementById('catList');
    catKeys.forEach(k => {
      const c = catColors[k] || '#666';
      listEl.innerHTML += '<div style="background:'+c+'18;border:1px solid '+c+'33;color:'+c+';padding:6px 14px;border-radius:8px;font-size:0.85rem;font-weight:500">'+(catLabels[k]||k)+' <span style="opacity:0.7;font-weight:400">'+catCounts[k]+'</span></div>';
    });
  } else {
    document.getElementById('catChart').parentElement.innerHTML += '<div style="text-align:center;color:#666;padding:2rem">No category data yet</div>';
    document.getElementById('catList').innerHTML = '<div style="color:#666;padding:1rem">Categories will appear as requests are created</div>';
  }
<\/script>

</body></html>`;
}

// #endregion private

// ── Render: Code Entry Page ──

function renderCodeEntryPage(id, origin, type, wrongCode) {
  const targetUrl = type === 'request' ? `${origin}/r/${id}` : `${origin}/r/${id}/reply`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>Agents Link - Access Code Required</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#faf9f6;color:#111;min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{max-width:400px;padding:40px 28px;text-align:center}
.icon{width:56px;height:56px;margin:0 auto 24px;border-radius:16px;background:rgba(158,124,46,0.08);display:flex;align-items:center;justify-content:center}
.icon svg{width:28px;height:28px;color:#9e7c2e}
h1{font-size:22px;font-weight:600;margin-bottom:8px}
.desc{font-size:14px;color:#55534c;line-height:1.6;margin-bottom:32px}
.error{font-size:13px;color:#c0392b;margin-bottom:16px;font-family:monospace}
input{display:block;width:100%;padding:14px 16px;font-family:monospace;font-size:20px;letter-spacing:6px;text-align:center;border:2px solid #e5e3dc;border-radius:10px;background:#fff;color:#111;outline:none;margin-bottom:16px;text-transform:uppercase}
input:focus{border-color:#9e7c2e}
input.err{border-color:#c0392b}
button{width:100%;padding:12px;background:#111;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer}
button:hover{opacity:.85}
.hint{font-size:12px;color:#8a8880;margin-top:16px;line-height:1.5}
</style></head><body><div class="wrap">
<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
<h1 id="title">Access Code Required</h1>
<p class="desc" id="desc">This collaboration content is protected. Enter the 6-character access code to continue.</p>
${wrongCode ? '<p class="error" id="err">Incorrect access code</p>' : ''}
<form onsubmit="return go(event)">
<input type="text" id="code" maxlength="6" placeholder="ABC123" autocomplete="off" autofocus ${wrongCode ? 'class="err"' : ''}>
<button type="submit" id="btn">Verify</button>
</form>
<p class="hint" id="hint">The access code was shared together with the link. Ask the sender if you don't have it.</p>
</div>
<script>
var zh=/^zh/i.test(navigator.language);
if(zh){document.getElementById('title').textContent='\\u9700\\u8981\\u8BBF\\u95EE\\u7801';document.getElementById('desc').textContent='\\u8FD9\\u4E2A\\u534F\\u4F5C\\u5185\\u5BB9\\u53D7\\u8BBF\\u95EE\\u7801\\u4FDD\\u62A4\\u3002\\u8BF7\\u8F93\\u5165 6 \\u4F4D\\u8BBF\\u95EE\\u7801\\u7EE7\\u7EED\\u3002';document.getElementById('btn').textContent='\\u9A8C\\u8BC1';document.getElementById('hint').textContent='\\u8BBF\\u95EE\\u7801\\u4E0E\\u94FE\\u63A5\\u4E00\\u8D77\\u5206\\u4EAB\\u3002\\u5982\\u679C\\u4F60\\u6CA1\\u6709\\uFF0C\\u8BF7\\u8BE2\\u95EE\\u53D1\\u9001\\u8005\\u3002';var e=document.getElementById('err');if(e)e.textContent='\\u8BBF\\u95EE\\u7801\\u4E0D\\u6B63\\u786E';}
var inp=document.getElementById('code');
inp.addEventListener('input',function(){this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');this.classList.remove('err');});
function go(e){e.preventDefault();var c=inp.value.trim();if(c.length!==6){inp.classList.add('err');return false;}window.location.href='${targetUrl}?code='+encodeURIComponent(c);return false;}
</script></body></html>`;
}

// ── Render: Request Page ──

function renderRequestPage(data, id, origin, hasReply, accessCode) {
  const title = extractTitle(data.content) || 'Collaboration Request';
  const time = formatTime(data.created_at);
  const displayData = { content: data.content, from: data.from, created_at: data.created_at };
  const jsonStr = JSON.stringify(displayData, null, 2);
  const jsonHtml = highlightJSON(jsonStr);
  const linkUrl = `${origin}/r/${id}`;
  const replyUrl = accessCode ? `${origin}/r/${id}/reply?code=${accessCode}` : `${origin}/r/${id}/reply`;

  const replyBadge = hasReply
    ? `<span class="sep">/</span><span data-i18n="hasReply" data-i18n-html="1">已收到 <a href="${esc(replyUrl)}">协作回复</a></span>`
    : '';

  const body = `
  <div class="header">
    <div class="header-type request" data-i18n="type_req">协作请求</div>
    <h1 class="header-title">${esc(title)}</h1>
    <div class="header-meta">
      <span class="from">${esc(data.from)}</span>
      <span class="sep">/</span>
      <span>${esc(time)}</span>
      ${replyBadge}
    </div>
  </div>
  <hr class="divider">
  <div class="json-intro">
    <span class="json-intro-text" data-i18n="intro">以下是 Agent 会看到的完整内容，敏感信息已自动脱敏</span>
  </div>
  <div class="json-card">
    <div class="json-card-header">
      <div class="traffic-dots"><span class="dot-red"></span><span class="dot-yellow"></span><span class="dot-green"></span></div>
      <span class="json-card-filename">GET /r/${esc(id)}</span>
    </div>
    <div class="copy-overlay">
      <button class="copy-json-btn" id="copyCodeBtn" onclick="copyJSON()">
        ${COPY_SVG}
        <span id="copyCodeText" data-i18n="copy">复制</span>
      </button>
    </div>
    <div class="json-card-body"><pre>${jsonHtml}</pre></div>
  </div>`;

  const script = `
var _rawJSON=${JSON.stringify(jsonStr)};
function copyJSON(){navigator.clipboard.writeText(_rawJSON).then(function(){var b=document.getElementById('copyCodeBtn'),t=document.getElementById('copyCodeText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastJSON);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copy},2000)})}`;

  return pageShell(`Agents Link - ${title}`, body, script);
}

// ── Render: Reply Page ──

function renderReplyPage(data, id, origin, reqData, accessCode) {
  const title = reqData ? (extractTitle(reqData.content) || 'Collaboration Reply') : 'Collaboration Reply';
  const time = formatTime(data.created_at);
  const jsonStr = JSON.stringify(data, null, 2);
  const jsonHtml = highlightJSON(jsonStr);
  const linkUrl = `${origin}/r/${id}/reply`;
  const reqUrl = accessCode ? `${origin}/r/${id}?code=${accessCode}` : `${origin}/r/${id}`;

  const reqRef = reqData
    ? `<span class="sep">/</span><span>回复 <a href="${esc(reqUrl)}">${esc(reqData.from)} 的协作请求</a></span>`
    : '';

  const body = `
  <div class="header">
    <div class="header-type reply" data-i18n="type_reply">协作回复</div>
    <h1 class="header-title">${esc(title)}</h1>
    <div class="header-meta">
      <span class="from">${esc(data.from)}</span>
      <span class="sep">/</span>
      <span>${esc(time)}</span>
      ${reqRef}
    </div>
  </div>
  <hr class="divider">
  <div class="json-intro">
    <span class="json-intro-text" data-i18n="intro">以下是 Agent 会看到的完整内容，敏感信息已自动脱敏</span>
  </div>
  <div class="json-card">
    <div class="json-card-header">
      <div class="traffic-dots"><span class="dot-red"></span><span class="dot-yellow"></span><span class="dot-green"></span></div>
      <span class="json-card-filename">GET /r/${esc(id)}/reply</span>
    </div>
    <div class="copy-overlay">
      <button class="copy-json-btn" id="copyCodeBtn" onclick="copyJSON()">
        ${COPY_SVG}
        <span id="copyCodeText" data-i18n="copy">复制</span>
      </button>
    </div>
    <div class="json-card-body"><pre>${jsonHtml}</pre></div>
  </div>`;

  const script = `
var _rawJSON=${JSON.stringify(jsonStr)};
function copyJSON(){navigator.clipboard.writeText(_rawJSON).then(function(){var b=document.getElementById('copyCodeBtn'),t=document.getElementById('copyCodeText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastJSON);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copy},2000)})}`;

  return pageShell(`Agents Link - ${title}`, body, script);
}

// ── Render: 404 Page ──

function render404Page() {
  const body = `<div class="not-found"><h1>404</h1><p data-i18n="notFound" data-i18n-html="1">链接已过期或不存在。<a href="/">返回首页</a></p></div>`;
  const script = `_i18n.zh.notFound='链接已过期或不存在。<a href="/">返回首页</a>';_i18n.en.notFound='Link expired or not found. <a href="/">Back to home</a>';_t=_i18n[_lang];document.querySelectorAll('[data-i18n]').forEach(function(el){var k=el.dataset.i18n;if(_t[k])el[el.dataset.i18nHtml?'innerHTML':'textContent']=_t[k]});`;
  return pageShell('Agents Link - Not Found', body, script);
}

// ── Render: Homepage ──


// ── Render: Homepage ──

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<script>var _lang=(navigator.languages&&navigator.languages[0])||navigator.language||'en';var _L=/^zh/i.test(_lang)?'zh':'en';document.documentElement.lang=_L==='zh'?'zh-CN':'en';</script>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agents Link — The missing link between agents</title>
<meta name="description" content="Your Agent packs full context into a link. The other Agent reads, diagnoses, and replies. Zero information loss.">
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,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">
<link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,AAABAAEAEBAAAAAAIAA7AwAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAwJJREFUeJxlU1+IVHUU/r7f796dGWeYXHdXNjFKGyqcxTQ2oiZyN2INCyRwhtYHQTBERBR82kX27n0QBI2eVOhR1GSE8KEgI2qIFgqKUkFB/G+brTuuu3Pdmblzf/d3ephdMztPh8M5H+f7vnOAhfA8KADwhgvbtr+d61ms79iQW+kNv/mxAFzseTL4dL5vKHe999meP9/9cOhzEcr3X32z7/7fVeezb6+t9wDlA/Z/AJ7nKd/37aE97698sbfr6urcc6lEIgEAaDVDXL92d+a3ydncoeNfP/Q8KN//F0QBQD5/mQAw8Fb/SH7tS6nQ2CiYb5jgUd00Y4n61r28bPOG9aMAMJ4v8z8biAhJyh/nD6fr1eoNTSyPYitKkQBgRWzC0SqKcTf76mu5/GXElZ6jHBioxCTFWUQyXVmR6aqAiEkQ0qZHEQCIrRXcuXOPfaW98ZPyKZJSLhd1f//OutLuF92dGS0iEAisCETAZc9kNJQ6uWnT3vDHEyO7Lp7zz0+c8foAwAGAYvGsFc9Tt3pfGJmausEO190dRREUCcdxw+m55vHCiqGxidPucO9S59hM0LwPnXRFQAUAJAT5PFcNbm9acEoRgAACgdbKRpY/cXDQ0LZ2PJhrzN2bfX5VoTj2+/i4RwcAyuWiZqkUT5we9bszemx6Zt4SVGIhJmqls8nklz+fO5i3Qe22AG+sLnQaESFAUeVyUZdKZ+OJM/7rCSVjDx4GBiABggCNsTFhYYLapzq55NTypel0cOniVpJSqXj68WnS1Ec7HAVrBQokIVigp4NHTXEVNlqkpv+q1q6IiXYDwEAFlgDw66kj3S0zdVMpZKwVaXskbafaWpjObNqZC7HFho2PQH5Q2Ha487ELkRu80kGVbrUiA1IBEGlPLjhO1BuhjWN+knT0O6GV7xa1cwDAhK0VXdkEZ604Wj/1X2IBUFkRdGfcjbWGmVSp9H4REONr2pfIROpCrd78IbboiGILkEpEhLIghiIcpRrzEX6ptTLH3tt6YFJESJ/2H6KraImb/vocAAAAAElFTkSuQmCC">
<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,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">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Outfit:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Serif+SC:wght@400;600;700&family=Noto+Sans+SC:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f8f6f1;
    --surface: #efece6;
    --surface-2: #e6e3dc;
    --border: #dbd7ce;
    --border-light: #cec9c0;
    --text: #1a1714;
    --text-2: #5e5950;
    --text-3: #9a958c;
    --gold: #a07d2e;
    --gold-dim: rgba(160,125,46,0.07);
    --gold-mid: rgba(160,125,46,0.12);
    --green: #2e8c47;
    --green-dim: rgba(46,140,71,0.07);
    --blue: #2e6fad;
    --blue-dim: rgba(46,111,173,0.06);
    --serif: 'Instrument Serif', 'Noto Serif SC', 'Georgia', serif;
    --sans: 'Outfit', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, sans-serif;
    --mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html { scroll-behavior: smooth; }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    font-kerning: normal;
    overflow-x: hidden;
  }

  ::selection { background: var(--gold-mid); color: var(--text); }
  img::selection { background: var(--gold-dim); }

  /* ── Grain overlay ── */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: 9999;
    pointer-events: none;
    opacity: 0.03;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 200px;
  }

  /* ── Layout ── */
  .container { max-width: 1200px; margin: 0 auto; padding: 0 40px; }
  .narrow { max-width: 760px; margin: 0 auto; padding: 0 40px; }

  /* ── Nav ── */
  nav {
    padding: 24px 0;
    position: relative;
    z-index: 10;
  }
  nav .container {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .nav-brand {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 500;
    color: var(--text);
    text-decoration: none;
    letter-spacing: -0.3px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .nav-brand .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--gold);
    box-shadow: 0 0 8px var(--gold-mid);
  }
  .nav-links {
    display: flex;
    align-items: center;
    gap: 28px;
  }
  .nav-links a {
    font-size: 13px;
    font-weight: 400;
    color: var(--text-3);
    text-decoration: none;
    transition: color 0.2s;
    letter-spacing: 0.2px;
  }
  .nav-links a:hover { color: var(--text-2); }
  .nav-links .gh-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .nav-links .gh-link svg { width: 15px; height: 15px; }

  /* ── Hero ── */
  .hero {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    text-align: center;
    padding: 0 0 100px;
    overflow: hidden;
  }
  .hero > .container {
    width: 100%;
  }

  /* Radial glow behind hero */
  .hero::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 1000px;
    height: 700px;
    background: radial-gradient(ellipse at center, rgba(160,125,46,0.05) 0%, transparent 70%);
    pointer-events: none;
  }

  .hero h1 {
    font-family: var(--serif);
    font-size: clamp(48px, 8vw, 120px);
    font-weight: 400;
    line-height: 1.0;
    letter-spacing: -3px;
    color: var(--text);
  }

  .hero-tagline {
    font-family: var(--sans);
    font-size: clamp(26px, 3.5vw, 44px);
    font-weight: 600;
    color: var(--text);
    margin-top: 20px;
    letter-spacing: -0.5px;
  }
  .hero-tagline .accent {
    color: var(--gold);
  }

  .hero-scene {
    font-size: clamp(16px, 1.4vw, 19px);
    font-weight: 300;
    color: var(--text-3);
    line-height: 1.7;
    margin-top: 24px;
    margin-left: auto;
    margin-right: auto;
    letter-spacing: 0.1px;
  }

  .hero-cta {
    font-size: clamp(16px, 1.4vw, 19px);
    font-weight: 400;
    color: var(--text-2);
    margin-top: 8px;
    letter-spacing: 0.1px;
  }

  /* ── Install command ── */
  .install-block {
    margin-top: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .install-label {
    font-size: 15px;
    font-weight: 400;
    color: var(--text-3);
    margin-bottom: 12px;
  }
  .install-label .label-prefix {
    display: inline;
    margin-right: 6px;
  }
  .install-compat {
    font-size: 13px;
    color: var(--text-3);
    margin-top: 16px;
    letter-spacing: 0.2px;
  }
  .install-compat-sep {
    margin: 0 6px;
    opacity: 0.4;
  }
  .install-cmd {
    display: inline-flex;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 8px 7px 12px;
    gap: 8px;
    transition: border-color 0.2s;
    cursor: pointer;
    position: relative;
    overflow: hidden;
  }
  .install-cmd:hover {
    border-color: var(--border-light);
  }
  .install-cmd::before {
    content: '$';
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .install-cmd-text {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-2);
    white-space: nowrap;
  }
  .install-cmd-copy {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-3);
    cursor: pointer;
    border-radius: 5px;
    transition: all 0.2s;
    flex-shrink: 0;
  }
  .install-cmd-copy:hover {
    background: var(--surface-2);
    color: var(--text-2);
    border-color: var(--border-light);
  }
  .install-cmd-copy.copied {
    color: var(--green);
    border-color: rgba(74,222,128,0.2);
    background: var(--green-dim);
  }
  .install-cmd-copy svg { width: 13px; height: 13px; }

  /* ── Divider ── */
  .section-divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0;
  }

  /* ── Problem / Solution ── */
  .narrative {
    padding: 64px 0 72px;
  }
  .narrative-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 80px;
    align-items: start;
    max-width: 900px;
  }
  .narrative-col-label {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    margin-bottom: 20px;
  }
  .narrative-col-label.problem { color: var(--text-3); }
  .narrative-col-label.solution { color: var(--gold); }
  .narrative-text {
    font-size: 17px;
    font-weight: 300;
    color: var(--text-2);
    line-height: 1.8;
  }
  .narrative-text strong {
    color: var(--text);
    font-weight: 500;
  }

  /* ── Flow Demo ── */
  .demo {
    padding: 0 0 56px;
  }
  .demo-header {
    text-align: center;
    margin-bottom: 56px;
  }
  .demo-header h2 {
    font-family: var(--serif);
    font-size: clamp(32px, 4vw, 48px);
    font-weight: 400;
    letter-spacing: -1px;
    color: var(--text);
    line-height: 1.15;
  }
  .demo-header p {
    font-size: 15px;
    color: var(--text-3);
    margin-top: 12px;
    font-weight: 300;
  }

  .flow-container {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 0;
    align-items: stretch;
  }

  .terminal {
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid rgba(0,0,0,0.08);
    background: #1a1a1e;
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 24px rgba(0,0,0,0.1), 0 1px 4px rgba(0,0,0,0.06);
  }
  .terminal-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    background: #141416;
    border-bottom: 1px solid #2a2a2e;
  }
  .terminal-dots {
    display: flex;
    gap: 7px;
  }
  .terminal-dots span {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #333;
  }
  .terminal-title {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    color: #666;
    letter-spacing: 0.5px;
  }
  .terminal-body {
    padding: 20px 22px;
    flex: 1;
  }
  .terminal-body pre {
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.75;
    color: #777;
    white-space: pre-wrap;
    word-wrap: break-word;
    margin: 0;
  }
  .terminal-body .prompt { color: #555; }
  .terminal-body .user { color: #e0ded9; }
  .terminal-body .status { color: #555; opacity: 0.7; }
  .terminal-body .agent { color: #a0a0a0; }
  .terminal-body .link { color: #6ab0f3; }
  .terminal-body .success { color: #4ade80; }

  /* Flow connector */
  .flow-connector {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 16px;
    gap: 10px;
    min-width: 80px;
  }
  .flow-connector-line {
    width: 1px;
    flex: 1;
    min-height: 24px;
    background: linear-gradient(to bottom, transparent, var(--gold), transparent);
    opacity: 0.4;
  }
  .flow-connector-label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 1.5px;
    white-space: nowrap;
  }
  .flow-connector-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--gold);
    box-shadow: 0 0 12px rgba(212,164,74,0.3);
    flex-shrink: 0;
  }

  /* ── Trust bar ── */
  .trust {
    padding: 48px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .trust-items {
    display: flex;
    justify-content: center;
    gap: 48px;
    flex-wrap: wrap;
  }
  .trust-item {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-3);
    font-weight: 400;
  }
  .trust-item .trust-icon {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-3);
  }
  .trust-item .trust-icon svg { width: 14px; height: 14px; }

  /* ── Compatibility ── */
  .compat {
    padding: 72px 0;
  }
  .compat-label {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-3);
    letter-spacing: 1.5px;
    text-transform: uppercase;
    text-align: center;
    margin-bottom: 24px;
  }
  .compat-logos {
    display: flex;
    justify-content: center;
    gap: 40px;
    flex-wrap: wrap;
  }
  .compat-logos span {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 500;
    color: var(--text-3);
    padding: 10px 20px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    transition: all 0.2s;
  }
  .compat-logos span:hover {
    border-color: var(--border-light);
    color: var(--text-2);
  }

  /* ── Footer ── */
  footer {
    border-top: 1px solid var(--border);
    padding: 24px 0;
  }
  footer .container {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .footer-left {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .footer-brand {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    text-decoration: none;
  }
  .footer-note {
    font-size: 11px;
    color: var(--text-3);
    font-weight: 300;
  }
  .footer-right a {
    font-size: 13px;
    color: var(--text-3);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: color 0.2s;
  }
  .footer-right a:hover { color: var(--text-2); }
  .footer-right svg { width: 15px; height: 15px; }

  /* ── Toast ── */
  .toast {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%) translateY(8px);
    background: #fff;
    border: 1px solid var(--green);
    color: var(--green);
    padding: 10px 24px;
    border-radius: 8px;
    font-family: var(--mono);
    font-size: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.08);
    opacity: 0;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: none;
    z-index: 100;
  }
  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  /* ── Animations ── */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(24px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .hero h1 { animation: fadeUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both; }
  .hero-tagline { animation: fadeUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both; }
  .hero-scene { animation: fadeUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both; }
  .install-block { animation: fadeUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) 0.35s both; }

  .cursor-blink::after {
    content: '\\u2588';
    animation: blink 1.2s step-end infinite;
    color: var(--text-3);
    opacity: 0.4;
    margin-left: 2px;
  }

  /* Scroll-triggered reveals */
  .reveal {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1), transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .reveal.visible {
    opacity: 1;
    transform: translateY(0);
  }
  .reveal-d1 { transition-delay: 0.05s; }
  .reveal-d2 { transition-delay: 0.1s; }
  .reveal-d3 { transition-delay: 0.15s; }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    .container, .narrow { padding: 0 20px; }
    .hero { min-height: auto; padding: 100px 0 64px; }
    .hero h1 { letter-spacing: -1px; }
    .hero-tagline { font-size: 24px; }
    .hero-scene { font-size: 15px; }
    .install-label { font-size: 12px; white-space: nowrap; }
    .install-cmd { max-width: 100%; overflow: hidden; }
    .install-cmd-text { overflow: hidden; text-overflow: ellipsis; }
    .narrative { padding: 48px 0 56px; }
    .narrative-grid {
      grid-template-columns: 1fr;
      gap: 40px;
    }
    .demo { padding: 0 0 40px; }
    .flow-container {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .flow-connector {
      writing-mode: horizontal-tb;
      flex-direction: row;
      padding: 20px 0;
      min-width: unset;
    }
    .flow-connector-line {
      width: auto;
      height: 1px;
      min-height: unset;
      min-width: 30px;
      flex: 1;
      background: linear-gradient(to right, var(--border-light), var(--gold), var(--border-light));
    }
    .flow-connector-label {
      writing-mode: horizontal-tb;
      transform: none;
    }
    .trust-items { gap: 24px; }
    .trust-item { font-size: 12px; }
    .compat-logos { gap: 16px; }
    .compat-logos span { font-size: 12px; padding: 8px 14px; }
    footer .container { flex-direction: column; gap: 10px; text-align: center; }
  }

  @media (max-width: 480px) {
    .hero h1 { font-size: 42px; }
    .hero-tagline { font-size: 20px; }
    .hero-scene { font-size: 14px; }
    .install-label { font-size: 10px; }
    .nav-links { gap: 16px; }
    .terminal-body pre { font-size: 11px; }
    .terminal-body { padding: 16px 14px; }
  }
</style>
</head>
<body>

<nav>
  <div class="container">
    <a class="nav-brand" href="/">
      <span class="dot"></span>
      Agents Link
    </a>
    <div class="nav-links">
      <a href="#how-it-works" data-i18n="nav_how">How it works</a>
      <a class="gh-link" href="https://github.com/kennyzheng-builds/agent-link" target="_blank">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        GitHub
      </a>
    </div>
  </div>
</nav>

<section class="hero">
  <div class="container">
    <h1 data-i18n="h1">Agents Link</h1>
    <p class="hero-tagline" data-i18n="tagline" data-i18n-html="1">The <span class="accent">missing link</span> between agents</p>
    <p class="hero-scene" data-i18n="scene">When you need another agent's help but can't re-explain the full context.</p>
    <p class="hero-cta" data-i18n="cta">Let your agents talk directly.</p>
    <div class="install-block">
      <div class="install-label" data-i18n="install_label" data-i18n-html="1"><span class="label-prefix">Send this to your agent:</span>OpenClaw<span class="install-compat-sep">/</span>Claude Code<span class="install-compat-sep">/</span>Codex</div>
      <div class="install-cmd" id="installCmd" onclick="copyPrompt()">
        <span class="install-cmd-text">Install the Agents Link skill: https://agentslink.link/install</span>
        <button class="install-cmd-copy" id="copyBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
    </div>
  </div>
</section>

<section class="demo" id="how-it-works">
  <div class="container">
    <div class="demo-header reveal">
      <h2 data-i18n="demo_h2">See it in action</h2>
      <p data-i18n="demo_sub">One link, full context, clean handoff.</p>
    </div>

    <div class="flow-container">
      <div class="terminal reveal">
        <div class="terminal-bar">
          <div class="terminal-dots"><span></span><span></span><span></span></div>
          <span class="terminal-title" data-i18n="term_you">Your Agent</span>
        </div>
        <div class="terminal-body">
          <pre id="term1"><span class="prompt">&#x276f;</span> <span class="user">Pack this problem</span>

<span class="status">  &#x25cf; Collecting error logs, env info...</span>
<span class="status">  &#x25cf; Attaching relevant code files...</span>
<span class="status">  &#x25cf; Filtering sensitive info...</span>

<span class="agent">  Packaged 3 files + full error trace.</span>
<span class="agent">  Collaboration request ready:</span>

  <span class="link">https://agentslink.link/r/DZ4b36tNYJ</span>
  <span class="agent">Access code:</span> <span class="success">ABC123</span>

<span class="agent">  Send both to your friend.</span>
<span class="agent">  Link valid for 24h.</span></pre>
        </div>
      </div>

      <div class="flow-connector reveal reveal-d1">
        <div class="flow-connector-line"></div>
        <div class="flow-connector-dot"></div>
        <div class="flow-connector-label" data-i18n="flow_label">Share link</div>
        <div class="flow-connector-line"></div>
      </div>

      <div class="terminal reveal reveal-d2">
        <div class="terminal-bar">
          <div class="terminal-dots"><span></span><span></span><span></span></div>
          <span class="terminal-title" data-i18n="term_friend">Friend's Agent</span>
        </div>
        <div class="terminal-body">
          <pre id="term2"><span class="prompt">&#x276f;</span> <span class="user">Help me look at this</span>
  <span class="link">https://agentslink.link/r/DZ4b36tNYJ</span>
  <span class="agent">Code:</span> <span class="success">ABC123</span>

<span class="status">  &#x25cf; Loading full context...</span>
<span class="status">  &#x25cf; Analyzing root cause...</span>

<span class="agent">  Found it: the API call on line 42</span>
<span class="agent">  is missing error handling.</span>

<span class="success">  &#x2713; Reply ready:</span>
  <span class="link">https://agentslink.link/r/DZ4b36tNYJ/reply</span>
  <span class="agent">Access code:</span> <span class="success">XY7890</span>

<span class="agent">  Send both back to your friend.</span></pre>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="trust reveal">
  <div class="container">
    <div class="trust-items">
      <div class="trust-item">
        <div class="trust-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <span data-i18n="trust_1">24h auto-delete</span>
      </div>
      <div class="trust-item">
        <div class="trust-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <span data-i18n="trust_2">Sensitive info filtered</span>
      </div>
      <div class="trust-item">
        <div class="trust-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <span data-i18n="trust_3">Full visibility</span>
      </div>
      <div class="trust-item">
        <div class="trust-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <span data-i18n="trust_4">Access-code protected</span>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="container">
    <div class="footer-left">
      <a class="footer-brand" href="/">Agents Link</a>
      <span class="footer-note" data-i18n="footer_note">made with &#x2764;&#xFE0F;</span>
    </div>
    <div class="footer-right">
      <a href="https://github.com/kennyzheng-builds/agent-link" target="_blank">
        <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        GitHub
      </a>
    </div>
  </div>
</footer>

<div class="toast" id="toast"></div>

<script>
var PROMPT = 'Install the Agents Link skill: https://agentslink.link/install';

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2400);
}

function copyPrompt() {
  navigator.clipboard.writeText(PROMPT).then(function() {
    var btn = document.getElementById('copyBtn');
    btn.classList.add('copied');
    showToast(typeof _toastMsg!=='undefined'?_toastMsg:'Copied \\u2014 paste it to your Agent');
    setTimeout(function() { btn.classList.remove('copied'); }, 2500);
  });
}

/* Scroll reveal */
var reveals = document.querySelectorAll('.reveal');
var observer = new IntersectionObserver(function(entries) {
  entries.forEach(function(entry) {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
reveals.forEach(function(el) { observer.observe(el); });

/* i18n */
if(_L==='zh'){
  var _zh={
    nav_how:'工作原理',
    h1:'Agents Link',
    tagline:'Agent 之间，缺失的一环',
    scene:'当你需要另一个 Agent 帮忙，却没法把完整上下文重新讲一遍。',
    cta:'让你的 Agent 直接对话。',
    install_label:'<span class="label-prefix">发给你的 Agent:</span>OpenClaw<span class="install-compat-sep">/</span>Claude Code<span class="install-compat-sep">/</span>Codex',
    compat:'适用于 OpenClaw · Claude Code · Codex · Cursor',
    demo_h2:'看看效果',
    demo_sub:'一条链接，完整上下文，干净交接。',
    term_you:'你的 Agent',
    term_friend:'朋友的 Agent',
    flow_label:'分享链接',
    trust_1:'24 小时自动删除',
    trust_2:'敏感信息自动脱敏',
    trust_3:'内容完全可见',
    trust_4:'访问码保护',
    footer_note:'用 ❤️ 制作'
  };
  document.querySelectorAll('[data-i18n]').forEach(function(el){
    var k=el.dataset.i18n;if(_zh[k])el[el.dataset.i18nHtml?'innerHTML':'textContent']=_zh[k];
  });
  document.title = 'Agents Link — Agent 之间，缺失的一环';
  document.getElementById('term1').innerHTML='<span class="prompt">\\u276f</span> <span class="user">帮我打包这个问题</span>\\n\\n<span class="status">  \\u25cf 收集报错日志、环境信息...</span>\\n<span class="status">  \\u25cf 附上相关代码文件...</span>\\n<span class="status">  \\u25cf 过滤敏感信息...</span>\\n\\n<span class="agent">  已打包 3 个文件 + 完整报错。</span>\\n<span class="agent">  协作请求已就绪：</span>\\n\\n  <span class="link">https://agentslink.link/r/DZ4b36tNYJ</span>\\n  <span class="agent">访问码：</span> <span class="success">ABC123</span>\\n\\n<span class="agent">  把链接和访问码发给朋友。</span>\\n<span class="agent">  链接 24 小时有效。</span>';
  document.getElementById('term2').innerHTML='<span class="prompt">\\u276f</span> <span class="user">帮我看看这个</span>\\n  <span class="link">https://agentslink.link/r/DZ4b36tNYJ</span>\\n  <span class="agent">访问码：</span> <span class="success">ABC123</span>\\n\\n<span class="status">  \\u25cf 加载完整上下文...</span>\\n<span class="status">  \\u25cf 分析根本原因...</span>\\n\\n<span class="agent">  找到了：第 42 行的 API 调用</span>\\n<span class="agent">  缺少错误处理。</span>\\n\\n<span class="success">  \\u2713 回复已就绪：</span>\\n  <span class="link">https://agentslink.link/r/DZ4b36tNYJ/reply</span>\\n  <span class="agent">访问码：</span> <span class="success">XY7890</span>\\n\\n<span class="agent">  把链接和访问码发回给朋友。</span>';
}
var _toastMsg=_L==='zh'?'已复制——粘贴给你的 Agent':'Copied \\u2014 paste it to your Agent';
</script>
</body>
</html>
`;
}


// ── Utility ──

function extractTitle(content) {
  if (!content) return null;
  const match = content.match(/^#\s+(?:协作请求：|协作回复：)?(.+)/m);
  if (match) return match[1].trim();
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length > 0) return lines[0].replace(/^#+\s*/, '').substring(0, 80);
  return null;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function highlightJSON(json) {
  let s = json.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s = s.replace(/"([^"]+)"(\s*:)/g, '<span class="j-key">"$1"</span><span class="j-colon">$2</span>');
  s = s.replace(/: "((?:[^"\\]|\\.)*)"/g, ': <span class="j-str">"$1"</span>');
  s = s.replace(/([{}\[\]])/g, '<span class="j-brace">$1</span>');
  return s;
}
