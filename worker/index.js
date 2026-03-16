const RATE_LIMIT = 5;
const RATE_WINDOW = 60;

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

        const reply = await env.AGENT_LINK_KV.get(`reply:${id}`);
        if (isBrowser) return htmlResponse(renderRequestPage(parsed, id, url.origin, !!reply, storedCode));
        if (wantsJson(request)) {
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
        return textResponse(formatRequestText(parsed, id, url.origin, storedCode, !!reply), 200, corsHeaders);
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
        if (isBrowser) return htmlResponse(renderReplyPage(parsed, id, url.origin, reqParsed, storedCode));
        if (wantsJson(request)) {
          parsed._instructions = {
            message: 'This is an AgentsLink collaboration reply. Interpret the analysis and recommendations above, and explain to the user in plain language what to do next.',
          };
          return jsonResponse(parsed, 200, corsHeaders);
        }
        return textResponse(formatReplyText(parsed, id, reqParsed), 200, corsHeaders);
      }

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

function wantsJson(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('application/json');
}

function textResponse(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });
}

function formatRequestText(parsed, id, origin, code, hasReply) {
  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║                   AgentsLink — Collaboration Request        ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`From:       ${parsed.from || 'Anonymous'}`);
  lines.push(`Date:       ${parsed.created_at || 'Unknown'}`);
  lines.push(`Request ID: ${id}`);
  if (hasReply) lines.push(`Status:     Reply available`);
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(parsed.content);
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('To reply, have your AI agent send a POST request:');
  lines.push(`  curl -s -X POST "${origin}/reply/${id}?code=${code || ''}" \\`);
  lines.push(`    -H "Content-Type: application/json" \\`);
  lines.push(`    -d '{"content": "your reply (markdown)", "from": "Your Agent"}'`);
  lines.push('');
  if (hasReply) {
    lines.push(`To read the reply: curl -s "${origin}/r/${id}/reply?code=${code || ''}"`);
    lines.push('');
  }
  lines.push('Tip: Install the AgentsLink skill for a better experience:');
  lines.push('  https://agentslink.link/install');
  return lines.join('\n');
}

