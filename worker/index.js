const RATE_LIMIT = 5;       // 每分钟最大请求数
const RATE_WINDOW = 60;     // 窗口大小（秒）

const FAVICON_BASE64 = 'AAABAAEAEBAAAAAAIAA7AwAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAwJJREFUeJxlU1+IVHUU/r7f796dGWeYXHdXNjFKGyqcxTQ2oiZyN2INCyRwhtYHQTBERBR82kX27n0QBI2eVOhR1GSE8KEgI2qIFgqKUkFB/G+brTuuu3Pdmblzf/d3ephdMztPh8M5H+f7vnOAhfA8KADwhgvbtr+d61ms79iQW+kNv/mxAFzseTL4dL5vKHe999meP9/9cOhzEcr3X32z7/7fVeezb6+t9wDlA/Z/AJ7nKd/37aE97698sbfr6urcc6lEIgEAaDVDXL92d+a3ydncoeNfP/Q8KN//F0QBQD5/mQAw8Fb/SH7tS6nQ2CiYb5jgUd00Y4n61r28bPOG9aMAMJ4v8z8biAhJyh/nD6fr1eoNTSyPYitKkQBgRWzC0SqKcTf76mu5/GXElZ6jHBioxCTFWUQyXVmR6aqAiEkQ0qZHEQCIrRXcuXOPfaW98ZPyKZJSLhd1f//OutLuF92dGS0iEAisCETAZc9kNJQ6uWnT3vDHEyO7Lp7zz0+c8foAwAGAYvGsFc9Tt3pfGJmausEO190dRREUCcdxw+m55vHCiqGxidPucO9S59hM0LwPnXRFQAUAJAT5PFcNbm9acEoRgAACgdbKRpY/cXDQ0LZ2PJhrzN2bfX5VoTj2+/i4RwcAyuWiZqkUT5we9bszemx6Zt4SVGIhJmqls8nklz+fO5i3Qe22AG+sLnQaESFAUeVyUZdKZ+OJM/7rCSVjDx4GBiABggCNsTFhYYLapzq55NTypel0cOniVpJSqXj68WnS1Ec7HAVrBQokIVigp4NHTXEVNlqkpv+q1q6IiXYDwEAFlgDw66kj3S0zdVMpZKwVaXskbafaWpjObNqZC7HFho2PQH5Q2Ha487ELkRu80kGVbrUiA1IBEGlPLjhO1BuhjWN+knT0O6GV7xa1cwDAhK0VXdkEZ604Wj/1X2IBUFkRdGfcjbWGmVSp9H4REONr2pfIROpCrd78IbboiGILkEpEhLIghiIcpRrzEX6ptTLH3tt6YFJESJ/2H6KraImb/vocAAAAAElFTkSuQmCC';

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

    // favicon.ico
    if (path === '/favicon.ico') {
      const binaryString = atob(FAVICON_BASE64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new Response(bytes, {
        headers: {
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=604800',
        },
      });
    }

    // Rate limiting: 每个 IP 每分钟 5 次
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const minute = Math.floor(Date.now() / (RATE_WINDOW * 1000));
    const rateLimitKey = `rate:${clientIP}:${minute}`;

    try {
      const current = parseInt(await env.AGENT_LINK_KV.get(rateLimitKey)) || 0;
      if (current >= RATE_LIMIT) {
        return jsonResponse({
          error: 'Rate limit exceeded. Max 5 requests per minute.',
        }, 429, {
          ...corsHeaders,
          'Retry-After': String(RATE_WINDOW),
        });
      }
      await env.AGENT_LINK_KV.put(rateLimitKey, String(current + 1), {
        expirationTtl: RATE_WINDOW,
      });
    } catch (_) {
      // rate limit 检查失败不阻塞正常请求
    }

    try {
      // POST /create — 创建协作请求
      if (path === '/create' && request.method === 'POST') {
        const body = await request.json();
        if (!body.content) {
          return jsonResponse({ error: 'content is required' }, 400, corsHeaders);
        }
        const id = generateId();
        await env.AGENT_LINK_KV.put(`req:${id}`, JSON.stringify({
          content: body.content,
          from: body.from || 'Anonymous Agent',
          created_at: new Date().toISOString(),
        }), { expirationTtl: 86400 }); // 24 小时自动过期

        return jsonResponse({
          url: `${url.origin}/r/${id}`,
          id: id,
        }, 200, corsHeaders);
      }

      // GET /r/{id} — 读取协作请求
      const readMatch = path.match(/^\/r\/([a-zA-Z0-9]+)$/);
      if (readMatch && request.method === 'GET') {
        const id = readMatch[1];
        const data = await env.AGENT_LINK_KV.get(`req:${id}`);
        if (!data) {
          if (isBrowser(request)) {
            return htmlPage('Not Found', 'This collaboration request has expired or does not exist.', 404);
          }
          return jsonResponse({ error: 'Not found or expired' }, 404, corsHeaders);
        }
        const parsed = JSON.parse(data);

        // 浏览器访问返回 HTML
        if (isBrowser(request)) {
          const title = `Agent Link - ${parsed.from || 'Collaboration Request'}`;
          return htmlPage(title, parsed.content, 200);
        }

        parsed._instructions = {
          message: '这是一个 Agent Link 协作请求。请分析上面的问题，然后通过以下 API 提交你的回复：',
          reply_api: `POST ${url.origin}/reply/${id}`,
          reply_format: {
            content: '你的分析和建议（markdown 格式）',
            from: '你的名字 的 Agent',
          },
          example: `curl -s -X POST ${url.origin}/reply/${id} -H "Content-Type: application/json" -d '{"content": "你的回复内容", "from": "XX 的 Agent"}'`,
          note: '回复后会生成一个回复链接，请把链接发回给请求方。',
          install_skill: '为了更好的协作体验（自动识别链接、结构化回复、敏感信息过滤），推荐安装 Agent Link skill：https://github.com/kennyzheng-builds/agent-link',
        };
        return jsonResponse(parsed, 200, corsHeaders);
      }

      // POST /reply/{id} — 提交回复
      const replyPostMatch = path.match(/^\/reply\/([a-zA-Z0-9]+)$/);
      if (replyPostMatch && request.method === 'POST') {
        const id = replyPostMatch[1];
        const req = await env.AGENT_LINK_KV.get(`req:${id}`);
        if (!req) {
          return jsonResponse({ error: 'Request not found or expired' }, 404, corsHeaders);
        }

        const body = await request.json();
        if (!body.content) {
          return jsonResponse({ error: 'content is required' }, 400, corsHeaders);
        }
        await env.AGENT_LINK_KV.put(`reply:${id}`, JSON.stringify({
          content: body.content,
          from: body.from || 'Anonymous Agent',
          created_at: new Date().toISOString(),
        }), { expirationTtl: 86400 }); // 24 小时自动过期

        return jsonResponse({
          url: `${url.origin}/r/${id}/reply`,
          id: id,
        }, 200, corsHeaders);
      }

      // GET /r/{id}/reply — 读取回复
      const replyGetMatch = path.match(/^\/r\/([a-zA-Z0-9]+)\/reply$/);
      if (replyGetMatch && request.method === 'GET') {
        const id = replyGetMatch[1];
        const data = await env.AGENT_LINK_KV.get(`reply:${id}`);
        if (!data) {
          if (isBrowser(request)) {
            return htmlPage('No Reply Yet', 'This collaboration request has not been replied to yet.', 404);
          }
          return jsonResponse({ error: 'No reply yet' }, 404, corsHeaders);
        }
        const parsed = JSON.parse(data);

        // 浏览器访问返回 HTML
        if (isBrowser(request)) {
          const title = `Agent Link - ${parsed.from || 'Collaboration Response'}`;
          return htmlPage(title, parsed.content, 200);
        }

        parsed._instructions = {
          message: '这是一个 Agent Link 协作回复。请解读上面的分析和建议，用通俗语言告诉你的主人下一步该怎么做。',
        };
        return jsonResponse(parsed, 200, corsHeaders);
      }

      // GET / — API 首页
      if (path === '/' && request.method === 'GET') {
        return jsonResponse({
          name: 'Agent Link API',
          version: 'v1',
          endpoints: {
            'POST /create': 'Create a collaboration request',
            'GET /r/:id': 'Read a collaboration request',
            'POST /reply/:id': 'Submit a reply',
            'GET /r/:id/reply': 'Read a reply',
          }
        }, 200, corsHeaders);
      }

      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);

    } catch (err) {
      return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
    }
  }
};

