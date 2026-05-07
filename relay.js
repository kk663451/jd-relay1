/**
 * JD WSKey 中转服务 - Vercel Serverless Function
 *
 * 职责：接收 Supabase Edge Function 的转发请求，通过住宅代理调用京东接口
 *
 * 请求格式（POST JSON）：
 * {
 *   secret: string,        // 鉴权密钥，与 RELAY_SECRET 环境变量一致
 *   targetUrl: string,     // 目标 URL（如 https://app.m.jd.com/...）
 *   method: string,        // HTTP 方法
 *   headers: object,       // 请求头
 *   body: string,          // 请求体（字符串）
 *   proxyUrl: string,      // 代理 URL（如 http://58.19.48.193:52601）
 *   redirect: string       // 'follow' | 'manual'
 * }
 *
 * 响应格式（JSON）：
 * {
 *   status: number,
 *   headers: object,
 *   body: string
 * }
 */

import { ProxyAgent, request as undiciRequest } from 'undici';

// 允许的目标域名白名单（安全限制）
const ALLOWED_TARGETS = [
  'app.m.jd.com',
  'api.m.jd.com',
  'm.jd.com',
];

export default async function handler(req, res) {
  // 设置 CORS 头
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
    const { secret, targetUrl, method, headers, body, proxyUrl, redirect } = req.body;

    // ── 鉴权 ────────────────────────────────────────────────────
    const RELAY_SECRET = process.env.RELAY_SECRET;
    if (RELAY_SECRET && secret !== RELAY_SECRET) {
      res.status(401).json({ error: '鉴权失败：secret 不匹配' });
      return;
    }

    // ── 参数校验 ─────────────────────────────────────────────────
    if (!targetUrl || !proxyUrl) {
      res.status(400).json({ error: '缺少必要参数：targetUrl 或 proxyUrl' });
      return;
    }

    // ── 目标域名白名单校验 ───────────────────────────────────────
    const targetHost = new URL(targetUrl).hostname;
    if (!ALLOWED_TARGETS.some(d => targetHost === d || targetHost.endsWith('.' + d))) {
      res.status(403).json({ error: `目标域名不在白名单：${targetHost}` });
      return;
    }

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

    // ── 返回结果 ─────────────────────────────────────────────────
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