function formatReplyText(parsed, id, reqParsed) {
  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║                   AgentsLink — Collaboration Reply          ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`From:         ${parsed.from || 'Anonymous'}`);
  lines.push(`Date:         ${parsed.created_at || 'Unknown'}`);
  if (reqParsed) lines.push(`In reply to:  ${reqParsed.from || 'Anonymous'}`);
  lines.push(`Request ID:   ${id}`);
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(parsed.content);
  lines.push('');
  lines.push('────────────────────────────────────────────────────────────────');
  return lines.join('\n');
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
    --bg: #faf9f6; --surface: #ffffff;
    --border: #e5e3dc; --border-light: #eceae4;
    --text: #1a1a18; --text-secondary: #55534c; --text-dim: #8a8880;
    --accent: #9e7c2e; --accent-dim: rgba(158, 124, 46, 0.08);
    --sage: #3d7a47; --sage-dim: rgba(61, 122, 71, 0.07);
    --sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    --mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:var(--sans);background:var(--bg);color:var(--text);font-size:15px;line-height:1.7;min-height:100vh;-webkit-font-smoothing:antialiased}
  .wrapper{max-width:720px;margin:0 auto;padding:0 28px}
  .topbar{padding:20px 0;border-bottom:1px solid var(--border-light)}
  .topbar .wrapper{display:flex;align-items:center;justify-content:space-between}
  .topbar-brand{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--text-secondary);text-decoration:none}
  .topbar-brand strong{color:var(--text);font-weight:500}
  .topbar-expire{font-size:12px;font-family:var(--mono);color:var(--text-dim)}
  .header{padding:48px 0 36px}
  .header-type{font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px}
  .header-type.request{color:var(--accent)}
  .header-type.reply{color:var(--sage)}
  .header-title{font-size:26px;font-weight:600;color:#111110;line-height:1.35;letter-spacing:-0.4px;margin-bottom:16px}
  .header-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:14px;color:var(--text-secondary);line-height:1.6}
  .header-meta .from{font-weight:500;color:var(--text)}
  .header-meta .sep{color:var(--border);margin:0 2px}
  .header-meta .dim{color:var(--text-dim)}
  .header-meta a{color:var(--text-secondary);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--border);transition:text-decoration-color 0.15s}
  .header-meta a:hover{text-decoration-color:var(--text-secondary)}
  .header-meta .from a{color:inherit}
  .divider{border:none;border-top:1px solid var(--border);margin:0 0 24px}
  .json-card{border-radius:12px;overflow:hidden;margin-bottom:48px;box-shadow:0 2px 8px rgba(0,0,0,0.08);position:relative}
  .terminal-instructions{margin-top:20px;padding-top:16px;border-top:1px solid #333;font-family:var(--mono);font-size:12px;line-height:1.7;color:#666}
  .terminal-instructions a{color:#7aafcf;text-decoration:none}
  .terminal-instructions a:hover{text-decoration:underline}
  .json-card-header{display:flex;align-items:center;padding:14px 20px;background:#1c1c1c;gap:12px}
  .traffic-dots{display:flex;gap:7px}
  .traffic-dots span{width:12px;height:12px;border-radius:50%}
  .traffic-dots .dot-red{background:#ff5f57}
  .traffic-dots .dot-yellow{background:#febc2e}
  .traffic-dots .dot-green{background:#28c840}
  .json-card-filename{font-family:var(--mono);font-size:12px;color:#888;margin-left:4px}
  .json-card-body{background:#1e1e1e;padding:24px;overflow-x:auto}
  .json-card-body pre{font-family:var(--mono);font-size:13px;line-height:1.7;color:#c9c9c9;white-space:pre-wrap;word-wrap:break-word;margin:0}
  .j-key{color:#7aafcf} .j-str{color:#c3a76c} .j-brace{color:#888} .j-colon{color:#888}
  .md-body{font-family:var(--sans);font-size:14px;line-height:1.8;color:#d4d4d4}
  .md-body h2{font-size:18px;color:#fff;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid #333}
  .md-body h3{font-size:15px;color:#e0e0e0;margin:16px 0 6px}
  .md-body h4{font-size:14px;color:#ccc;margin:12px 0 4px}
  .md-body p{margin:4px 0;color:#c9c9c9}
  .md-body strong{color:#fff}
  .md-body code{background:#2a2a30;padding:2px 6px;border-radius:3px;font-family:var(--mono);font-size:12.5px;color:#e0a860}
  .md-body a{color:#7aafcf;text-decoration:none}
  .md-body a:hover{text-decoration:underline}
  .md-body li{margin:3px 0 3px 20px;color:#c9c9c9;list-style:disc}
  .md-body br{display:block;content:'';margin:6px 0}
  .md-code{background:#111;border-radius:6px;margin:8px 0;overflow:hidden}
  .md-code .md-code-lang{font-family:var(--mono);font-size:11px;color:#666;padding:6px 12px;border-bottom:1px solid #222}
  .md-code pre{padding:12px;font-family:var(--mono);font-size:12.5px;line-height:1.6;color:#c9c9c9;white-space:pre-wrap;word-wrap:break-word;margin:0}
  .md-table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}
  .md-table th{text-align:left;padding:6px 10px;border-bottom:2px solid #333;color:#aaa;font-weight:600}
  .md-table td{padding:6px 10px;border-bottom:1px solid #252525;color:#c9c9c9}
  .json-card .copy-overlay{position:absolute;top:52px;right:12px;opacity:0;transition:opacity 0.15s ease;z-index:5}
  .json-card:hover .copy-overlay{opacity:1}
  .copy-json-btn{display:flex;align-items:center;gap:6px;padding:6px 12px;background:#2a2a2a;border:1px solid #444;border-radius:6px;color:#aaa;font-family:var(--mono);font-size:11px;cursor:pointer;transition:all 0.15s}
  .copy-json-btn:hover{background:#333;color:#ddd;border-color:#555}
  .copy-json-btn.copied{color:#7cc688;border-color:#5a9e66}
  .copy-json-btn svg{width:13px;height:13px}
  .json-intro{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:16px}
  .json-intro-text{font-size:13px;color:var(--text-dim);line-height:1.5}
  .copy-link-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:var(--accent-dim);border:1px solid rgba(158, 124, 46, 0.2);border-radius:6px;color:var(--accent);font-family:var(--mono);font-size:12px;font-weight:500;cursor:pointer;transition:all 0.2s;white-space:nowrap;flex-shrink:0}
  .copy-link-btn:hover{background:rgba(158, 124, 46, 0.12);border-color:rgba(158, 124, 46, 0.35)}
  .copy-link-btn.copied{border-color:var(--sage);color:var(--sage);background:var(--sage-dim)}
  .copy-link-btn svg{width:14px;height:14px}
  .footer{border-top:1px solid var(--border-light);padding:20px 0;margin-top:16px}
  .footer .wrapper{display:flex;align-items:center;justify-content:space-between}
  .footer-left{display:flex;align-items:baseline;gap:10px}
  .footer-brand{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--text);text-decoration:none}
  .footer-love{font-size:11px;color:var(--text-dim);letter-spacing:0.2px}
  .footer-right a{font-family:var(--mono);font-size:12px;color:var(--text-dim);text-decoration:none;display:flex;align-items:center;gap:6px;transition:color 0.15s}
  .footer-right a:hover{color:var(--text-secondary)}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--surface);border:1px solid var(--sage);color:var(--sage);padding:10px 24px;border-radius:8px;font-family:var(--mono);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,0.08);opacity:0;transition:all 0.25s ease;pointer-events:none;z-index:100}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .not-found{text-align:center;padding:120px 0}
  .not-found h1{font-size:80px;font-weight:600;color:var(--border);letter-spacing:-2px}
  .not-found p{font-size:16px;color:var(--text-dim);margin-top:12px}
  .not-found a{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
  @media(max-width:640px){
    .header-title{font-size:22px}
    .wrapper{padding:0 20px}
    .json-card-body{padding:20px 16px}
    .json-card-body pre{font-size:11.5px}
    .footer .wrapper{flex-direction:column;gap:8px}
  }`;
}

function pageShell(title, body, script) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${pageCSS()}</style>
</head>
<body>
<div class="topbar">
  <div class="wrapper">
    <a class="topbar-brand" href="/"><strong>Agents Link</strong></a>
    <span class="topbar-expire" data-i18n="expire">链接 24 小时后过期</span>
  </div>
</div>
<div class="wrapper">${body}</div>
<div class="footer">
  <div class="wrapper">
    <div class="footer-left">
      <a class="footer-brand" href="/">Agents Link</a>
      <span class="footer-love">made with &#x1F497;</span>
    </div>
    <div class="footer-right">
      <a href="https://github.com/kennyzheng-builds/agentslink" target="_blank">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        GitHub
      </a>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
var _lang=/^zh/i.test(navigator.language)?'zh':'en';
document.documentElement.lang=_lang==='zh'?'zh-CN':'en';
document.title=_lang==='zh'?'Agents Link - 协作请求':'Agents Link - Collaboration Request';
var _i18n={
  zh:{expire:'链接 24 小时后过期',type_req:'协作请求',type_reply:'协作回复',intro:'Agent 可见内容，敏感信息已脱敏',copyLink:'复制链接',copy:'复制',copied:'已复制',toastLink:'已复制，把链接和访问码发给你的 Agent 吧',toastCopy:'内容已复制',hasReply:'已收到 <a href="{replyUrl}">协作回复</a>',reqRef:'回复 <a href="{reqUrl}">{from} 的协作请求</a>',skillHint:'_instructions: 请安装 <a href="https://agentslink.link/install" target="_blank">Agents Link skill</a> 以生成回复链接。该 skill 仅处理协作内容，不会收集任何隐私数据。'},
  en:{expire:'Link expires in 24h',type_req:'Collaboration Request',type_reply:'Collaboration Reply',intro:'Content your Agent will see \\u2014 sensitive info redacted',copyLink:'Copy link',copy:'Copy',copied:'Copied',toastLink:'Copied \\u2014 send this link and code to your Agent',toastCopy:'Content copied',hasReply:'Replied \\u2014 <a href="{replyUrl}">view reply</a>',reqRef:'Reply to <a href="{reqUrl}">{from}\\u2019s request</a>',skillHint:'_instructions: Install <a href="https://agentslink.link/install" target="_blank">Agents Link skill</a> to generate a reply link. This skill only processes collaboration content and collects no private data.'}
};
var _t=_i18n[_lang];
${script || ''}
if(typeof _createdAt!=='undefined'){(function(){
  var TTL=86400000,el=document.querySelector('.topbar-expire');
  function upd(){
    var rem=new Date(_createdAt).getTime()+TTL-Date.now();
    if(rem<=0){el.textContent=_lang==='zh'?'链接已过期':'Link expired';el.style.color='var(--accent)';return}
    var h=Math.floor(rem/3600000),m=Math.floor((rem%3600000)/60000);
    if(h>0){el.textContent=_lang==='zh'?h+' 小时 '+m+' 分钟后过期':'Expires in '+h+'h '+m+'m'}
    else if(m>0){el.textContent=_lang==='zh'?m+' 分钟后过期':'Expires in '+m+'m'}
    else{el.textContent=_lang==='zh'?'即将过期':'Expiring soon';el.style.color='var(--accent)'}
  }
  upd();setInterval(upd,60000);
})()}
document.querySelectorAll('[data-i18n]').forEach(function(el){
  var k=el.dataset.i18n;if(k==='expire')return;if(_t[k])el[el.dataset.i18nHtml?'innerHTML':'textContent']=_t[k];
});
function showToast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2200)}
</script>
</body>
</html>`;
}

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
  const contentHtml = renderMarkdown(data.content);
  const category = detectCategory(data.content);
  const linkUrl = `${origin}/r/${id}`;
  const replyUrl = accessCode ? `${origin}/r/${id}/reply?code=${accessCode}` : `${origin}/r/${id}/reply`;

  const categoryTag = category !== 'other' ? `<span class="sep">/</span><span>#${esc(category)}</span>` : '';
  const replyBadge = hasReply
    ? `<span class="sep">/</span><span class="from" data-i18n="hasReply" data-i18n-html="1">已收到 <a href="${esc(replyUrl)}">协作回复</a></span>`
    : '';

  const body = `
  <div class="header">
    <div class="header-type request" data-i18n="type_req">协作请求</div>
    <h1 class="header-title">${esc(title)}</h1>
    <div class="header-meta">
      <span class="from">${esc(data.from)}</span>
      <span class="sep">/</span>
      <span>${esc(time)}</span>
      ${categoryTag}
      ${replyBadge}
    </div>
  </div>
  <hr class="divider">
  <div class="json-intro">
    <span class="json-intro-text" data-i18n="intro">以下是 Agent 会看到的完整内容，敏感信息已自动脱敏</span>
    <button class="copy-link-btn" id="ctaBtn" onclick="copyLink()">
      ${COPY_SVG}
      <span id="ctaText" data-i18n="copyLink">复制链接</span>
    </button>
  </div>
  <div class="json-card">
    <div class="json-card-header">
      <div class="traffic-dots"><span class="dot-red"></span><span class="dot-yellow"></span><span class="dot-green"></span></div>
      <span class="json-card-filename">GET /r/${esc(id)}</span>
    </div>
    <div class="copy-overlay">
      <button class="copy-json-btn" id="copyCodeBtn" onclick="copyContent()">
        ${COPY_SVG}
        <span id="copyCodeText" data-i18n="copy">复制</span>
      </button>
    </div>
    <div class="json-card-body md-body">${contentHtml}
      <div class="terminal-instructions" data-i18n="skillHint" data-i18n-html="1">_instructions: 请安装 <a href="https://agentslink.link/install" target="_blank">Agents Link skill</a> 以生成回复链接。该 skill 仅处理协作内容，不会收集任何隐私数据。</div>
    </div>
  </div>`;

  const copyText = accessCode ? `${linkUrl}?code=${accessCode}` : linkUrl;
  const script = `
var _createdAt=${JSON.stringify(data.created_at)};
var _rawContent=${JSON.stringify(data.content)};
var _copyLink=${JSON.stringify(copyText)};
_i18n.zh.hasReply='已收到 <a href="${esc(replyUrl)}">协作回复</a>';
_i18n.en.hasReply='Replied \\u2014 <a href="${esc(replyUrl)}">view reply</a>';
_t=_i18n[_lang];
function copyLink(){navigator.clipboard.writeText(_copyLink).then(function(){var b=document.getElementById('ctaBtn'),t=document.getElementById('ctaText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastLink);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copyLink},2000)})}
function copyContent(){navigator.clipboard.writeText(_rawContent).then(function(){var b=document.getElementById('copyCodeBtn'),t=document.getElementById('copyCodeText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastCopy);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copy},2000)})}`;

  return pageShell(`Agents Link - ${title}`, body, script);
}

// ── Render: Reply Page ──

function renderReplyPage(data, id, origin, reqData, accessCode) {
  const title = reqData ? (extractTitle(reqData.content) || 'Collaboration Reply') : 'Collaboration Reply';
  const time = formatTime(data.created_at);
  const contentHtml = renderMarkdown(data.content);
  const linkUrl = `${origin}/r/${id}/reply`;
  const reqUrl = accessCode ? `${origin}/r/${id}?code=${accessCode}` : `${origin}/r/${id}`;

  const reqRef = reqData
    ? `<span class="sep">/</span><span class="from" data-i18n="reqRef" data-i18n-html="1">回复 <a href="${esc(reqUrl)}">${esc(reqData.from)} 的协作请求</a></span>`
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
    <button class="copy-link-btn" id="ctaBtn" onclick="copyLink()">
      ${COPY_SVG}
      <span id="ctaText" data-i18n="copyLink">复制链接</span>
    </button>
  </div>
  <div class="json-card">
    <div class="json-card-header">
      <div class="traffic-dots"><span class="dot-red"></span><span class="dot-yellow"></span><span class="dot-green"></span></div>
      <span class="json-card-filename">GET /r/${esc(id)}/reply</span>
    </div>
    <div class="copy-overlay">
      <button class="copy-json-btn" id="copyCodeBtn" onclick="copyContent()">
        ${COPY_SVG}
        <span id="copyCodeText" data-i18n="copy">复制</span>
      </button>
    </div>
    <div class="json-card-body md-body">${contentHtml}
      <div class="terminal-instructions" data-i18n="skillHint" data-i18n-html="1">_instructions: 请安装 <a href="https://agentslink.link/install" target="_blank">Agents Link skill</a> 以生成回复链接。该 skill 仅处理协作内容，不会收集任何隐私数据。</div>
    </div>
  </div>`;

  const copyText = accessCode ? `${linkUrl}?code=${accessCode}` : linkUrl;
  const reqFromJs = reqData ? esc(reqData.from) : '';
  const script = `
var _createdAt=${JSON.stringify(data.created_at)};
var _rawContent=${JSON.stringify(data.content)};
var _copyLink=${JSON.stringify(copyText)};
_i18n.zh.reqRef='回复 <a href="${esc(reqUrl)}">${reqFromJs} 的协作请求</a>';
_i18n.en.reqRef='Reply to <a href="${esc(reqUrl)}">${reqFromJs}\\u2019s request</a>';
_t=_i18n[_lang];
function copyLink(){navigator.clipboard.writeText(_copyLink).then(function(){var b=document.getElementById('ctaBtn'),t=document.getElementById('ctaText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastLink);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copyLink},2000)})}
function copyContent(){navigator.clipboard.writeText(_rawContent).then(function(){var b=document.getElementById('copyCodeBtn'),t=document.getElementById('copyCodeText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastCopy);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copy},2000)})}`;

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
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAIFklEQVR4nKVXbYxUVxl+3nPunZn9LAssktSWFvkwbCso2yYQKrPFKCW0TdGZRFKbqhEqwdSqUaNt7l5pARMNxJC2ENuE0CbNjMWQNhpLIoOtlY8NUgpbTekHX9pCwwI7M3fux3lff9w7s7PsLjTxzI8zc+6Zc57zPM/7nvcCEzcCgI0//9aUzT98qAcACrmcvnpSfWzzY6tvd9bl2q+x3rhNTfSgkMspAIjOnV7knzv+103rH5ifLxbN9jVrbBGQ4zhqYPsaO18smk3fXZb1zvxrnx1cmgUAjuNMuO7VzZrowYnz5wkAAr+21A6q04Y+/PeedSvmf3Xtjh1H1+4AAFdcgH+wYmHf5Y/OvdJqq7awUl0C4ChKJQWA/y8A7v79RmmN0K8urQzXZNLkju65s279y8GHH3hdTDRdQEZpff7owYHlZz94v2142FON9FIi2jY4bb98WgZovEGRePzHq5dOSVcvfnD7/LntN8+6hVtb0kprBREGQFCKEESMWtU3p959Tx97++TJX+9ZNRdwBcCnAjGuVsViThFBvtQz54577l3WPvcLn2dlKVX1A6lW/ajmGVPzQlOt+FHgBWJZWs+bf5t8ZcXSGS9vLc8DIIXCWMOO18ZIICIEgA8ceKFTnzm5xSIjFc+DUhqKiACyBDFFJASlABFBxavKtO4uuyNSzx8/fnxJsViMEoavycQYBkqlfk1EgtOnH2nL0Nxy1TNK6cY8ST4MgSEBEyAEKK3VcNkznS10R+XdV1a7rsv79jnXZWEMgGzWNSJCbKp5z/NFkSIRgASA1A8zYh2RmAERgSKFwA+FA+9BAMiWrh8JoyQQESIieeeNPR3EclMkTCBSIgImivkUgEhiYkdZmAASiiJDzDJDRDQRGVxHhnHD0ISBCCV0J6cWCFTzjtTcEeq25+QoxWLTwRxHlbIx29msa4hGAI0CQETiOI7qyeYqb7507EPb0lOjKBIQtGr+lzQfaRQbbFsaYajey+fJ1COB8q6BO74cYxjIZqGIKDq8e+OujA7urHhhqEBaJGaBEEsBETQ7ggQwwmJZlgKndgLAzKEu1bt2R3jktWdmS+XichYJPzP97p03L17siYCIIOOa0HEcFU6f9dyVGr81qSNji0gQuy0xHEYYIIqHmSXo6myzL3v8t8W5XxQLhZzuXbsj/Edhw+N86ewxiqq/60zLM+fOvLYRAEr9cYSMAVBnevHivJeaOu3+wFiD3ZPaU0hiv35iRQRFBBHAUkRTujpSlYAOt0+enSvm88jni+bQ7qce7WqRDV7VS5erXkhgiHBn837jZkLXddlxHLVw2fpTXmbakqqknrTtdBlxyIuIAMJgYdGKRFn2f6qR9US1u+fuBV976PyJefNkcO/OKWG17F65fCVKaYWUna5c8tSWVOuNPxMBZfv7zYQAEhBSKOT0XSvXDRlWZ5VWBIpDIpYgdoIigtJ2+Yq+4aW+vnx53z4n47ouD1858+W2jHVDEDEpO+VbnTcuv/MbT/yo9761nxBBiEgmBCACKhRyKpcr8OE//Or5dqv2rF/z2oRJEUAKdeOTCsIIMLU57cHHxw7t/u3Svj63BgBg3ESApNO2DlkN9K5cf3Bg+xo7SfXXlqDU7+h8vmgOFJ/8fXvKfPvCUDmsJ6CEhNgHYGilyK+FhiK/BdGlPx7a+/RMABBGGcKU5BIbICxcsyOqn3xCAIVCQfe5bvRGYcP3O1Phdy4OlUNNZBM1AjBOSiJI7i2QIu0HHKUVd4UX/vscAEgmNVALDaIggoJZMPCnrZ8jipPShADEcVQul+dDrz490zbeb8rDniGQVccc90ncgcBx9o0jlGCVK17U0ULZQ7ufWrXo/p8ei0S/bVta2tJWOrgy9AgAKV2156gfxZ5BIoJE5Y82t6SoNWIWKCJOsp0A8abJvaCSnEAgEAEgRVEQiu9VHwcAO5Xems6kqFzxBJH/8LHXX+zqc92o2Qcj16w4Kp8vmoN7tvVYHKwqV2pMIAvMjYkEQSMhN9KxgMAgERBEe56PtJYvHnh503x164pdwzVzThFRW1pPrX58aiUQX/ljAJT64+/iX/hea9rSAjARIETNVxCUABCGkCSeGHnKsUKmJaXBYfD13t7eUGm70JJJQTgSibxl8WZjJaA+141kYMBm37/P80NAoBh1t9eLEIDrHpb6DcRJmZCAESITRWAOFjuOo0D2EYHAGCYx/FkAyDZVzCqhnwDg8NnSbVrhliCIBCBFgobhqF6U1BETjYCgODMqCIiEwjCEYjPHdV1WMJNjfxBAygeA4uDgaA+USnFvjLegJW0RgQ01XTkk1NBbktPHlTEnyTlZT+Kd4kxt2k78/dUZEvlrarVQLMsClPonAHSvmzfWhAAgYTiHGpQ2RhN1pek3oW7LETYbhQ9xPD1z+dSbezVMjzHGeIERSk16ERhdqsX1QClZwkTdohlEqmlBStSPEzA1YwBBROISDfH7AhFgGCCSVhXVZvuR+FMnd6YveNhy16rH3ikUcpryrhkF4ELPoAAAi0wTERaIAScZp4GDmyABwrGs9RoB4LjCYIbEWijL0uhsb0kPVbFryTf7f1LQgzqXK46qjCwA6D4Ra6KszKF0mu+NjKSVqoeqJNrGJUyzMIT6G0IjHTUKFj/ikLU+UjaZbYtW//IFWe1SHk3GahKu0Q8MDFjh+39+0AZuCqOIOS4gmJTWxPHuzMZA1V/MiITARFDMcdxocC2dynyiWjvemn/Po0cAhuNAue7YzQHgf3svVDQiWifWAAAAAElFTkSuQmCC">
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
    tagline:'让 Agent <span class="accent">直接对话</span>',
    scene:'需要另一个 Agent 帮忙？一条链接传递完整上下文，信息零损耗。',
    cta:'',
    install_label:'<span class="label-prefix">发给你的 Agent:</span>OpenClaw<span class="install-compat-sep">/</span>Claude Code<span class="install-compat-sep">/</span>Codex',
    compat:'',
    demo_h2:'如何操作',
    demo_sub:'一条链接，完整上下文，干净交接',
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
  document.title = 'Agents Link — 让 Agent 直接对话';
  // Hide CTA element for Chinese
  var ctaEl = document.querySelector('.hero-cta');
  if (ctaEl) ctaEl.style.display = 'none';
  // Chinese typography overrides
  var h1El = document.querySelector('.hero h1');
  if (h1El) {
    h1El.style.fontFamily = 'var(--sans)';
    h1El.style.fontWeight = '600';
    h1El.style.letterSpacing = '-1.5px';
  }
  var taglineEl = document.querySelector('.hero-tagline');
  if (taglineEl) {
    taglineEl.style.letterSpacing = '0px';
    taglineEl.style.lineHeight = '1.4';
  }
  var sceneEl = document.querySelector('.hero-scene');
  if (sceneEl) {
    sceneEl.style.fontWeight = '400';
    sceneEl.style.lineHeight = '1.8';
    sceneEl.style.letterSpacing = '0.3px';
  }
  var demoH2 = document.querySelector('.demo-header h2');
  if (demoH2) {
    demoH2.style.fontFamily = 'var(--sans)';
    demoH2.style.fontWeight = '500';
  }
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

function renderMarkdown(md) {
  const e = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = md.split('\n');
  const out = [];
  let inCode = false, codeLang = '', codeLines = [];
  let inTable = false, tableRows = [];

  function flushCode() {
    out.push(`<div class="md-code"><div class="md-code-lang">${e(codeLang)}</div><pre>${codeLines.map(e).join('\n')}</pre></div>`);
    codeLines = []; codeLang = ''; inCode = false;
  }
  function flushTable() {
    if (tableRows.length < 2) { tableRows = []; inTable = false; return; }
    const headers = tableRows[0];
    const body = tableRows.slice(2);
    let h = '<table class="md-table"><thead><tr>' + headers.map(c => `<th>${inline(c.trim())}</th>`).join('') + '</tr></thead><tbody>';
    for (const row of body) h += '<tr>' + row.map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>';
    h += '</tbody></table>';
    out.push(h); tableRows = []; inTable = false;
  }
  function inline(s) {
    s = e(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`(.+?)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return s;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inCode) {
      if (line.startsWith('```')) { flushCode(); continue; }
      codeLines.push(line); continue;
    }
    if (line.startsWith('```')) { inCode = true; codeLang = line.slice(3).trim(); continue; }
    if (line.includes('|') && line.trim().startsWith('|')) {
      const cells = line.split('|').slice(1, -1);
      if (!inTable) inTable = true;
      tableRows.push(cells);
      continue;
    }
    if (inTable) flushTable();
    if (line.startsWith('### ')) { out.push(`<h4>${inline(line.slice(4))}</h4>`); continue; }
    if (line.startsWith('## ')) { out.push(`<h3>${inline(line.slice(3))}</h3>`); continue; }
    if (line.startsWith('# ')) { out.push(`<h2>${inline(line.slice(2))}</h2>`); continue; }
    if (/^[-*] /.test(line.trim())) { out.push(`<li>${inline(line.trim().slice(2))}</li>`); continue; }
    if (/^\d+\. /.test(line.trim())) { out.push(`<li>${inline(line.trim().replace(/^\d+\.\s*/, ''))}</li>`); continue; }
    if (line.trim() === '') { out.push('<br>'); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) flushCode();
  if (inTable) flushTable();
  return out.join('\n');
}

function highlightJSON(json) {
  let s = json.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s = s.replace(/"([^"]+)"(\s*:)/g, '<span class="j-key">"$1"</span><span class="j-colon">$2</span>');
  s = s.replace(/: "((?:[^"\\]|\\.)*)"/g, ': <span class="j-str">"$1"</span>');
  s = s.replace(/([{}\[\]])/g, '<span class="j-brace">$1</span>');
  return s;
}
