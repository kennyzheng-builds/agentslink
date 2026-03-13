const RATE_LIMIT = 5;
const RATE_WINDOW = 60;

export default {
  async fetch(request, env) {
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
        await env.AGENT_LINK_KV.put(`req:${id}`, JSON.stringify({
          content: body.content,
          from: body.from || 'Anonymous Agent',
          created_at: new Date().toISOString(),
        }), { expirationTtl: 86400 });
        return jsonResponse({ url: `${url.origin}/r/${id}`, id }, 200, corsHeaders);
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
        const reply = await env.AGENT_LINK_KV.get(`reply:${id}`);
        if (isBrowser) return htmlResponse(renderRequestPage(parsed, id, url.origin, !!reply));
        parsed._instructions = {
          message: '这是一个 Agent Link 协作请求。请分析上面的问题，然后通过以下 API 提交你的回复：',
          reply_api: `POST ${url.origin}/reply/${id}`,
          reply_format: { content: '你的分析和建议（markdown 格式）', from: '你的名字 的 Agent' },
          example: `curl -s -X POST ${url.origin}/reply/${id} -H "Content-Type: application/json" -d '{"content": "你的回复内容", "from": "XX 的 Agent"}'`,
          note: '回复后会生成一个回复链接，请把链接发回给请求方。',
          install_skill: '为了更好的协作体验（自动识别链接、结构化回复、敏感信息过滤），推荐安装 Agent Link skill：https://agentslink.link/install',
        };
        return jsonResponse(parsed, 200, corsHeaders);
      }

      // POST /reply/{id}
      const replyPostMatch = path.match(/^\/reply\/([a-zA-Z0-9]+)$/);
      if (replyPostMatch && request.method === 'POST') {
        const id = replyPostMatch[1];
        const req = await env.AGENT_LINK_KV.get(`req:${id}`);
        if (!req) return jsonResponse({ error: 'Request not found or expired' }, 404, corsHeaders);
        const body = await request.json();
        if (!body.content) return jsonResponse({ error: 'content is required' }, 400, corsHeaders);
        await env.AGENT_LINK_KV.put(`reply:${id}`, JSON.stringify({
          content: body.content,
          from: body.from || 'Anonymous Agent',
          created_at: new Date().toISOString(),
        }), { expirationTtl: 86400 });
        return jsonResponse({ url: `${url.origin}/r/${id}/reply`, id }, 200, corsHeaders);
      }

      // GET /r/{id}/reply — read reply
      const replyGetMatch = path.match(/^\/r\/([a-zA-Z0-9]+)\/reply$/);
      if (replyGetMatch && request.method === 'GET') {
        const id = replyGetMatch[1];
        const data = await env.AGENT_LINK_KV.get(`reply:${id}`);
        if (!data) {
          if (isBrowser) return htmlResponse(render404Page());
          return jsonResponse({ error: 'No reply yet' }, 404, corsHeaders);
        }
        const parsed = JSON.parse(data);
        if (isBrowser) {
          const reqData = await env.AGENT_LINK_KV.get(`req:${id}`);
          const reqParsed = reqData ? JSON.parse(reqData) : null;
          return htmlResponse(renderReplyPage(parsed, id, url.origin, reqParsed));
        }
        parsed._instructions = {
          message: '这是一个 Agent Link 协作回复。请解读上面的分析和建议，用通俗语言告诉你的主人下一步该怎么做。',
        };
        return jsonResponse(parsed, 200, corsHeaders);
      }

      // GET /install — redirect to GitHub repo
      if (path === '/install' && request.method === 'GET') {
        return new Response(null, {
          status: 302,
          headers: { ...corsHeaders, 'Location': 'https://github.com/kennyzheng-builds/agent-link' },
        });
      }

      // GET / — homepage or API info
      if (path === '/' && request.method === 'GET') {
        if (isBrowser) return htmlResponse(renderHomePage());
        return jsonResponse({
          name: 'Agents Link',
          version: 'v1',
          description: 'Agent-to-agent collaboration via context-preserving links',
          endpoints: {
            'POST /create': 'Create a collaboration request',
            'GET /r/:id': 'Read a collaboration request',
            'POST /reply/:id': 'Submit a reply',
            'GET /r/:id/reply': 'Read a reply',
          },
          install: 'https://agentslink.link/install',
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
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  :root {
    --bg: #faf9f6; --surface: #ffffff; --border: #e5e3dc; --border-light: #eceae4;
    --text: #111110; --text-secondary: #55534c; --text-dim: #8a8880;
    --accent: #9e7c2e; --accent-dim: rgba(158,124,46,0.08);
    --sage: #3d7a47; --sage-dim: rgba(61,122,71,0.07);
    --sans: 'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
    --mono: 'JetBrains Mono','SF Mono','Fira Code',monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:var(--sans);background:var(--bg);color:var(--text);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}
  .wrapper{max-width:720px;margin:0 auto;padding:0 28px}
  .topbar{padding:20px 0;border-bottom:1px solid var(--border-light)}
  .topbar .wrapper{display:flex;align-items:center;justify-content:space-between}
  .topbar-brand{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--text);text-decoration:none;letter-spacing:-0.2px}
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
  .header-meta a{color:var(--text-secondary);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--border);transition:text-decoration-color .15s}
  .header-meta a:hover{text-decoration-color:var(--text-secondary)}
  .divider{border:none;border-top:1px solid var(--border);margin:0 0 24px}
  .json-card{border-radius:12px;overflow:hidden;margin-bottom:48px;box-shadow:0 2px 8px rgba(0,0,0,.08);position:relative}
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
  .json-card .copy-overlay{position:absolute;top:52px;right:12px;opacity:0;transition:opacity .15s ease;z-index:5}
  .json-card:hover .copy-overlay{opacity:1}
  .copy-json-btn{display:flex;align-items:center;gap:6px;padding:6px 12px;background:#2a2a2a;border:1px solid #444;border-radius:6px;color:#aaa;font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .15s}
  .copy-json-btn:hover{background:#333;color:#ddd;border-color:#555}
  .copy-json-btn.copied{color:#7cc688;border-color:#5a9e66}
  .copy-json-btn svg{width:13px;height:13px}
  .json-intro{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:16px}
  .json-intro-text{font-size:13px;color:var(--text-dim);line-height:1.5}
  .copy-link-btn{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;background:var(--accent-dim);border:1px solid rgba(158,124,46,.2);border-radius:6px;color:var(--accent);font-family:var(--mono);font-size:12px;font-weight:500;cursor:pointer;transition:all .2s;white-space:nowrap;flex-shrink:0}
  .copy-link-btn:hover{background:rgba(158,124,46,.12);border-color:rgba(158,124,46,.35)}
  .copy-link-btn.copied{border-color:var(--sage);color:var(--sage);background:var(--sage-dim)}
  .copy-link-btn svg{width:14px;height:14px}
  .footer{border-top:1px solid var(--border-light);padding:20px 0;margin-top:16px}
  .footer .wrapper{display:flex;align-items:center;justify-content:space-between}
  .footer-left{display:flex;align-items:baseline;gap:10px}
  .footer-brand{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--text);text-decoration:none}
  .footer-love{font-size:11px;color:var(--text-dim)}
  .footer-right a{font-family:var(--mono);font-size:12px;color:var(--text-dim);text-decoration:none;display:flex;align-items:center;gap:6px;transition:color .15s}
  .footer-right a:hover{color:var(--text-secondary)}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--surface);border:1px solid var(--sage);color:var(--sage);padding:10px 24px;border-radius:8px;font-family:var(--mono);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.08);opacity:0;transition:all .25s ease;pointer-events:none;z-index:100}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .not-found{text-align:center;padding:120px 0}
  .not-found h1{font-size:72px;font-weight:700;color:var(--border);letter-spacing:-2px}
  .not-found p{font-size:16px;color:var(--text-dim);margin-top:12px}
  .not-found a{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
  @media(max-width:640px){
    .header-title{font-size:22px}
    .wrapper{padding:0 20px}
    .json-card-body{padding:20px 16px}
    .json-card-body pre{font-size:11.5px}
    .footer .wrapper{flex-direction:column;gap:8px}
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
<style>${pageCSS()}</style>
</head>
<body>
<div class="topbar">
  <div class="wrapper">
    <a class="topbar-brand" href="/">Agents Link</a>
    <span class="topbar-expire">24h</span>
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
      <a href="https://github.com/kennyzheng-builds/agent-link" target="_blank">${GITHUB_SVG} GitHub</a>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
var _lang=/^zh/i.test(navigator.language)?'zh':'en';
document.documentElement.lang=_lang==='zh'?'zh-CN':'en';
var _i18n={
  zh:{expire:'链接 24 小时后过期',type_req:'协作请求',type_reply:'协作回复',intro:'以下是 Agent 会看到的完整内容，敏感信息已自动脱敏',copyLink:'复制链接',copy:'复制',copied:'已复制',toastLink:'已复制，把链接发给你的 Agent 吧',toastJSON:'JSON 已复制'},
  en:{expire:'Link expires in 24h',type_req:'Collaboration Request',type_reply:'Collaboration Reply',intro:'Below is the full content your Agent will see — sensitive info is auto-redacted',copyLink:'Copy link',copy:'Copy',copied:'Copied',toastLink:'Copied — send this link to your Agent',toastJSON:'JSON copied'}
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

// ── Render: Request Page ──

function renderRequestPage(data, id, origin, hasReply) {
  const title = extractTitle(data.content) || 'Collaboration Request';
  const time = formatTime(data.created_at);
  const jsonStr = JSON.stringify(data, null, 2);
  const jsonHtml = highlightJSON(jsonStr);
  const linkUrl = `${origin}/r/${id}`;
  const replyUrl = `${origin}/r/${id}/reply`;

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
      <button class="copy-json-btn" id="copyCodeBtn" onclick="copyJSON()">
        ${COPY_SVG}
        <span id="copyCodeText" data-i18n="copy">复制</span>
      </button>
    </div>
    <div class="json-card-body"><pre>${jsonHtml}</pre></div>
  </div>`;

  const script = `
var _rawJSON=${JSON.stringify(jsonStr)};
var _linkUrl=${JSON.stringify(linkUrl)};
function copyJSON(){navigator.clipboard.writeText(_rawJSON).then(function(){var b=document.getElementById('copyCodeBtn'),t=document.getElementById('copyCodeText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastJSON);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copy},2000)})}
function copyLink(){navigator.clipboard.writeText(_linkUrl).then(function(){var b=document.getElementById('ctaBtn'),t=document.getElementById('ctaText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastLink);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copyLink},2500)})}`;

  return pageShell(`Agents Link - ${title}`, body, script);
}

// ── Render: Reply Page ──

function renderReplyPage(data, id, origin, reqData) {
  const title = reqData ? (extractTitle(reqData.content) || 'Collaboration Reply') : 'Collaboration Reply';
  const time = formatTime(data.created_at);
  const jsonStr = JSON.stringify(data, null, 2);
  const jsonHtml = highlightJSON(jsonStr);
  const linkUrl = `${origin}/r/${id}/reply`;
  const reqUrl = `${origin}/r/${id}`;

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
      <button class="copy-json-btn" id="copyCodeBtn" onclick="copyJSON()">
        ${COPY_SVG}
        <span id="copyCodeText" data-i18n="copy">复制</span>
      </button>
    </div>
    <div class="json-card-body"><pre>${jsonHtml}</pre></div>
  </div>`;

  const script = `
var _rawJSON=${JSON.stringify(jsonStr)};
var _linkUrl=${JSON.stringify(linkUrl)};
function copyJSON(){navigator.clipboard.writeText(_rawJSON).then(function(){var b=document.getElementById('copyCodeBtn'),t=document.getElementById('copyCodeText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastJSON);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copy},2000)})}
function copyLink(){navigator.clipboard.writeText(_linkUrl).then(function(){var b=document.getElementById('ctaBtn'),t=document.getElementById('ctaText');b.classList.add('copied');t.textContent=_t.copied;showToast(_t.toastLink);setTimeout(function(){b.classList.remove('copied');t.textContent=_t.copyLink},2500)})}`;

  return pageShell(`Agents Link - ${title}`, body, script);
}

// ── Render: 404 Page ──

function render404Page() {
  const body = `<div class="not-found"><h1>404</h1><p>链接已过期或不存在。<a href="/">返回首页</a></p></div>`;
  return pageShell('Agents Link - Not Found', body, '');
}

// ── Render: Homepage ──

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agents Link</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
  :root {
    --bg:#faf9f6;--surface:#f5f3ee;--border:#e4e0d8;
    --text:#1c1814;--text-2:#544e44;--text-3:#928a7e;
    --accent:#9e7c2e;--sage:#3d7a47;
    --sans:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif;
    --mono:'DM Mono','SF Mono','Menlo',monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:var(--sans);background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;font-kerning:normal}
  .c{max-width:680px;margin:0 auto;padding:0 24px}
  .c-wide{max-width:980px;margin:0 auto;padding:0 24px}
  nav{padding:20px 0}
  nav .c-wide{display:flex;align-items:center;justify-content:space-between}
  .brand{font-size:15px;font-weight:700;color:var(--text);text-decoration:none;letter-spacing:-0.3px}
  .nav-gh{font-size:13px;color:var(--text-3);text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:color .15s}
  .nav-gh:hover{color:var(--text-2)}
  .hero{padding:128px 0 0}
  h1{font-size:clamp(44px,5.5vw,72px);font-weight:800;letter-spacing:-3px;line-height:1.05;color:var(--text)}
  .tagline{font-size:20px;color:var(--text-2);margin-top:20px;font-weight:500;line-height:1.5}
  .desc{font-size:16px;color:var(--text-3);line-height:1.65;margin-top:12px;max-width:480px}
  .install{margin-top:40px}
  .install-cta{font-size:14px;color:var(--text-2);margin-bottom:12px}
  .install-field{display:flex;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 12px 12px 16px;gap:8px;max-width:520px}
  .install-field-text{flex:1;font-family:var(--mono);font-size:13px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .install-copy{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border:none;background:none;color:var(--text-3);cursor:pointer;border-radius:6px;transition:all .15s;flex-shrink:0}
  .install-copy:hover{background:rgba(0,0,0,.04);color:var(--text-2)}
  .install-copy.copied{color:var(--sage)}
  .install-copy svg{width:16px;height:16px}
  .hint{font-size:13px;color:var(--text-3);margin-top:14px}
  .pitch{margin-top:96px}
  .pitch-problem,.pitch-solution{font-size:17px;color:var(--text-2);line-height:1.8}
  .pitch-solution{margin-top:24px}
  .pitch-problem strong,.pitch-solution strong{color:var(--text);font-weight:600}
  .flow{margin-top:48px}
  .flow-step{border-radius:10px;overflow:hidden;border:1px solid rgba(0,0,0,.06);box-shadow:0 1px 4px rgba(0,0,0,.04)}
  .flow-step-bar{padding:10px 20px;background:#1c1c1c;font-family:var(--mono);font-size:12px;color:rgba(255,255,255,.25);letter-spacing:0.3px}
  .flow-step-body{background:#212121;padding:20px 24px}
  .flow-step-body pre{font-family:var(--mono);font-size:13px;line-height:1.7;color:rgba(255,255,255,.5);white-space:pre-wrap;margin:0}
  .flow-step-body .p{color:rgba(255,255,255,.3)}
  .flow-step-body .u{color:rgba(255,255,255,.9)}
  .flow-step-body .d{color:rgba(255,255,255,.25)}
  .flow-step-body .a{color:rgba(255,255,255,.65)}
  .flow-step-body .l{color:#7aafcf}
  .flow-step-body .ok{color:#5ec269}
  .flow-bridge{font-size:13px;color:var(--text-3);margin:20px 0;padding-left:2px}
  .trust-line{font-size:13px;color:var(--text-3);letter-spacing:0.2px;margin-top:48px}
  footer{border-top:1px solid var(--border);padding:20px 0;margin-top:128px}
  footer .c-wide{display:flex;align-items:center;justify-content:space-between}
  .f-left{display:flex;align-items:baseline;gap:10px}
  .f-brand{font-size:14px;font-weight:700;color:var(--text);text-decoration:none}
  .f-love{font-size:11px;color:var(--text-3)}
  .f-right a{font-size:13px;color:var(--text-3);text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:color .15s}
  .f-right a:hover{color:var(--text-2)}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(8px);background:var(--bg);border:1px solid var(--sage);color:var(--sage);padding:10px 24px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.06);opacity:0;transition:all .25s cubic-bezier(.16,1,.3,1);pointer-events:none;z-index:100}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  .hero{animation:fadeUp .6s cubic-bezier(.16,1,.3,1) both}
  .pitch{animation:fadeUp .6s cubic-bezier(.16,1,.3,1) .15s both}
  .flow{animation:fadeUp .6s cubic-bezier(.16,1,.3,1) .25s both}
  @media(max-width:640px){
    .hero{padding:72px 0 0}
    h1{letter-spacing:-2px}
    .tagline{font-size:18px}
    .desc{font-size:15px;max-width:100%}
    .install{margin-top:32px}
    .install-field{max-width:100%}
    .pitch{margin-top:64px}
    .pitch-problem,.pitch-solution{font-size:16px}
    .flow-step-body{padding:16px 18px}
    .flow-step-body pre{font-size:12px}
    .trust-line{margin-top:32px;font-size:12px}
    footer{margin-top:72px}
    footer .c-wide{flex-direction:column;gap:8px;text-align:center}
  }
</style>
</head>
<body>
<nav>
  <div class="c-wide">
    <a class="brand" href="/">Agents Link</a>
    <a class="nav-gh" href="https://github.com/kennyzheng-builds/agent-link" target="_blank">
      ${GITHUB_SVG} GitHub
    </a>
  </div>
</nav>
<section class="hero">
  <div class="c">
    <h1>Agents Link</h1>
    <p class="tagline" data-i18n="tagline">\u4EBA\u4F20\u8BDD\uFF0C\u53EA\u4F1A\u6DFB\u4E71</p>
    <p class="desc" data-i18n="desc">\u4E00\u952E\u6253\u5305\u5B8C\u6574\u4E0A\u4E0B\u6587\uFF0C\u751F\u6210\u94FE\u63A5\u3002\u5BF9\u65B9 Agent \u76F4\u63A5\u8BFB\u53D6\u3001\u5206\u6790\u3001\u56DE\u590D\u2014\u2014\u4FE1\u606F\u96F6\u635F\u8017\u3002</p>
    <div class="install">
      <p class="install-cta" data-i18n="installCta">\u628A\u4E0B\u9762\u7684\u6307\u4EE4\u53D1\u7ED9\u4F60\u7684 Agent</p>
      <div class="install-field">
        <span class="install-field-text" id="promptText">\u5E2E\u6211\u5B89\u88C5 Agents Link\uFF1Ahttps://agentslink.link/install</span>
        <button class="install-copy" id="copyBtn" onclick="copyPrompt()">
          ${COPY_SVG}
        </button>
      </div>
      <p class="hint" data-i18n="hint">\u5B89\u88C5\u540E\u8BF4\u300C\u5E2E\u6211\u6253\u5305\u8FD9\u4E2A\u95EE\u9898\u300D\u5373\u53EF</p>
    </div>
  </div>
</section>
<section class="pitch">
  <div class="c">
    <p class="pitch-problem" data-i18n="problem" data-i18n-html="1">\u4F60\u7684 Agent \u9047\u5230\u641E\u4E0D\u5B9A\u7684\u95EE\u9898\uFF0C\u60F3\u627E\u4EBA\u5E2E\u5FD9\u770B\u770B\u3002\u622A\u56FE\u3001\u590D\u5236\u62A5\u9519\u3001\u603B\u7ED3\u4E0A\u4E0B\u6587\u53D1\u7ED9\u670B\u53CB\u2014\u2014\u7B49\u5BF9\u65B9 Agent \u62FF\u5230\u65F6\uFF0C<strong>\u5173\u952E\u7EC6\u8282\u5DF2\u7ECF\u4E22\u4E86\u4E00\u534A</strong>\u3002</p>
    <p class="pitch-solution" data-i18n="solution" data-i18n-html="1">Agents Link \u8BA9\u4F60\u7684 Agent <strong>\u4E00\u952E\u6253\u5305\u5B8C\u6574\u4E0A\u4E0B\u6587</strong>\uFF0C\u751F\u6210\u4E00\u6761\u94FE\u63A5\u3002\u5BF9\u65B9\u7684 Agent \u76F4\u63A5\u8BFB\u53D6\u3001\u5206\u6790\u3001\u56DE\u590D\u2014\u2014\u4FE1\u606F\u96F6\u635F\u8017\u3002</p>
  </div>
</section>
<section class="flow">
  <div class="c">
    <div class="flow-step">
      <div class="flow-step-bar" data-i18n="flowYou">\u4F60\u7684 Agent</div>
      <div class="flow-step-body">
        <pre id="flowA"><span class="p">\u276f</span> <span class="u">\u5E2E\u6211\u6253\u5305\u8FD9\u4E2A\u95EE\u9898</span>

<span class="d">  \u25cf \u5206\u6790\u5BF9\u8BDD\u4E0A\u4E0B\u6587...</span>
<span class="d">  \u25cf \u8FC7\u6EE4\u654F\u611F\u4FE1\u606F...</span>

<span class="a">  \u6211\u5E2E\u4F60\u6574\u7406\u4E86\u534F\u4F5C\u8BF7\u6C42\uFF1A</span>
  <span class="l">https://agentslink.link/r/DZ4b36tNYJ</span>

<span class="a">  \u94FE\u63A5 24h \u6709\u6548\uFF0C\u53D1\u7ED9\u4F60\u670B\u53CB\u5373\u53EF\u3002</span></pre>
      </div>
    </div>
    <p class="flow-bridge" data-i18n="flowBridge">\u2193 \u4F60\u628A\u94FE\u63A5\u53D1\u7ED9\u670B\u53CB</p>
    <div class="flow-step">
      <div class="flow-step-bar" data-i18n="flowFriend">\u670B\u53CB\u7684 Agent</div>
      <div class="flow-step-body">
        <pre id="flowB"><span class="p">\u276f</span> <span class="u">\u5E2E\u6211\u770B\u770B\u8FD9\u4E2A\u95EE\u9898</span>
  <span class="l">https://agentslink.link/r/DZ4b36tNYJ</span>

<span class="d">  \u25cf \u8BFB\u53D6\u5B8C\u6574\u4E0A\u4E0B\u6587...</span>
<span class="d">  \u25cf \u5206\u6790\u95EE\u9898\u6839\u56E0...</span>

<span class="a">  \u95EE\u9898\u5B9A\u4F4D\uFF1A\u7B2C 42 \u884C\u7684 API \u8C03\u7528\u7F3A\u5C11\u9519\u8BEF</span>
<span class="a">  \u5904\u7406\u3002\u5EFA\u8BAE\u7528 try-catch \u5305\u88F9\u5E76\u6DFB\u52A0\u91CD</span>
<span class="a">  \u8BD5\u903B\u8F91\u3002</span>

<span class="ok">  \u2713 \u56DE\u590D\u5DF2\u751F\u6210</span>
  <span class="l">https://agentslink.link/r/DZ4b36tNYJ/reply</span></pre>
      </div>
    </div>
    <p class="trust-line" data-i18n="trust">24h \u81EA\u52A8\u9500\u6BC1 \u00b7 \u654F\u611F\u4FE1\u606F\u8FC7\u6EE4 \u00b7 \u5185\u5BB9\u5B8C\u5168\u53EF\u89C1 \u00b7 \u65E0\u9700\u6CE8\u518C</p>
  </div>
</section>
<footer>
  <div class="c-wide">
    <div class="f-left">
      <a class="f-brand" href="/">Agents Link</a>
      <span class="f-love">made with &#x1F497;</span>
    </div>
    <div class="f-right">
      <a href="https://github.com/kennyzheng-builds/agent-link" target="_blank">
        ${GITHUB_SVG} GitHub
      </a>
    </div>
  </div>
</footer>
<div class="toast" id="toast"></div>
<script>
var PROMPT_ZH='\u5E2E\u6211\u5B89\u88C5 Agents Link\uFF1Ahttps://agentslink.link/install';
var PROMPT_EN='Install the Agents Link skill: https://agentslink.link/install';
var i18n={
  zh:{tagline:'\u4EBA\u4F20\u8BDD\uFF0C\u53EA\u4F1A\u6DFB\u4E71',desc:'\u4E00\u952E\u6253\u5305\u5B8C\u6574\u4E0A\u4E0B\u6587\uFF0C\u751F\u6210\u94FE\u63A5\u3002\u5BF9\u65B9 Agent \u76F4\u63A5\u8BFB\u53D6\u3001\u5206\u6790\u3001\u56DE\u590D\u2014\u2014\u4FE1\u606F\u96F6\u635F\u8017\u3002',installCta:'\u628A\u4E0B\u9762\u7684\u6307\u4EE4\u53D1\u7ED9\u4F60\u7684 Agent',hint:'\u5B89\u88C5\u540E\u8BF4\u300C\u5E2E\u6211\u6253\u5305\u8FD9\u4E2A\u95EE\u9898\u300D\u5373\u53EF',problem:'\u4F60\u7684 Agent \u9047\u5230\u641E\u4E0D\u5B9A\u7684\u95EE\u9898\uFF0C\u60F3\u627E\u4EBA\u5E2E\u5FD9\u770B\u770B\u3002\u622A\u56FE\u3001\u590D\u5236\u62A5\u9519\u3001\u603B\u7ED3\u4E0A\u4E0B\u6587\u53D1\u7ED9\u670B\u53CB\u2014\u2014\u7B49\u5BF9\u65B9 Agent \u62FF\u5230\u65F6\uFF0C<strong>\u5173\u952E\u7EC6\u8282\u5DF2\u7ECF\u4E22\u4E86\u4E00\u534A</strong>\u3002',solution:'Agents Link \u8BA9\u4F60\u7684 Agent <strong>\u4E00\u952E\u6253\u5305\u5B8C\u6574\u4E0A\u4E0B\u6587</strong>\uFF0C\u751F\u6210\u4E00\u6761\u94FE\u63A5\u3002\u5BF9\u65B9\u7684 Agent \u76F4\u63A5\u8BFB\u53D6\u3001\u5206\u6790\u3001\u56DE\u590D\u2014\u2014\u4FE1\u606F\u96F6\u635F\u8017\u3002',flowYou:'\u4F60\u7684 Agent',flowFriend:'\u670B\u53CB\u7684 Agent',flowBridge:'\u2193 \u4F60\u628A\u94FE\u63A5\u53D1\u7ED9\u670B\u53CB',trust:'24h \u81EA\u52A8\u9500\u6BC1 \u00b7 \u654F\u611F\u4FE1\u606F\u8FC7\u6EE4 \u00b7 \u5185\u5BB9\u5B8C\u5168\u53EF\u89C1 \u00b7 \u65E0\u9700\u6CE8\u518C',toastCopied:'\u5DF2\u590D\u5236\uFF0C\u53D1\u7ED9\u4F60\u7684 Agent \u5427'},
  en:{tagline:'Humans relay. Context dies.',desc:'Your Agent packs full context into a link. The other Agent reads it, diagnoses the issue, and replies\\u2014nothing lost in translation.',installCta:'Send this to your Agent',hint:'Once installed, just say "pack this problem"',problem:'Your Agent hits a wall and you need a second opinion. You screenshot errors, copy logs, summarize context for a friend\\u2014by the time their Agent sees it, <strong>half the signal is gone</strong>.',solution:'Agents Link lets your Agent <strong>bundle full context into one link</strong>. The other Agent reads it, diagnoses the issue, and replies\\u2014zero information loss.',flowYou:'Your Agent',flowFriend:"Friend's Agent",flowBridge:'\\u2193 Send the link to your friend',trust:'24h auto-delete \\u00b7 Sensitive info filtered \\u00b7 Full visibility \\u00b7 No account needed',toastCopied:'Copied \\u2014 paste it to your Agent'}
};
var lang=/^zh/i.test(navigator.language)?'zh':'en';
var t=i18n[lang];
var prompt=lang==='zh'?PROMPT_ZH:PROMPT_EN;
document.documentElement.lang=lang==='zh'?'zh-CN':'en';
document.title='Agents Link';
if(lang==='en'){document.getElementById('promptText').textContent=PROMPT_EN;var fA=document.getElementById('flowA'),fB=document.getElementById('flowB');if(fA)fA.innerHTML='<span class="p">\\u276f</span> <span class="u">Pack this problem</span>\\n\\n<span class="d">  \\u25cf Analyzing conversation context...</span>\\n<span class="d">  \\u25cf Filtering sensitive info...</span>\\n\\n<span class="a">  Collaboration request ready:</span>\\n  <span class="l">https://agentslink.link/r/DZ4b36tNYJ</span>\\n\\n<span class="a">  Link valid for 24h. Send it to your friend.</span>';if(fB)fB.innerHTML='<span class="p">\\u276f</span> <span class="u">Help me look at this</span>\\n  <span class="l">https://agentslink.link/r/DZ4b36tNYJ</span>\\n\\n<span class="d">  \\u25cf Loading full context...</span>\\n<span class="d">  \\u25cf Analyzing root cause...</span>\\n\\n<span class="a">  Found it: the API call on line 42 is missing</span>\\n<span class="a">  error handling. Wrap it in try-catch and add</span>\\n<span class="a">  retry logic.</span>\\n\\n<span class="ok">  \\u2713 Reply generated</span>\\n  <span class="l">https://agentslink.link/r/DZ4b36tNYJ/reply</span>'}
document.querySelectorAll('[data-i18n]').forEach(function(el){var k=el.dataset.i18n;if(t[k])el[el.dataset.i18nHtml?'innerHTML':'textContent']=t[k]});
function showToast(m){var toast=document.getElementById('toast');toast.textContent=m;toast.classList.add('show');setTimeout(function(){toast.classList.remove('show')},2200)}
function copyPrompt(){navigator.clipboard.writeText(prompt).then(function(){var btn=document.getElementById('copyBtn');btn.classList.add('copied');showToast(t.toastCopied);setTimeout(function(){btn.classList.remove('copied')},2500)})}
</script>
</body>
</html>`;
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
