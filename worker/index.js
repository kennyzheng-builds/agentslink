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

const LOGO_NAV_B64 = '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';
const FAVICON_LINKS = '<link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,AAABAAEAICAAAAEAIACoEAAAFgAAACgAAAAgAAAAQAAAAAEAIAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAADl5eX/3+Df/+Dg4P/j4+P/3t7e/+Li4f/h4eH/3t7e/+Pj4//g4OD/4ODg/+Pj4//e3t7/4eHh/+Hh4f/f39//4+Pj/+Dg4P/g4OD/4+Pj/97e3v/h4eH/4eHh/9/f3v/j4+P/4ODg/+Dg4P/j4+P/3t7e/+Hi4f/h4uH/3Nzc/+Dg3//g4eD/4eHh/+Dh4P/h4eH/4ODg/+Dh4P/h4eH/4ODg/+Hh4P/g4eD/4OHg/+Hh4f/g4OD/4ODg/+Hh4f/g4OD/4OHg/+Hh4P/g4OD/4eHh/+Dg4P/g4eD/4eHh/+Dg4P/h4eH/4eHg/+Hh4P/h4eH/5OTk/+bm5v/h4eH/4ODg/+Dg4P/h4eH/4eHg/+Hh4f/g4OD/4ODg/+Hh4f/g4OD/4eHg/+Dh4P/g4OD/4eHh/+Dh4P/h4eH/4eHh/+Dg4P/g4OD/4OHg/+Dg4P/h4eH/4eHg/+Dh4P/h4eH/4ODg/+Hh4P/g4eD/4ODg/+Hh4f/i4uL/5OTk/+Hh4f/j4+P/4ODg/+Dg4P/i4uL/4ODf/+Hh4f/h4eH/39/f/+Li4v/g4OD/4ODg/+Li4v/g4OD/4eHh/+Hh4f/g4OD/4uLi/+Dg4P/g4OD/4uLi/9/f3//h4eH/4eHh/9/g3//i4uL/4ODg/+Dg4P/i4uL/4ODg/+Hh4f/h4eH/3t/e/97e3v/h4eH/4eHh/9/g3//i4uL/4ODg/+Dg4P/i4uL/39/f/+Hh4f/h4eH/3+Df/+Li4v/g4OD/4ODg/+Li4v/g4OD/4eHh/+Hh4f/g4OD/4uLi/+Dg4P/g4OD/4uLi/9/f3//h4eH/4eHh/+Dg4P/i4uL/4ODg/+Dg4P/j4+P/4eHh/+Dg4P/g4OD/4eHh/+Dg4P/g4eD/4eHg/+Dg4P/h4eH/4ODg/+Dg4P/h4eH/4uLi/+Pj4//g4N//3d3d/97e3v/f39//4eHh/+Pj4v/h4eH/4OHg/+Dg4P/g4OD/4eHh/+Dg4P/g4OD/4eHh/+Dg4P/h4eD/4eHg/+Dg4P/h4eH/4ODg/+Dg4P/h4eH/4ODg/+Hh4f/h4eH/4ODg/+Hh4f/g4OD/4+Pj/9/f3/++vr7/sLCw/7W1tP+5ubn/tLS0/7e3t/+5ubj/yMjI/9ra2f/i4uL/4eHh/+Dg4P/g4OD/4eHg/9/f3//U1NT/5+fn/9/f3//f39//6+vr/97e3v/h4eH/4eHh/+Dg4P/i4uH/4ODg/+Hh4f/i4uL/4eHh/97e3v+qqqr/V1dX/yEhIf+vr6//9/f3//n5+f/5+fn/9fX1/+jo6P/Q0ND/s7Oz/8DAwP/Y2Nj/5ubm/9XV1f/f39//3+Df/97e3v/g4OD/4eHh/+Hh4f/e3t7/4+Pj/+Dh4P/h4eH/4uLi/+Dg4P/i4uL/4uLi/+Li4v/T09P/aGho/xEREf8AAAD/ODg4/+3t7f/////////////////////////////////5+fn/1dXV/6qrqv/V1dX/39/f/+Hh4f/i4uL/4OHg/+Pj4v/h4eH/4ODg/+Pj4//g4OD/4eHh/+Hh4f/h4eH/4eHh/+Hh4f/i4uL/zc3N/0lJSf8CAgL/AAAA/wAAAP+Ghob/////////////////////////////////////////////////7Ozs/6urq//Nzcz/4+Pj/+Hh4f/i4uL/4eHh/+Hh4f/h4eH/4OHg/+Dg4P/h4eH/4eHh/+Hh4f/h4eH/4uLi/9XW1f9OTk7/AAAA/wAAAP8AAAD/GRkZ/9LS0v//////////////////////////////////////////////////////i4uL/0tLS//U1dT/4uLi/+Li4v/h4eH/4eHh/+Hh4f/g4eD/4+Pj/+Dg4P/h4eH/4+Pj/+Dg4P/i4uL/dXV1/wMDA/8AAAD/AAAA/wAAAP9hYWH/+/v7/////////////////////////////////////////////////+vr6/83Nzf/AAAA/3Jzcv/h4uH/4ODg/+Pj4v/h4eH/4eHh/+Pk4//f39//4eHh/+Li4v/g4OD/5OXk/7u7u/8cHBz/AAAA/wAAAP8AAAD/ICAg/8zMzP//////+Pj4/+rq6v/6+vr/////////////////////////////////qKio/wYGBv8AAAD/Ghoa/7m5uf/l5eX/4ODg/+Li4v/i4uL/39/f/+Li4v/h4eH/4eHh/+Li4v/i4+L/cHBw/wAAAP8AAAD/AAAA/x4eHv+tra3//////+np6f9jY2P/KCgo/3l5ef/09PT/////////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"><link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAACiFBMVEXc3dzi4uLf39/j4+Pg4eDg4eHk5OTj5OPg4ODd3t7z8/Pc3d3h4eHh4uLq6urc3NzW1tbb29vl5eXs7Ozu7u7p6enh4uHi4+LIyMiXl5dgYGBBQUExMTEzMzM+Pj5iYmKUlJTNzc3y8vLf4N/T1NOBgYEmJiYEBAQAAAADAwMoKCiDg4LU1NTf4OC6urpEREQCAgJDQ0O5ubm0tLQsLCxKSkqPj49ra2sSEhIqKiqxsrHj5OTi4+PGxsY0NDQ/Pz/Y2NiOjo6pqamZmZkNDQ0yMjLFxcXe3t7d3d1fX18UFBRubm6JiYm9vb2qqqoQEBCxsbGcnJyenp5XV1cFBQVdXV2mpqYMDAzExMRsbGy3t7ezs7MJCQl6enr8/PyWlpZ0dHTW1tVISEikpKQRERHKyspWVlYYGBi9vbyDgoI4ODi2trbOzs6NjY1TU1Pe397MzMwjIyOioqJqamqUlJP////r6+v7+/uLi4qEhIQhISDKy8sKCgqIiIja2tpPT083NzfLy8tLS0tcXFySkpJxcXGmp6bl5ubk5eSXmJcBAQF3d3fBwcHR0dH+/v5ramotLS1ycnLk5eWQkJAWFhbY2NcLCwsuLi7V1dVaW1qMjIzm5uaYmJjQ0NCfn5/t7e3T09MaGhqVlZUPDw9mZmbo6OjZ2dhtbW36+vpkZGQODg61tbTPz88rKytNTU3Ly8oHBwdZWVmKioq/v78pKSnNzs1wcG8dHR2srKxjY2MnJyd4eHj09PT19fW7u7ocHBwfHx/39/eoqKgGBga4uLh0dXRhYWE2NjZJSUiGhoZnaGf5+fkgISCvr6/4+Pjn5+fP0M+ysrK/wL/U1dW+vr6wsLDZ2dnq6+p8xksKAAAC8klEQVQ4y1VT90NTMRBO8vIeQVNHlWJxgRUJSrWKAwUXjlcc4ARB3AgOFBQfbsVdUao4URy4cStuxY0T9/x3vKQt6v3Q6933JXe5+x5CGBON6gYBH9bkGQ5vxjT43xxhzjHjnEmvc/jh3AYxbqFxKkNJ4BIA0wzcslWr1tiO27SNwIEcRsQROM0iw9o5o9p36Nipc3SM0YXwwM0EGZRiF5CMrrHd4oSy+O49Egy3LMuYhkLX9+wVL5rM07uPpnMHYAzJBrmuJfaFk/36D0gKUgYOAobEULKDpzBt8BBIDh02PHXEyCBj1GhN9mYg02bTI71pYszYcePTPRkTJvafNHmKZEz1QpM2ouYQlpkV75yWnTM9V8yYOWv2nLmSkDVPC80Bk8kib36+KFiwcNHiwiSxJFYVWVqE1RwwxsXLRNzyEiFWWKUr5+eJVasVYc1amw27kKbr9tR1Im79ho1lm4o3byncWsK3KULu9h06T5bP9O30lO9qsbuirX+PEHuddqtSEcqj98lnwkZ8+8WBgxMOHa6K2CuBIyudgZce9XFOkcb06mOepOOLc8WJTDXrvidrTqlxnq5mNBmZ3JGSc0acPRcddf6COphWO/Oi9JcuY7ks2DW+clXEXbvut4YLceNmHbesW2eAcPsOZhQjOXB8F+J7961zDx4+qrf8fuvxNUhkYwelHBVBp8aTp5B4Vmw9j6gFHBgvXopTDT44a0KTUg+vPMB4XWspGAilb0RlUA9uuVVHlbyzoCKIA6Nuc4JNihL0oOsMuDFvy4V4FyJYbdKLYZdKMCmMYRAgrnmfIcpOyhqW1ZiQXlUUkFwKMhkjnMElZmr+h4/PPzXWf/7y9dsw+3eTmITq4UiByiLJj5+JDYk5De1+Ye5mzKypJkW/EWVuiRLGXBw+Kq+XgNxlTFwqDyV0KOHmhFJVijAaiJVnoCiV1IOg7Mf1N6bMRJCUTVD2jw8Zxxr/j6AHfRNLs3NkEIJNmDkmJDLo/41b/gG4/sPQZTDZJwAAAABJRU5ErkJggg=="><link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,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NrK0Efb+Yv1Tp07FZz5z6i7lta3V1U1Da2srijIahR+FIk4KCnAiGRJunKA0KHTapVj5m3R0dlDxyhOAikN0c5vpdSYyRqqtWCzq9sCIA4fo0QUiv1k04uC3v/0dvv/97+925h5wwAG44de/xqGHHBIQqFIptvxocIJ7770XF1988agTzUyYMAHf//73sXTpUg3MKQWGhNFjtlIpDdSfzXFWr16NhQsX7lRN9OHal750Pi6//HIpgxEnwkx23I++WPQCMmX63sssA2yxbJxIhAfNsp3xikV4nqcnq6EGZwSwwnE3pFJlmGdErAhghXDvu2QiIYEV0TKZDLoygmksBKtlbouM7H0/GCvaPvvsgxtuuEEDKcIEJsz56amnnsKVV16Jl156aUQnZUNDA66++uoAqllqHtHGKswj6et5Hi688EL85je/2dVsBsBMjw899CAOPfTDACiyWZbCK5fLgUSY7bihvgH1tlRguRw/WymamprRaESsrFi5kjnHAaAeRVNjY3jxepUxItLEcSLytLYzkOucCvQoxyIqSMP0HGFjpJRi5syZ+MTCT+wWpprt3XffxdKlS/Hss88qG+/r+cPZpgHg2GOPxd13343vfve7mD17dqiNuKKiAp/73Odwzz33YMmSJfJkHuk8YTSNxH5u+47ZRESLmTdvV7WjjjoK+++/P/ySJT40rdcdtNubicP/KOsK9OH9pPqirNua207g6MMxXSZTsug43PqtvDYAFduJRqM4/rjjcecdd74vFVDXrl2Lr3zlK7j99tsxe/Zs/jqmI9avGdJZh//6r//CWWctwYsvvYDXX3sd6XQa+XweEydNxL6z9sXhhx+O1tZWLX/EaC6lYW+I0bZS31mw4CAcffTRuP/++3cpj+PxOE466UQkkyn4FQoUnx7xbwSNOtpl0AjNUnrpYVsWGqKmm6SZ5isSiUjQRANWlKDXALBC2DixqJ+2KRqJ+BnZ+TizZs3CYYcdhuXLl+9Sxoa1119/HZdffgVuvvn3qKqq4nSU/o4AmEThIEII6uvr0NBwKk45+RQ/lo3rgMO64GL4+eT2jWCMkSSaND8vKxuH0047DY8++ugudZM94ID9ccABB2iy4LouotEoPMp1XQp4RU/Lsy36qAeA8IfW+kSiiMc8mZaOUhoIjiYvvfQSVRlRU1MjHfGFU0hHR0egeH1tba1GtIhYEQSZ4+RyOXR0dCBfKMhbaV3dNLS1rcaiRYvGVE9wLI0QgksuuQQ//OEPEI8nRnV6qnzanf1Hc6qPlQcbNmzApz71Kbzwwgu7ZMxkMolbbrkFRx55JNavXy/XE41GZTSKWFN/fz/6edVbSini8Tjrk+DgC1jEyoaNG+RDEIlGMWP6dAa+8HEEQKMaKKJu3vUde7iqwV6XTOvwPE8arsUlUCxAZZCIKVTBDPW1CwB5DsxQClCeuf2oo47CiSeeiNtuu223baDaKKX47W9/i0MPPRSnnHLKqL432nl2hsbd0dSHprKyEosXL8aLL764S+Y7+uijcfzxx2HLli3IZrNyLgGCSE9MrnhmuawI+RBAndqy2Ry7wxEgRplWkFLcAsRBqZr7WH+HMDOb4yhhTvYwH4fY7YSq553tdBL2SAL/0gnCFnzuueeOKTxrrG3btm340Y9+hK6uzmEtCqONJh9L9LnKy9HMM9q5ghEtx4+pXo3ZJkycgC9/+cuYMGGiVl5CmVnKFHNU8r3lHH7BC6TT4J8LVJUQu9ehCq6AEAVYMVz0wpgRFs+mjmEbhyhWEN/7irWDD16A0047bacZO5r26quv4oYbfj1szuf382Qe7Tw7+xaYMWMGTjjhhJ2m5YRPn4BjjjmmBH1+tIpVFaOqBUP/vud58IpFVnRIaUFvPR7+l86ktfiWgM+w6Gw7DdSYrxBriUQNlS8JLytQAA4zqr/91tv4whe+8L7YpUWrrq7Gfffdhw9/+MPWB9XGj/+XGiEEr7zyCo47/jj09/WPaYzq6mos++0yHDj/QM0jUzTN7Cb8oanu42z2K020+B+/pBsfR+vr/OLfhBB0dXWhK52WHVOpFFpaW5FQvKUymQw6uzqlMp7gqcDUaqciYkUQoUa1iNbZ2YnuTDeI46CsrAyfOeUUXP/LX75vqWv7+/uxbNkyzJ8/H4lEXLebjqKFvdFG8r3RqhkjHXskjVKKefPm4WMf/Rj+53/+Z9TfdxwHJ598MioqKtDR0QEKoKG+Hs3NzbKPCpo4jgNKgKaGRhmxAihpvrjuTSlFc3OzVrw+l8thVdsqZHNZCGS70RgHgL0kRWB7LKev+i/76W14ugUSKuk5nTxQLDzuk4FX1+5uDz30EF588UWFwNELs3lXGIlde7SegGPpNxKnpng8jsWLF6OsrGzUvDv00ENxwgknyBRd4vAMZs+CdCDiB3RJxDYsnjU4KGDe9UIjVmwDWlOBUXt/DekRgeIWBgvHJ69YxKTJk/HNK68MwJm7s23atAm33nqrNDmqSxzJSfhBU0nGQs9hhx02aq/CmpoaXHnllaisrITnBeuiBIwDlEqHJJiZBYivntqQa/G3dJDz1MwDIs9iaPF6lkNDZqyJx2TEisq0RCIpIc14LB4AX0TEingi4/EY3FwuEN2bSCTgcPAiGoniQ/vNw39+5Su4/Ior3rcg1UcffRQrVqzAgQceKE2Xw/laDOcTEtZ/JJ+bD/xo3UZH0yilmDx5Mj7/+c/jmWeeGVFhJMdxcP755+GQQw5BR0cHS2ZPZL4ADexgkSZx36GNS/5QdkheBs2IFUGXjKYiQJ77Q5v8UCOuACNiBQhGmmSzWaxduxYFHowKAFWVVVoxTlFjRXWqF8CKGkLT3t4ON5+XpkGRTUn0yefzaO/owNatW/Czn/4MDz74/uVmvuyyy/DjH/9YRIyNSlhG65oa9p2RCONIvOyG+56tT09PDz75yU9ixYoVw9Jw1NFH41vfuhIVFRWYMX2GJmj9/f1aFIlI4aUiy/39/ejr64U47WLxOGZMny79YwhhwMrAwIAMyVIL3Iu5ent7tey0APQqWMJ9VE1H4HkeCoUCy6XB612A91GZxQrcu76/BjeWqwzM51kf/iVjLvZr12WXhzPPOhNr29diddvqYRm8K9oDDzyACy64gF9oSgvbaC9yJvpXSujCLn4jvUCWcpEtRX9dXR0WL140rEDvvffeOO/cc5FMJOWpqcqLOLzUNarAimium2dpjqi9eD0ImDyJVzwJjiMOQTiEqSEAHM2DifWyM041YIdsnP5ZCPOFk1KJ04hSiml1dVi6dOn7Fn6/Zs0aPPG3v4WvbQwt7CEYiw/0rv6O7V500kknobk5/P4yZcoUfOlL56OpuclaLkQD2UpcSKVXHRzNU9PoBcD3zrN3ITLVhpA/XmPF40XEPVDVYVollH9GPS/wTpYOJaLeBb8Iho5DPVmvzmeqsGez4YvFIvabtx8uuugiLYfz7mrFYhH33Xc/tm/fPqzD0nBtLCjeWOex/TxSuswHbp99ZuLTn/q09bvjxo/H0qVLsWDBAhQLRX5Bs4MdQgZEWgKzD6WsGKvH5cHzLA8epaBcLoXhIDCX/L4HT+Ad6XSa3zuptFh4lGpGkYjhSSYmUYtxRiIRg55gpEskEtEM415R/5yCwnEiklgQAtfN4frrrseyZct2eyXXyZMn469//SuOOOKIMb/y1Y0VfBhN292OSSaNpory7LPP4oQTTtAKJTmOgyVLluCKb1yBZCKpywo/AFU1QMiC6GeLeBKRJ/wX8AzsQevD5UxEPEm6uLsF4J/gsni9eFV0dnYi052BQxwWsZJModUoXs+AlS65kKSleH1XVxcrXq9YPISfsGidnZ1an3g8jpbWVpQJpyYA6UwGJ554Ivr6+nDvPffCo7svCfnmzZvx4IMP4vDDDw98Ntp4vrEK5vsJndt+N3/+fHzkIx/RfKWPPfZYnPqZU5FIJBnYASZAg4ODWLlqJfJuXpre6uvqtdooQ9khrFy5CjkBmoCiqdEvXi8cjFasWCEdjVjESjAVmIxqcZgJr7GhQYtqoZQGI1YArrk4iiHc4uMrniDHkt7JvPyYNkltPs3oLkwMwh7J+ieTSXzxi1/AsR89drdv9COPPIKenu5RAx8jEZg93UaylrKyMpx22mnSKnHYYYdh6Ze/jImTJvl7p8qBEvxqxTOo+Nj43GSP1INRWp6k0xK0KCnRx+7CJHSWECO3OogQOpVCGXJlMsBYlPguM6pD07fE4gD2ypo4cRIuuugiHHXUUbt1099++208/dTf9U0ZRXs/dGd1rtHMN5K1eJ6Hze9tBiEEBx10EL761f9EVWWlNTe3PzAAL6jnajwxBdkkW8qK/UAU9At9WmQgMJsWsaL6sEoH7Ug0UJieUoo4LyIOQnjx+gIIyUF5bAJRLXkls5JYlDC6A0AsGkM+n0c2qz9nDKAhqK2txTf/6xuIx2N4/HG7RWJnW6FQwL333YvPfPYzI0rJFdjb9/Fk3tVzFYtF/OG2P+Cb3/wmDjzoQFxx+RWYOnUqPM9DlG9bLudCSFI+z8x2Il5Q9bsQaokoOh9XdG1KKXJuzgdW8q60ZQsgQI1YEeY5cxw5lzwwAfLyyy/7YX+U1VhRfZNzuRw6OztRKBYkBl9VUakV43RdFx2dHci7eabIg0W1VFVWSYJc12XjiJRifC7VLJfP5621WnzwBSgUinjppRfxk5/8BE888eRuEaCqqio8+sgjmG/k0ghrY3EaGsvFcaxRMCOZx3Vd/OamZfj21d/GvrP3xVVXfQtHHHEEopGoHKu/vx/9PD2XuPM0NzdrAcMDAwMyGgVgwEpzc7M83CilGNiwAQMbBgRRiMXiaG5q0g7A3t5eHrHi8D4xrXg9pRQDAwMYGODj8KXKE1qNjTMDPHOuK43c4sZqFq/Pu3k/UoEw+6HooxrchbCK8c1xRK0WtQl6APaAVVRU4mtf+zrKysbhoYce2uXeeQMDA/jrgw9i/oEHjup7o7kIvh+hViOB5wkh2Lp1K6655hpcd911WLBgAS66+CJMrZ2KaCSquUGAX87U0dS6KWKfVa85YRBIWiJN/KDXEhErIg8HH0eVTcdx/Lm4JcSBUswwHKXSGYASJ4Ua1VLKycmmj1v7EEBVlihl2ZcmTpyIiy66CGecfrr2UOyq9vDDD8tyvaWEYWdMdOp6d2crBbBk0hlcfPFX8LNrrsHHPvYxfO3rX0d1VXXAd4f/pNXQUYVW7Re2z9rcgf8bBgN+6Rsu4EQ9QAkhcETxcAGw2JjsK+ICEKGhE6j2Z+s4NOhRVbIPVZcsvK48FItFJJNJnLXkLFx22aXWeuQ709ra2vD8889bhcDG5OGcj2x/dlX/Ut8Rf2z0vfjiS/j86afjgb8+gKUXXIClS5di4oQJgSxY/iJ9nEL8ZwI1Yv/Vy75JJ8D7eD4w4n/Gp1I+K3p2gAYAip4BCnZ0dFBbR/NmaZ7eIrWTaN4wITKBSAb2y2H1QqIYzwH+YBl9KaV4+umn8ZOf/gTvvL3rqr+eccYZuPnmm2XGzp1xTrJZi0broDRS+Fs9KW1vycHBIfzpT3/Cd777HRTyeVx66aU44YQTmAO+8l1zXI962p7bVBr/hPV7+m9a/8KnqVwESto433ImHJMQQpOtMCopFotUFeLOzk5kMhmpl6SSwRormUwGnekueTlIJlMyXZiMWMlkkO7qkotMpVISfBGto6NDAisAs66YSVq6urqQ7s7wkC2mR6mRL4Swei49PT3o7u7G737/O/z96b+PuTCR2urq6rB8+XKZsfP9RPBMgRnuDTAS+gghaG/vwI9//GPcccftmDNnDpZe+GXMmjkL06ZO1fzQs9ks2traeHouNn9jQ4MGmgwODmLFihWS15SyylvTp0+XfYaGhlhtlFxWWkIaefF6sce2iJUmo3i9AFayCkDTUN+A5uZmbd1RQYhqlpP6C/XNMaqeRAhPvUtYJwG+aKcQ4J+sNBhnZnudWk8aabcPvjnE64tSlgiyvqEBl19+OebMnoM///nP6O3t3Snh6unpUQSaGaJUoGkkgjlWy0eADyP4Tpjgs1N5EA888AB++MMfIp1O47OLFuHUU0/BlPJyDXYWCC3gJ8+RJyWCp7ITUmNHfSOzMRwfYLGtKUQWAm828TmCn1NKfW87lSGiD1UHsm2U0HHD/IeVP7ZoBHXM0FetAc5YhZ9D/p5XRDKZwhlnnok77rgDCxculOUQxtoefPBBbNmyBUKYR9tGCn7sisuhTb3wPA9vvPEGzj//fJx77rkghOB73/8ezvniFzF58hTra5sKpmr/hvHb4BpLXeB8dDHMCzOIRof1C1OLCCHMbKfqPQBTM4jjSHDEdV12YaS+0AtzDqUUsTgrjSycUcREqqlGlE82myhmDkDWYZFvC77+ZCIpA3Lj8bimThBhIkwmJQQbj8dw8MEH45ZbbsEtt9yCG2+8ET09PWMSktdffx2vvPIKjjnmmPcNZNkVPiBCXbv55ptxy623olgo4JxzzsGnP/1pVFZWYnBoCMViQXMwCx+TXQCLxaKszgAw3CCZTCIaZVUIVL8LtU9MgHBivwj0PoV8yYgVAayI7EvqG2Mom9Wh+JdfUYEVoKamGtVV1XIxItLEr7HCitfX1tTIQVmkSTtDFPkzXG0Zp6OjQ0MdzaiWfD6Pzs5OKdSe56GqsgrVNdUagzo7O2VpDEo91FT7UTYAs1W3r12LIj993nzrLTxw/wP4+9+fxqZNm0YtLBdffDGuu+467dI0XButjXms/U1PN0op1vWsw7333Ytly5aho6MDxx13HC699FJZCjqXy+Htd95GLusLZ0N9A5qaGuWe5nI5rF69WhM8gSDLO08sjqbmJu3SPDAwwMAXrg7GogwQsYIv3HUnHo9henMwYqW/v1+qNGpKMdGnr68Pff39MrsSBRBl8V+qsyjRPOsopbKOhVDGKaVIKmAHALg5V0sFBopA2QkxDvvYj3xRN8R1XQxx473QoVPGXLlcjjFa0WcDNIv0ZYRgxozp+NGPfoh169bhxhtvxPLly0eV8fTxxx9HT0+PdknZlcIpaB5tU+ehlCKdTuO+e+/DrbfdijVr1mDevHn4zne/i5NPOgkzZsyAyAhq+kwYumGALrGnhUKBuYuKlHCEaPVOOFEYyg7JNzxNUFmvRx1zaGjIp5/a+2SzWT9VBq+tEgBfhoZ4Fi4m1FFZLFkspgRjGRpjN+eF6k4I0Xstc6nOTNTye/HUq8zTvi8S2BitWPQQi8Vw1FFHYcGCBXjmmWdwyy234LHHHsPWrVuHFZw1a9fiySefxJIlS0YkaO+nP4fruli9ejXuvece/OUvf0F3Tw/mzm3BN6+8EgsOOgipsjJ28gk9ltikdgTrGUbH12QBAJF7qO+5Gh8uH8aQi/ZIbP2+bLGLYtTvDBlxolk8oAiU0O2p3aBeUoARfAhMwlTDfNCaIXtygz0FPOMWDAtyJ8bhTEylUvjEJz6BQw89FHfddRceeughvPDCC5r/gdkK+TzuvfdefPazn2W+2tg1bSxqBsCciNatW4dnn30W999/v4zWPuaYY/CjH/0Y5RXliMZj8DzqgyREciiwXypvgeC+SwHh+Qh9gbF4YorTXxUscJ8jCOuEoi7xECV1/+X8ngeq5Fu09pH0cdo7OzupaQzXohCI4vOqeNLZgALTWmKNVCgFFTObWCgsLuiTi/EpCpmL08zRRfPhiEQiKBaL6OrqwjPPPIOHHnoIK1euDOQcBlhm/oceekjmrwiD9a3rGkZAw76jfp7P57G+dz1efeUVPPbYY3jqqaexfv161NbW4vDDD8enPnU8WlvnIZVKybtDcK/8HNcBK5GnxwOa8wMsyeWWLVuYyuFRJFNJzJ0zV7usdXd3a+ncotEoKirKuZ7tp4HTQTa7K2jYgWjKmlgDAUFUrfAkbsaZTEZegAQgohKdyWRYjRW+eBGNoupA6XQame5u+YQmk0mtSqoK4oiWTCYxt2UuUsmUTk93Biz7JJUpxdSIcg0M4jTPmzdPA4PS6bSsCyPuCa0coGlqasKRRx6JU045GU888ST+9a9/4ZVXXkEmk5EJwTdu3IjbbrtNpnlQrTPmwzUaQeYyF/hdPp/He5s3o6uzEy+//DKeeeYZvPbaa+jr70N1VTUOP/xwHHfccWie3swu7BTo7etDMpmU6xIeih0dnchk0swWzPXeltaWAJ/T6bRmoWoxIpXSmQzL400N32bLmkQrFAro7e3THh41hZewiqxYuQK5nCtNvM1NwVRgK9Xi9ZSisTGYCixqPRl4oXF4wSdDEC8gacIdSMwazYDI1avfxk1HFpUZaqyaKQCCnrDXZcCebti9NTsp8W3K6sVowoSJWLBgAQ488EBs3LgJa9euQc+6dXjl5Zfx5ptv4rY/3IaHH34YM2fOREtrC2bNmoUZ02dg2rRpKC8vx4QJE7gZKxoKOPhCzNQB13WxY8d2vPfeZvT19SGdTuPtt9/G6tWr8dZbb2H9+vXIFwqorqrCfh/aD9899Tv48IcPw9SpUxGLxZDpziCdybBrEI8gYicxj/uEagUBC/knxPqWtfl/qF6Y4jukhC+O9QE24v5ssiDSLLN+FpWH0+84Qh0JyiYhBFHxGtcIpOzFoAIrqu2PCZ9Q/IOgi/mzFFaxKhryuuXHnFW39LTjIPgwqIiRwhRzc+D5NKjMFYiocEWdUj4ZR9YdiTlz5qBQKKCzsxMrVqzA008/jddeew133303tm/bDo+ymMqJEydiypQpmDJlCiZPmYwJ4ydg4sSJSKVS7HXLzZDFQgFDQ0PYsmULtmzZgk2bNmHDhgFs2vSerMM9fvx41DfUY86cOVj4yYXYd/ZsTJtWh4rycszj7gOaA5AiGEKI5dqVnH2UAkQ6lxH54EM9cEscOKYA+Xuqq4rBe4/y/grFzxT/jpBbCuEySThCrdIn/hXNGvqiBE24aSYejweK11NKUaa8cmOxGNycG9CDhImFgmW+YeALtMUnU0lJaCwWhZtzpXCJPolEQm6MrOdieGhJFYD4qcn86HQOBvG5CCGIhgA96itW1JdJJBKYOXMmZs2ahUMPPRTdPT3YsWMH3ntvEzZs2IjN772H7p4e9K5fjw0bNqC3txe5XA6FfB6FYhGeV2R5LCjgRCKIRqIoKyvD+PHjMWHiRMyZMxc1tbWYM3s2mqdPR0N9Paqrq5HL5fDelvdAPXYRjEb8WjZCF6WUldUTjI7H4si5elo2QrjfOX8zaQAWlzGPekgmfT7HYjE9GkTZU6KAXDk3mCZO86EGU5/EPGHCyqquiZO8FHIs/2cIO/9bTQVGKUvPVVNTIzuKovMMWGGCUV1djalTa+W4+Xwea9asYaAJd8hWU4qBELhinHxBm0uNjsnn8zKlmGhV1VWorbHXcxHj1NTUYOrUqXKuXC6LtWvWchCHHTpV1VWYNnWaNtfatWt9oAcUNdU1Gj2u6+o0g/OnukY+TIVCAR0dHUyACwXk3BzKp5SjoqIC+XwehUIB2RxLp+bmXUScKByHoLmpGY2NjYhEIojGYijwaB1h6y0Wi5JmsXZBM6tp7YNTKqgkgDAVTVVTrpl8FgBWdXU1apU9VdO7abJRW6P10XhIKaqqqzG1thbiVHZdF++uWQPXzcmDqq6uLqAfr169WpursbERdXV12rra2tqkDi0coUxsQIspVEEK8bOosaKDJqyQpvqqy+fzyOZyktHiCZanuuch7+ZZbjsCnrGSanMJZqsLEwCN2ceMhVTn8opFVhg9GwR6zHHUeiCBtVMP+XwBeTXKBkQrgON5HgaHBhl/+Mkyfvx4WVRJeJMNDg7xzSCg1MOkyZMxceJEOU6xUMDg4GBg7epccu0yMghBPvO90MZBcJxCocD6qOCU2FP+O9FHVTNEH/Eg5HI5tnauY4NS7TIOgPuviypYdp8Nj3ooUmFd8wKfj7Q5Osbu61VB+6645AQvXPL77IeAXhu4xInNsFwApX6sbNhwl0m1+Z8rES+KHq1PRbQ5TZ1UrZwRZnKkXCWlnv8yFSZL8bdwPmd/F6UJcThnLZPPpfRaK5+Vz60CopiOtX6BLbEHNGhmPvUOY9DD/njaus31aE5uFju4ULOooDtEJYnaGCvychhsAaU+4aaziQ++2JmuCbkHP7me4VSuPp3UOpf9ghIU7iCDTV8M9n0Aij5uzkUpi9BwDHqEBUddOxRdUpvLOCQEGmpbl3nzD+tjCrcJPIjvS3qNtXsyUsS+p2azRYyYh4RqRDBpo56OUtr4TKkHeI6Pf5h9PN4Hpswolqy1a9dqlEYiEa3um7j5q4QLBV5lsOgjfic/V6woxUJRO3XDxjEZp9IDwE8USP1xZPopqoeBmeNYaeZC5ziOzBgl5xoBPYVCwQegYPcRZnP5204cgogT0TZFXBzVuSJOpCQ9Pp99iSoWiwrMHb72UusKWFDAUsLJHM+8T6FYCNDjRBzN9KbymcJP4aXSE7ZfJg9L7ikoi1hRO6TTaVa8nqNBqWQSLRxYEaeKAFZUx5EWzZjP+qiIUTKZxNy5c+2ACM++FI/F0dLSEoxYSadlGbhkgo2jzpXmc4lXXzKVREvLXCRiCWnmMWmOJ+JobWlFMpGQZr5Mt0+zuK2rtWMkzem0tNXbaBap0hxuKUoJkCIel/R0dnaiu6cbIkxfzKWhbpkMOsW6wO4tNj5nMhmZYkLMpXqlqcATCOQ4Ks3pdBpdPL0bwKxGc1taGH9se8H31Jwrk8lo48QFgKXwOZ1JS0CtNJ8zstxFGM1y3/l8URV21B09lN/xV6QVpBAnDIKvQvUzzUcloHsz3dw05qtzqacNjLmI0o8qNAuaBPhDuFcWn43rZb5XnzhhhJ+IfS7iA08KcBRUk/h46itVXTvxVRdBc0D9k7QCNEzPF2Mh2Ex7sE1dKwWuIEBPuMOQdS7x4jD4rO2p54XSY6odqowF3C34/6LExo2QC6ZNj/OBCbsOJgn17IyTQQF82jCdkQQERvcbEXqpr6uqtCi3H/l82ukR67c9mPKi5i8OwplH1WMBcJ0RAd7KubgDr80ua9OpBU3mQaIJlRcUUHVLwy6X2jiK705gLzTsrbTezfaVhM/F+TfcPUmdj8D+QPlgjK3GCqXSkZtSKoGMUsZzmxGecvONWFxMA1b8EyyZ8P1bY3wuc0PUgFg5jjmXlnYshlzO1aqaep4nU4qxPlHN3q2uXTwgoo95KiQTCXl6CnrMhzjBQQobzRpgFMJnk2ZKaYDPYiNZiltmHhN9POOim7Ss3RTGJI/6IYQgFg2OA+hp4mxziX0XtMWiQQBL3S9zXRqftaioeIDPgofaA/HSSy9RX/GnmFo7FVVVVXLgbDaL9g4WsSJe09XV1XoqMGGoV9KhqsXrWR8XHR2dKBR4hLBnj1hRDf4UFNVV1VrNlzBgRe2Ty+UYuFDIs0sepaiqqtJswyoAIZhRU1ONqqpgXRhx6aMeAxdU/shoHTcvhbC6pgY1BpCh0QxgqgF25HI5rFmzBoVCgas9LCXZNAEYIQiIAGaqNIKcm2MATb6g7YWg2aRH9KmurkZNba20eNj4bNbEyWazkj8CUAvnswtR3tikWc7F6++wvagJ8lkBjCTNCghIKdVjCpmuG6yxks/n5YaJZtbVKAhjPldmCCHaySqIcl1Xc1G11cxwXVfWfzbnEhuipjAjjk6zBAVyrq8TK+OIVigU/JzEjILAOKIuDAEJ0izXXtBTnBlzEUKQ53OpvizqJUjw2XVdOJEIwL1kzDRbYu1he8HWVeR7wcygMPjsOA7jDxcgkVk0aQAi+YLBZ2Kvv8P2ywnsF18857PLIfPgOGIut8RchI8jYleFCmvuaVQ9riFMK6a+yiOe1QuezZjvK/sWPRpc1hVzktmCIAs0HdQ05sufVZp9eEP+n4aNb0wVTkuYfZYGvhzQfeXv4YclEWqdS/ozaLqvHVmTvj6KHVa9JEv6hgHc5L6QkA+VdZk6ubY4ZQgdMKF6N0oCeyoXJDL2Uzt//AugL2MmX6KwEEFKCJww2JuAiGQ/9Z1L1HEcY0zThhiwKYoLDtXpUXNFAKI8RhD1k0ghvyya69LWqNhwbX2YMd9+aRGXJfWBMm/h6oVK/KxyI2BdEBJDSMAu7pPsr9cKZHDe2S6S6gEmppL8Mmgy91/js0BhlbGs/IE/HVHs9ZoOTykoh8cDvFDWZSuBofG7q6vL/gyLx9Z2qnECVCuFJtAhD8RYmu1Bsz2ZI/m+f4P3TVIqILLTtIrzzvIAhdE2Il4pexEwj0FHIUsdRqXmsplv1d8Hvkuk0cg6j80aJr+qmDEREgc6kjX45lYiWUQ8owRRRgEpKCjKUmXMeB6LSbNad3e3jFgBfGDFrMOSTqcl3JlIJAO1WkSNFaHnmsZzAJrBnxDmBmkCNKqBnVKKVFkKLXNbAqFBnV1dErJOxOOlaeaWHK0PIehU0pdRgI3Doz90YKWTv5Xs0R8sEqdbvrnEukqBFIlEQoJKKs1dPOWaGEfMpYEUPApJBSmSqaQUVhnRQ/z7jxkZpAEZsAArHDQR4IvkTyif2UORNCKeCCHokPV3AOGkZQOwutJp/lJmQh2IWJE+xMrT5fE/2pPBnwgVBg2zEcuuivFc9RURFyzx80gSP2r0BbJXhjj2UMr0NNAAzfwX/BVucdhBiI4IyFe79uoTFwD+ajbnMscIA6a074BaT2Ob3m4dS/QV9NhKpSk/m2PIfZGggbGnpk065J7lM1N4wtvpRQBPCME/lOCBqPr9gKHeElalMgfcwyysMpVKpCqkElgwiA/Ti9QF2ACPwHwGIzRmePZLlrzwUj/7pU3/FA+QgH9pCVpAwAIrzPucuuHER8A0YbFsMvWovBBZ+1gAI0kn5aFTXpDPKs0mn219pPpjAcvEXodfjkUuDi5hISolqP0ACDvcBPMCwApgGLRjrOi8SOgnjecK+KIWrxePrkepVj4gHovDDQFfxO1fTRemMjeZTIBwe7KMWDEuIVaQQqFZXRfA6kvLcYT8mzQr0ToqzclkUqouZoozn2YL8CTQQ95PRAaBsmidUiAF4EcPWXlIiJVmjR4+VzwWt4IdpcAyjYfcz8cGrADQaB4OdBPrsoIvRgSN1ofzUZ0LhHBgxR8l1HiuRkCYwIoWacKfLjOSIu+6aO/oQM51pV5UKpJCnUs1nqsGf7FZtRaQQkRSiBPKHCefz2Nte7t03gcQpNkEeixzqX2E5UfMVWpdpWgm/GGp5iCFjc8qaDJamguFAtrb2zVUttQ4CNkvkXItrxREHZNshNBcVV0l30Q2HprgHQBE3bzLVR0lKkG5UBSLRS0CQjT1CZNG7zwrwAiPasCBXFyhgLyCFJp9VOO5+qqT1Ut5KxQKGmKk0gzAB4NkeBVTnwLASpHTrMwfpNmPshE8MWkWPFJpNseR/GFUs8tZCLBiA03EXHkRacILtltp5kAYCFcHCUEimdTiMPOFvMZDcWoGaFaScJp9PM/z6VH2wqTZj47xrWO2fVfpYXC9MU6R9yH2uQBep5BwHpu63nCmMdOgz8Yi2gVP/0z/ExgPOjjj/75E2HzYXJppC753ndqHClOqxRlII8qYx0YP0ecNveRwHd3m6GNjjI2H0vZL7H18GzHHBMTcVoLDx5EgGXTwxroXFlOdvjYjSVCJC3K4/PiXfkG02SfqK+h2BZ4I/UDZX2s0gbyMQTvx9HEgIxdsSj7RCAwa5+VcUGySJeaC2k+dq8TnGgKp0uwoiB5xQB390iT0Y2qMKYVFjVhRFqyBDIaQUyBAu7i4yslsaxcXWgsPlQn8PiHj2AQ3jM/mpT7Qhwb3XeWzBkgZ9yONJ5RqD2gADEqn01Q1qgfMZgQyskJ8yQ/f8X9nFq9X+whCRdpVlbii52mHUiQS0YjUomX4U64WRxc+FqapLxKJaAIT3sffdkr1SA7VSiD+rdMDiZqqNI+UP0WvqAmdOY65FzZ6ZMyissEmD230jIZm9bS10lOKz1x+Ss0FQJMNgBUDEipSLBYLeAiGjlNfX68xQys6D54KrKU1AFKoqbfUVGCUspAoUfcEhEV8q1EJfJ3MeG4ZR61v2JXuQqYrI/OEJI25RB8R/UEpyxliRlKokTgEBIkEq+ci3VcJkEln0N3TI+3Qtrk6Ozt5ajJ+o+cgRVlZmeSjiCIR1pvA2vk4Pd09ks/JZEoDngRwkOYpvCCBp1Ykk0qKs0wa3d3dUuBE6jYTxJF7Sv06NRqfeQo41Zphrj2dTvtRNqBIJe18ZjwkHCyLo7V1nswdIvow2fD5bEbiqGBQeXk5xo8fj5qaGiaHXH4ymYycS4h5NKDLEDVige20TScSN3HC9cvwPpBjarqn8SoN02MlpKkYX1VjPvsF/z6/KKl9tPGIMa9it9UyLfFBSdi6hA5HfTOcflIoTlMKb311wT/hBB1hoA2RKxd3E3ukidpKgTi+6hKMDpH7QkvwGUTJD42QfYe0wRMFstfWJWkO3y9CCCZMmICyceMQiUb8/QAFgfqm8hkdAFZC0TALQxSOWfvqfh7q5ujM9y+CQYTRVP6H1dOM8c0NF4LlP1eGrkipJoRh4/ibb5srBFSwrH0kzXr5lusmoQ+KCU7ptOh6sowwD1mzRBjBo4coDVk7f84t49geMhXAUvvGYjGUl5dj3PjxzOZP9QNAEVQtz13Ulg5Lzcgei0aZA7fBoHg8Lp/maDSqOcqrRn42E9NXTdBEBUQAli5M+Cir4yTiCSkN8Xg80Id9Ny4vjLFYVJbQUBnoR1sQxGJRLdOT2oeTbF0XISzRjPDtjXGaTT6qkR2hNPNxKKUse5JCswpsSZDCoEdsaCIRh3iTqjSr+2WCHflCARElikblj1ijjeZEXAewTNmgcu2MidFYTOIBKlimyk+M91HXFY1GMX78eKlbO44jTZvq2zCeSKh3fHvxejVSIJfLobOrE4VCUT69lZWVWoRIPp9HV1eXBr5UVVWhsrJS9hHF683UW2qfQj6Pzq4uPRVYVZVGj+u66EqnkVds1bIPvyTmcjl0dnaiUCzKU7GyosJKs5t3hb0Q1QrNAK/n0tWFYsFPBVZdXY3KykrN4M/GyUsrTWVVFaqNaIuuTj4Xp7naWJekuVDg/iZAZUWljHzRafbnqqquRlVlpVy767raXlAANYJm6DSrdt/KyspA9FCXsRdi7aZsFAtFyZ/KitHJBghBXqFZPBTV1dWoqa6WQu55HgY2DGDTxk0oFAr6vitv7aia3FsQEShen3P93GS8r+oR5zgOKzqvFFdU+4inPp/PI+f6hRzVuQDAdRy4eb14PTXmIoTlyZMFIbnfQIBmNwfX5TngEKTHcRy4PH0Z4xi1rivvuhLd9LiZK5VKST8G+9ppYO1unvUBStCcyzGhF2m1lHG0uZTik4QE+ey6LuOzOleZTnM+n2cVpAjk7wN85nOpQIY6F8Bq66ihZXY+u8hmcxJ0C/BZpZkI8EVPcZbP57Fx4yZs377NKmPyZDd1FyHYNmM+QJhuRCy6DyHaxUqMo/4tRlNNVTbdTlw2hW3bnMu8kNppVs3wYfQI23l4NLvfj8gMrmq2e+3JI+qwIaCT5KUdyJC0WuiRa3cEVMR1aAvoIZ2YVDu52fjFTd0Lm93e3K9QnZ6PGfycSOxC5kq3yI/YB2qZS6QiDpMxKdDyl8pVMQhkUO5Zp1sVzIE9YfRWFumfHOJm7bEbO3/N2y4vAuyxXQDVPuplyAYKmOhZYC5PBURKjKOufTh64J+CpteZ4A8djmbVjGubS+R4ZgiDwWe2X564tKm/V9buURYhoh01oevyL4DD8hm2PfU4n6l2GVfHYQeXB3hEvJxKzmUCNHL2jo4OamOwfpEs4eZn6SPNdZo8EZ05hATCsqzjGA+G7MOFx3xi1cWaAEhJ85ZCj/UBM9Zuo9s6lziRLDkzStMTQjOg58ZW+cy/oz3sRIecrXMZn9v4LI2Vw/DQ5I5N6M0xfNnQaQ5rmmXMnM/zPCnQjuNowAGlShorxcAuoj/Ek5VIJNDS2iKdSYTxXI22sKZ76uJRCfyVZEurZUajiCgJ1QgvQQGHPYgpDlKYYJCgpxQYJKI/xFytPGO+afBXLRUCDBJ9ZKQJt4QkEkm0GOnLTLAjmUpaASyVHkGzlgZN4bO4b7RaIlbEXGF8lnVzOPCUtOx7gM+JYB81yoYCWi0bc09L8rmrC92KHCZKRqz45saof5r54IBD/PJdYSeVPF0V26Cpzwh4VdVJTT1PpukN6SNPM4eAUN1hXf1b6J/iFAl7PamnozpXKft2YO2yTglkNnt1Lkavw7U4UvJNp+qpYWvXTjIYfCY+T9QT1FyTCZnb5lITP4buhSMyPw0zlwBWFJrVk1XdR/Vnfe28ho8xl/ybBN90jv9l40vs/EdY0/XGYAtT2s2NBKXy6QoVKOhAiHVsogAzIbSYH1LL50QZJ4xmnujWvwgZ/cRlVkxgCpM6v41/VrVGIK6WX+u/tAMsgcu3RcUweWJTDSTRFlDFqgJofewf2h5yYh0hSAs15EdDCsXvRSIPErKxggh51BvdTOZRlOhDwz/3L2WevNmHt5GhbjrcHd5JmMTsNNNhZxNCZHM4Uh9m2wOv8lnyj4bTq0V+G8PJE43PV2oeyD4l+ExK7UEYff5PPj00UDhV47Gy+lI8VveCUor/D2lE4zeOnmiPAAAAAElFTkSuQmCC">';
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
  .topbar-brand{font-family:var(--mono);font-size:15px;font-weight:500;color:var(--text-secondary);text-decoration:none;display:flex;align-items:center;gap:8px}
  .topbar-brand strong{color:var(--text);font-weight:500}
  .topbar-logo{width:24px;height:24px;border-radius:5px}
  .topbar-expire{font-size:13px;font-family:var(--mono);color:var(--text-dim)}
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
    <a class="topbar-brand" href="/"><img class="topbar-logo" src="data:image/png;base64,${LOGO_NAV_B64}" alt="" width="24" height="24"><strong>Agents Link</strong></a>
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
<meta name="robots" content="noindex,nofollow,noarchive">${FAVICON_LINKS}<title>Agents Link - Access Code Required</title>
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

function stripFirstHeading(content) {
  if (!content) return content;
  return content.replace(/^#\s+(?:协作请求：|协作回复：)?.+\n*/m, '');
}

function renderRequestPage(data, id, origin, hasReply, accessCode) {
  const title = extractTitle(data.content) || 'Collaboration Request';
  const time = formatTime(data.created_at);
  const contentHtml = renderMarkdown(stripFirstHeading(data.content));
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
  const contentHtml = renderMarkdown(stripFirstHeading(data.content));
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
    font-size: 16px;
    font-weight: 500;
    color: var(--text);
    text-decoration: none;
    letter-spacing: -0.3px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .nav-logo {
    width: 28px;
    height: 28px;
    border-radius: 6px;
  }
  .nav-links {
    display: flex;
    align-items: center;
    gap: 28px;
  }
  .nav-links a {
    font-size: 14px;
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
    font-weight: 400;
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
      <img class="nav-logo" src="data:image/png;base64,${LOGO_NAV_B64}" alt="Agents Link" width="28" height="28">
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
