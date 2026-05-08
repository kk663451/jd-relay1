/**
 * JD WSKey 中转服务 - Vercel Serverless Function
 *
 * 职责：浏览器直接调用此接口，通过住宅代理访问京东接口（绕过 CORS 限制）
 *
 * 请求格式（POST JSON）：
 * {
 *   secret: string,        // 鉴权密钥（可选，与 RELAY_SECRET 环境变量一致）
 *   targetUrl: string,     // 目标 URL（如 https://app.m.jd.com/...）
 *   method: string,        // HTTP 方法
 *   headers: object,       // 请求头
 *   body: string,          // 请求体（字符串）
 *   proxyApiUrl: string,   // 闪臣代理 API 地址（Relay 内部自动获取代理 IP）
 *   redirect: string       // 'follow' | 'manual'
 * }
 */

import { ProxyAgent } from 'undici';

// 允许的目标域名白名单
const ALLOWED_TARGETS = [
  'app.m.jd.com',
  'api.m.jd.com',
  'm.jd.com',
  'plogin.m.jd.com',
];

// ── 从闪臣 API 获取代理 IP ────────────────────────────────────────
async function fetchProxyUrl(proxyApiUrl) {
  const resp = await fetch(proxyApiUrl, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`代理 API 返回 HTTP ${resp.status}`);
  const text = (await resp.text()).trim();

  // JSON 格式：支持多种字段名（ip/sever/server + port）
  try {
    const json = JSON.parse(text);

    // ── 优先检测闪臣等代理 API 的错误响应 ──────────────────────────
    // 闪臣正常响应 status="0"，非 0 表示错误
    const apiStatus = json?.status ?? json?.code ?? json?.ret;
    if (apiStatus !== undefined && String(apiStatus) !== '0' && String(apiStatus) !== '200') {
      const msg = json?.msg ?? json?.message ?? json?.errmsg ?? json?.info ?? '';
      const hint = msg.includes('白名单') || msg.includes('whitelist')
        ? `【解决方法】登录闪臣后台 → 账号设置 → 取消勾选「IP白名单限制」或将白名单置空，改为纯 API Key 鉴权`
        : '';
      throw new Error(`代理 API 被拒绝: ${msg || `状态码 ${apiStatus}`}${hint ? '\n' + hint : ''}`);
    }

    // 格式1：{ data: [{ ip, port }] }
    // 格式2：{ list: [{ sever, port }] } —— 闪臣格式（sever 是其拼写）
    // 格式3：{ data: [{ sever, port }] }
    // 格式4：[{ ip, port }]
    const candidates = [
      json?.data?.[0], json?.list?.[0], json?.[0], json,
    ];
    for (const item of candidates) {
      if (!item) continue;
      const ip = item.ip ?? item.sever ?? item.server;
      const port = item.port;
      if (ip && port) return `http://${ip}:${port}`;
    }
  } catch (e) {
    // 若是我们自己抛出的有意义错误，直接继续上抛
    if (e.message.startsWith('代理 API 被拒绝:')) throw e;
    // 非 JSON，继续往下
  }

  // 纯文本格式：ip:port
  const match = text.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
  if (match) return `http://${match[1]}:${match[2]}`;

  throw new Error(`无法解析代理 API 响应: ${text.slice(0, 120)}`);
}

export default async function handler(req, res) {
  // 设置 CORS 头（允许浏览器直接调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: '仅支持 POST 请求' });
    return;
  }

  try {
    const { secret, targetUrl, method, headers, body, proxyApiUrl, redirect, _healthCheck } = req.body;

    // ── 鉴权 ────────────────────────────────────────────────────
    const RELAY_SECRET = process.env.RELAY_SECRET;
    if (RELAY_SECRET && secret !== RELAY_SECRET) {
      res.status(401).json({ error: '鉴权失败：secret 不匹配' });
      return;
    }

    // ── 健康检查 ─────────────────────────────────────────────────
    if (_healthCheck) {
      res.status(200).json({ ok: true, service: 'jd-relay', ts: Date.now() });
      return;
    }

    // ── 查询 Relay 出口 IP（不走代理，返回 Vercel 自身 IP）──────
    if (req.body?._getIp) {
      try {
        const ipResp = await fetch('https://api4.my-ip.io/ip.json', { signal: AbortSignal.timeout(5000) });
        const ipJson = await ipResp.json();
        res.status(200).json({ ip: ipJson.ip ?? ipJson.query ?? null });
      } catch {
        res.status(200).json({ ip: null, error: '无法获取出口 IP' });
      }
      return;
    }

    // ── 参数校验 ─────────────────────────────────────────────────
    if (!targetUrl) {
      res.status(400).json({ error: '缺少必要参数：targetUrl' });
      return;
    }
    if (!proxyApiUrl) {
      res.status(400).json({ error: '缺少必要参数：proxyApiUrl（闪臣代理 API 地址）' });
      return;
    }

    // ── 目标域名白名单校验 ───────────────────────────────────────
    const targetHost = new URL(targetUrl).hostname;
    if (!ALLOWED_TARGETS.some(d => targetHost === d || targetHost.endsWith('.' + d))) {
      res.status(403).json({ error: `目标域名不在白名单：${targetHost}` });
      return;
    }

    // ── 从闪臣 API 获取代理 IP ───────────────────────────────────
    const proxyUrl = await fetchProxyUrl(proxyApiUrl);
    console.log(`[relay] ${method || 'GET'} ${targetUrl} via ${proxyUrl}`);

    // ── 通过住宅代理发起请求（直接调用 agent.request 避免 URL 解析歧义）──
    const agent = new ProxyAgent({
      uri: proxyUrl,
      connectTimeout: 25000,   // CONNECT 隧道建立超时（默认 10000 太短）
    });
    const targetURL = new URL(targetUrl);

    const { statusCode, headers: respHeaders, body: bodyStream } = await agent.request({
      origin: targetURL.origin,
      path: targetURL.pathname + targetURL.search,
      method: (method || 'GET').toUpperCase(),
      headers: headers || {},
      body: body ?? null,
      maxRedirections: redirect === 'manual' ? 0 : 5,
      headersTimeout: 25000,
      bodyTimeout: 25000,
    });

    // ── 读取响应体 ───────────────────────────────────────────────
    const chunks = [];
    for await (const chunk of bodyStream) {
      chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
    }
    const responseBody = Buffer.concat(chunks).toString('utf8');

    console.log(`[relay] 响应 HTTP ${statusCode}，长度 ${responseBody.length}`);

    res.status(200).json({
      status: statusCode,
      headers: respHeaders,
      body: responseBody,
    });
  } catch (err) {
    console.error('[relay] 异常:', err.message);
    res.status(500).json({ error: `中转服务异常: ${err.message}` });
  }
}
