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

import { ProxyAgent, request as undiciRequest } from 'undici';

// 允许的目标域名白名单
const ALLOWED_TARGETS = [
  'app.m.jd.com',
  'api.m.jd.com',
  'm.jd.com',
  'plogin.m.jd.com',
];

// ── 从闪臣 API 获取代理 IP ────────────────────────────────────────
async function fetchProxyUrl(proxyApiUrl) {
  const resp = await fetch(proxyApiUrl, { signal: AbortSignal.timeout(6000) });
  if (!resp.ok) throw new Error(`代理 API 返回 HTTP ${resp.status}`);
  const text = (await resp.text()).trim();

  // JSON 格式：{ data: [{ ip, port }] }
  try {
    const json = JSON.parse(text);
    const item = json?.data?.[0] ?? json?.[0];
    if (item?.ip && item?.port) return `http://${item.ip}:${item.port}`;
    if (json?.ip && json?.port) return `http://${json.ip}:${json.port}`;
  } catch {
    // 非 JSON，继续往下
  }

  // 纯文本格式：ip:port
  const match = text.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
  if (match) return `http://${match[1]}:${match[2]}`;

  throw new Error(`无法解析代理 API 响应: ${text.slice(0, 100)}`);
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

    // ── 通过住宅代理发起请求 ─────────────────────────────────────
    const agent = new ProxyAgent(proxyUrl);
    const targetURL = new URL(targetUrl);

    const { statusCode, headers: respHeaders, body: bodyStream } = await undiciRequest(targetUrl, {
      method: method || 'GET',
      path: targetURL.pathname + targetURL.search,
      headers: headers || {},
      body: body || undefined,
      dispatcher: agent,
      maxRedirections: redirect === 'manual' ? 0 : 5,
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