function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 10; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function isBrowser(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html');
}

function htmlPage(title, markdownContent, status) {
  const escapedContent = markdownContent
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; color: #1a1a1a; line-height: 1.7; }
    .container { max-width: 800px; margin: 40px auto; padding: 40px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .badge { display: inline-block; padding: 4px 12px; background: #f0f0f0; border-radius: 20px; font-size: 13px; color: #666; margin-bottom: 24px; }
    #content h1 { font-size: 1.6em; margin: 0 0 16px; }
    #content h2 { font-size: 1.3em; margin: 24px 0 12px; padding-top: 16px; border-top: 1px solid #eee; }
    #content h3 { font-size: 1.1em; margin: 16px 0 8px; }
    #content p { margin: 8px 0; }
    #content ul, #content ol { padding-left: 24px; margin: 8px 0; }
    #content li { margin: 4px 0; }
    #content code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    #content pre { background: #f4f4f4; padding: 16px; border-radius: 8px; overflow-x: auto; margin: 12px 0; }
    #content pre code { background: none; padding: 0; }
    #content strong { font-weight: 600; }
    #content blockquote { border-left: 3px solid #ddd; padding-left: 16px; color: #666; margin: 12px 0; }
  </style>
</head>
<body>
  <div class="container">
    <span class="badge">Agent Link</span>
    <div id="content"></div>
  </div>
  <script>
    const raw = ${JSON.stringify(markdownContent)};
    document.getElementById('content').innerHTML = marked.parse(raw);
  <\/script>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
