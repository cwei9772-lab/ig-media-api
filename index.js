'use strict';
/**
 * IG 图片下载 · 后端（Render 单文件版）
 * 零第三方依赖，只需 Node 18+
 *
 * 部署在境外机房（Render）上，因此不需要代理，直连 instagram.com。
 * 接口：
 *   GET  /                    自检页
 *   GET  /api/health          健康检查（Render 健康检查路径）
 *   GET  /api/selftest        检测能否访问 instagram.com
 *   GET  /api/parse?url=      解析帖子（也支持 POST {url}）
 *   GET  /api/img?u=<url>     图片/视频中转（白名单限制）
 *   GET  /api/img?d=<n>       内置示例图
 *   GET  /api/demo            示例解析结果
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const VERSION = '1.1.0';
const START_AT = Date.now();
const TIMEOUT = Number(process.env.IG_TIMEOUT || 15000);
const RETRIES = Number(process.env.IG_RETRIES || 1);
// 可选：设置 API_TOKEN 后，调用需带 ?t=xxx 或 x-api-token 头，防止别人蹭你的中转
const API_TOKEN = (process.env.API_TOKEN || '').trim();

/* 可选：带登录态（从环境变量读，代码里不写任何凭据值）
 * 只在“公开页面拿不到轮播图”时用；不设这些变量就完全按匿名模式跑。
 *   IG_SESSIONID   必填，Instagram 的 sessionid
 *   IG_CSRFTOKEN   可选，csrftoken
 *   IG_DS_USER_ID  可选，ds_user_id
 */
function buildIGCookie() {
  const sid = (process.env.IG_SESSIONID || '').trim();
  if (!sid) return { header: '', csrf: '', label: 'off' };
  const csrf = (process.env.IG_CSRFTOKEN || '').trim();
  const uid = (process.env.IG_DS_USER_ID || '').trim();
  const parts = ['sessionid=' + sid];
  if (csrf) parts.push('csrftoken=' + csrf);
  if (uid) parts.push('ds_user_id=' + uid);
  return { header: parts.join('; '), csrf, label: 'on(' + parts.length + ')' };
}
const IG_COOKIE = buildIGCookie();

const ALLOWED_HOSTS = [
  'cdninstagram.com',
  'instagram.com',
  'fbcdn.net',
  'instagramstatic-a.akamaihd.net'
];

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];
const pickUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

/* ------------------------------------------------------------------ 出网请求 */
function decompress(buf, enc) {
  if (!enc) return buf;
  const e = String(enc).toLowerCase();
  try {
    if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf);
    if (e === 'br') return zlib.brotliDecompressSync(buf);
    if (e === 'deflate') return zlib.inflateSync(buf);
  } catch (err) {
    return buf;
  }
  return buf;
}

function requestOnce(target, opts) {
  const u = new URL(target);
  const timeout = opts.timeout || TIMEOUT;
  const method = opts.method || 'GET';
  const body = opts.body || null;
  const headers = Object.assign(
    {
      'User-Agent': opts.userAgent || pickUA(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'close'
    },
    opts.headers || {}
  );
  if (body) headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
        path: u.pathname + u.search,
        method,
        headers,
        timeout
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 25 * 1024 * 1024) {
            req.destroy(new Error('响应超过 25MB'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: decompress(Buffer.concat(chunks), res.headers['content-encoding'])
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时（' + timeout + 'ms）')));
    if (body) req.write(body);
    req.end();
  });
}

async function fetchWithRetry(rawUrl, opts = {}) {
  let current = rawUrl;
  for (let i = 0; i <= (opts.retries != null ? opts.retries : RETRIES); i++) {
    try {
      for (let hop = 0; hop <= 6; hop++) {
        const res = await requestOnce(current, opts);
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          current = new URL(res.headers.location, current).toString();
          continue;
        }
        return Object.assign(res, { url: current });
      }
      throw new Error('重定向次数过多');
    } catch (e) {
      if (i === (opts.retries != null ? opts.retries : RETRIES)) throw e;
      if (/超时|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}

/* ------------------------------------------------------------------ 解析逻辑 */
const IG = 'https://www.instagram.com';
const POST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1'
};

function unescapeJsonString(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ');
}

function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractTarget(input) {
  if (!input) return null;
  const text = String(input).trim();
  const m = text.match(/instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i);
  if (m) {
    const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
    return { shortcode: m[2], kind, url: IG + '/' + kind + '/' + m[2] + '/' };
  }
  if (/^[A-Za-z0-9_-]{5,20}$/.test(text)) {
    return { shortcode: text, kind: 'p', url: IG + '/p/' + text + '/' };
  }
  return null;
}

function pickAll(html, key) {
  const out = [];
  const re = new RegExp('"' + key + '":"([^"]*)"', 'g');
  let m;
  while ((m = re.exec(html))) out.push({ value: unescapeJsonString(m[1]), index: m.index });
  return out;
}

function parseHtml(html, target) {
  const result = {
    shortcode: target.shortcode,
    url: target.url,
    kind: target.kind,
    author: '',
    caption: '',
    items: [],
    source: 'embed'
  };

  const sidecarAt = html.indexOf('"edge_sidecar_to_children"');
  const scope = sidecarAt > -1 ? html.slice(sidecarAt) : html;

  const markers = [];
  for (const m of pickAll(scope, 'display_url')) markers.push({ t: 'img', i: m.index, u: m.value });
  for (const m of pickAll(scope, 'video_url')) markers.push({ t: 'vid', i: m.index, u: m.value });
  markers.sort((a, b) => a.i - b.i);

  const seen = new Set();
  for (const mk of markers) {
    if (!mk.u || !/^https?:\/\//.test(mk.u)) continue;
    if (mk.t === 'img') {
      if (seen.has(mk.u)) continue;
      seen.add(mk.u);
      const near = scope.slice(mk.i, mk.i + 700);
      const dim = near.match(/"dimensions":\{"height":(\d+),"width":(\d+)\}/);
      result.items.push({
        type: 'image',
        url: mk.u,
        width: dim ? Number(dim[2]) : 0,
        height: dim ? Number(dim[1]) : 0,
        thumb: mk.u,
        video: ''
      });
    } else {
      const last = result.items[result.items.length - 1];
      if (last && !last.video) {
        last.type = 'video';
        last.video = mk.u;
      } else {
        result.items.push({ type: 'video', url: mk.u, width: 0, height: 0, thumb: '', video: mk.u });
      }
    }
  }

  if (!result.items.length) {
    const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (og) {
      const u = decodeEntities(og[1]);
      result.items.push({ type: 'image', url: u, width: 0, height: 0, thumb: u, video: '' });
      result.source = 'og';
    }
  }

  result.author =
    (html.match(/"owner":\{[^}]*?"username":"([^"]+)"/) || [])[1] ||
    (html.match(/"username":"([A-Za-z0-9._]{2,40})"/) || [])[1] ||
    (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+?) on Instagram/i) || [])[1] ||
    '';

  const cap =
    (html.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/) || [])[1] ||
    (html.match(/"caption":\{"text":"((?:[^"\\]|\\.)*)"/) || [])[1] ||
    (html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) || [])[1] ||
    '';
  result.caption = decodeEntities(unescapeJsonString(cap)).slice(0, 400);
  return result;
}

function isConnError(e) {
  return /超时|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(
    String((e && e.message) || '')
  );
}

/* ------------------------------------------------ 轮播补全：走媒体详情接口拿全部子项 */
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function mediaIdFromShortcode(sc) {
  let id = BigInt(0);
  for (const ch of String(sc)) {
    const idx = SHORTCODE_ALPHABET.indexOf(ch);
    if (idx < 0) return '';
    id = id * BigInt(64) + BigInt(idx);
  }
  return id.toString();
}

function firstImageUrl(versions) {
  const cands = (versions && versions.candidates) || [];
  return cands.length ? cands[0].url : '';
}

async function fetchPostGraphQL(shortcode) {
  const info = { status: 0, note: '', ok: false, items: [], author: '', caption: '' };
  const vars = {
    shortcode: shortcode,
    first: 50,
    after: null,
    last: null,
    before: null,
    data: { comment_count: 0, include_reel_media_seen_timestamp: true }
  };
  const body = 'doc_id=8845758582119845&variables=' + encodeURIComponent(JSON.stringify(vars));
  let res;
  try {
    res = await fetchWithRetry(IG + '/graphql/query', {
      method: 'POST',
      body: body,
      timeout: TIMEOUT,
      retries: 0,
      headers: Object.assign(
        {
          'content-type': 'application/x-www-form-urlencoded',
          'x-ig-app-id': '936619743392459',
          'x-fb-friendly-name': 'PolarisPostActionLoadPostQueryQuery',
          origin: IG,
          referer: IG + '/p/' + shortcode + '/',
          Accept: '*/*'
        },
        IG_COOKIE.header
          ? { Cookie: IG_COOKIE.header, 'x-csrftoken': IG_COOKIE.csrf || 'missing', 'x-ig-www-claim': '0' }
          : {}
      )
    });
  } catch (e) {
    info.note = 'err(' + e.message + ')';
    return info;
  }
  info.status = res.statusCode;
  if (res.statusCode !== 200) {
    info.note = 'HTTP ' + res.statusCode;
    return info;
  }
  let json;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    info.note = '非JSON';
    return info;
  }
  const m = (json.data && (json.data.xdt_shortcode_media || json.data.shortcode_media)) || null;
  if (!m) {
    info.note = 'lack_media';
    return info;
  }
  const edges = m.edge_sidecar_to_children && m.edge_sidecar_to_children.edges;
  const nodes = edges && edges.length ? edges.map((e) => e.node) : [m];
  for (const nd of nodes) {
    if (!nd) continue;
    const dim = nd.dimensions || {};
    if (nd.is_video && nd.video_url) {
      info.items.push({
        type: 'video',
        url: nd.display_url || nd.video_url,
        width: dim.width || 0,
        height: dim.height || 0,
        thumb: nd.display_url || '',
        video: nd.video_url
      });
    } else if (nd.display_url) {
      info.items.push({
        type: 'image',
        url: nd.display_url,
        width: dim.width || 0,
        height: dim.height || 0,
        thumb: nd.display_url,
        video: ''
      });
    }
  }
  info.author = (m.owner && m.owner.username) || '';
  info.caption =
    (m.edge_media_to_caption &&
      m.edge_media_to_caption.edges &&
      m.edge_media_to_caption.edges[0] &&
      m.edge_media_to_caption.edges[0].node.text) ||
    '';
  info.ok = info.items.length > 0;
  if (!info.ok) info.note = '没有媒体';
  return info;
}

async function fetchMediaInfo(shortcode) {
  const info = { status: 0, ok: false, note: '', items: [], author: '', caption: '' };
  if (Date.now() < fullPostBlockedUntil) {
    info.note = '冷却中（此前被 IG 拒绝，跳过轮播补全）';
    return info;
  }
  const id = mediaIdFromShortcode(shortcode);
  if (!id) {
    info.note = 'shortcode 非法';
    return info;
  }

  const targets = [
    { url: IG + '/api/v1/media/' + id + '/info/', appId: '936619743392459', android: false },
    { url: IG + '/api/v1/media/' + id + '/info/', appId: '1217981644879628', android: false },
    { url: 'https://i.instagram.com/api/v1/media/' + id + '/info/', appId: '567067343352427', android: true }
  ];

  // 先走 GraphQL（轮播帖最完整的来源），失败再退回 api/v1
  const gql = await fetchPostGraphQL(shortcode);
  info.gqlStatus = gql.status;
  info.gqlNote = gql.note;
  if (gql.ok) {
    info.items = gql.items;
    info.author = gql.author;
    info.caption = gql.caption;
    info.status = gql.status;
    info.note = 'graphql:' + gql.status;
    info.ok = info.items.length > 0;
    return info;
  }
  // 403/429 说明这个出口 IP 被 IG 拒了，后面两个接口同样会被拒，直接冷却 10 分钟，
  // 免得每个帖子都白等好几秒
  if (gql.status === 403 || gql.status === 429) {
    fullPostBlockedUntil = Date.now() + FULLPOST_COOLDOWN;
    info.status = gql.status;
    info.note = 'graphql:' + gql.status + '（IP 被拒，' + Math.round(FULLPOST_COOLDOWN / 60000) + ' 分钟内不再尝试）';
    return info;
  }

  const notes = [];
  let json = null;
  for (const t of targets) {
    let res;
    try {
      res = await fetchWithRetry(t.url, {
        timeout: TIMEOUT,
        retries: 0,
        headers: Object.assign(
          {
            'x-ig-app-id': t.appId,
            Accept: '*/*',
            Referer: IG + '/p/' + shortcode + '/',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
            'User-Agent': t.android
              ? 'Instagram 219.0.0.12.117 Android (26/8.0.0; 480dpi; 1080x1920; samsung; SM-G950F; dreamlte; samsungexynos8895; en_US)'
              : 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
          },
          IG_COOKIE.header ? { Cookie: IG_COOKIE.header } : {}
        )
      });
    } catch (e) {
      notes.push(t.appId + ':err(' + e.message + ')');
      continue;
    }
    info.status = res.statusCode;
    notes.push(t.appId + ':' + res.statusCode);
    if (res.statusCode !== 200) {
      if (res.statusCode === 429) await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch (e) {
      notes.push(t.appId + ':非JSON');
      continue;
    }
    break;
  }
  info.note = notes.join(' | ');
  if (!json) return info;

  const item = (json.items || [])[0];
  if (!item) {
    info.note += ' items为空';
    return info;
  }

  const children = Array.isArray(item.carousel_media) && item.carousel_media.length ? item.carousel_media : [item];
  for (const c of children) {
    const img = firstImageUrl(c.image_versions2);
    const vid = Array.isArray(c.video_versions) && c.video_versions.length ? c.video_versions[0].url : '';
    if (vid) {
      info.items.push({ type: 'video', url: img || vid, width: c.width || 0, height: c.height || 0, thumb: img, video: vid });
    } else if (img) {
      info.items.push({ type: 'image', url: img, width: c.width || 0, height: c.height || 0, thumb: img, video: '' });
    }
  }
  info.author = (item.user && item.user.username) || '';
  info.caption = (item.caption && item.caption.text) || '';
  info.ok = info.items.length > 0;
  if (!info.ok) info.note += ' 没有可用媒体';
  return info;
}

// 备用路子：带上 img_index 请求帖子页，看 og:image 是否按序号变化（能变就说明每张都有独立封面）
async function fetchOgByIndex(shortcode, kind, maxIndex) {
  const found = [];
  const max = maxIndex || 10;
  for (let i = 1; i <= max; i++) {
    try {
      const res = await fetchWithRetry(IG + '/' + kind + '/' + shortcode + '/?img_index=' + i, {
        timeout: TIMEOUT,
        retries: 0,
        headers: POST_HEADERS
      });
      if (res.statusCode !== 200) continue;
      const og = res.body.toString('utf8').match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      if (!og) continue;
      const u = decodeEntities(og[1]);
      if (u && !found.includes(u)) found.push(u);
    } catch (e) {
      continue;
    }
  }
  return found;
}

const cache = new Map();
// 轮播补全用的“带鉴权接口”一旦被 IG 拒（403/429），冷却一段时间不再尝试
const FULLPOST_COOLDOWN = 10 * 60 * 1000;
let fullPostBlockedUntil = 0;
function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(k);
    return null;
  }
  return hit.v;
}
function cacheSet(k, v) {
  cache.set(k, { v, exp: Date.now() + 10 * 60 * 1000 });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

async function parse(input) {
  const target = extractTarget(input);
  if (!target) {
    const err = new Error('没识别出 Instagram 链接，请粘贴形如 https://www.instagram.com/p/XXXX/ 的地址');
    err.code = 'BAD_LINK';
    throw err;
  }

  const cached = cacheGet('p:' + target.shortcode);
  if (cached) return Object.assign({ cached: true }, cached);

  const attempts = [
    { name: 'embed', url: IG + '/' + target.kind + '/' + target.shortcode + '/embed/captioned/' },
    { name: 'page', url: target.url }
  ];

  let lastErr = null;
  let htmlSeen = '';
  let connFail = false;
  let parsedOk = null;

  for (const att of attempts) {
    try {
      const res = await fetchWithRetry(att.url, { timeout: TIMEOUT, retries: 0, headers: POST_HEADERS });
      if (res.statusCode === 404) {
        const err = new Error('帖子不存在或已删除（HTTP 404）');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (res.statusCode === 429) {
        lastErr = new Error('Instagram 返回 429（这个出口 IP 被限流了，稍后再试或换部署区域）');
        break;
      }
      if (res.statusCode !== 200) {
        lastErr = new Error(att.name + ' 页面返回 HTTP ' + res.statusCode);
        continue;
      }
      const html = res.body.toString('utf8');
      htmlSeen = html;
      const parsed = parseHtml(html, target);
      parsed.source = att.name;
      if (parsed.items.length) {
        parsedOk = parsed;
        break;
      }
      lastErr = new Error(att.name + ' 页面里没有解析到媒体');
    } catch (e) {
      lastErr = e;
      if (e.code === 'NOT_FOUND') throw e;
      if (isConnError(e)) {
        connFail = true;
        break;
      }
    }
  }

  // 轮播帖（/p/xxxx?img_index=4 这类）embed 页只给第一张，用媒体详情接口补齐全部子项
  if (parsedOk && parsedOk.items.length <= 1) {
    const mi = await fetchMediaInfo(target.shortcode);
    parsedOk.meta = { apiStatus: mi.status, apiNote: mi.note, apiCount: mi.items.length };
    if (mi.ok && mi.items.length > parsedOk.items.length) {
      parsedOk.items = mi.items;
      parsedOk.source = 'api';
      if (mi.author) parsedOk.author = mi.author;
      if (mi.caption) parsedOk.caption = mi.caption;
    }
  } else if (!parsedOk) {
    // embed / 页面都失败时，再试一次媒体详情接口
    const mi = await fetchMediaInfo(target.shortcode);
    if (mi.ok) {
      parsedOk = {
        shortcode: target.shortcode,
        url: target.url,
        kind: target.kind,
        author: mi.author,
        caption: mi.caption,
        items: mi.items,
        source: 'api',
        meta: { apiStatus: mi.status, apiNote: mi.note, apiCount: mi.items.length }
      };
    }
  }

  if (parsedOk) {
    cacheSet('p:' + target.shortcode, parsedOk);
    return parsedOk;
  }

  if (connFail) {
    const err = new Error('连不上 instagram.com（' + (lastErr ? lastErr.message : '网络不可达') + '）');
    err.code = 'NETWORK';
    throw err;
  }

  const needLogin = htmlSeen && !/"display_url"|og:image/.test(htmlSeen) && htmlSeen.length < 4000;
  const err = new Error(
    (lastErr && lastErr.message ? lastErr.message + '；' : '') +
    (needLogin
      ? '页面返回了登录墙：这个机房 IP 被 Instagram 风控了'
      : '没有拿到媒体列表，可能是云机房 IP 被风控，或帖子需要登录')
  );
  err.code = 'PARSE_FAILED';
  throw err;
}

async function selfTest() {
  const t0 = Date.now();
  const info = { reachable: false, statusCode: 0, elapsedMs: 0, message: '' };
  try {
    const res = await fetchWithRetry(IG + '/robots.txt', { timeout: Math.min(TIMEOUT, 12000), retries: 0 });
    info.statusCode = res.statusCode;
    info.reachable = res.statusCode > 0 && res.statusCode < 500;
    info.message = info.reachable ? '可以访问 instagram.com' : '状态码异常';
  } catch (e) {
    info.message = e.message;
  }
  info.elapsedMs = Date.now() - t0;
  return info;
}

/* ------------------------------------------------------------------ 示例图（纯 Node 生成 PNG） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
const demoCache = new Map();
function demoPng(n, w, h) {
  const key = n + ':' + w + 'x' + h;
  if (demoCache.has(key)) return demoCache.get(key);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const base = (Number(n) * 47) % 360;
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const rgb = hsl((base + (y / h) * 50 + (x / w) * 18) % 360, 0.7, 0.42 + (y / h) * 0.16);
      const p = row + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  if (demoCache.size < 16) demoCache.set(key, png);
  return png;
}
const DEMO = {
  shortcode: 'demo123',
  url: IG + '/p/demo123/',
  kind: 'p',
  author: 'demo_user',
  caption: '示例数据：用来在没配好真实链接时先看界面和保存流程。',
  source: 'demo',
  items: [1, 2, 3, 4, 5, 6].map((n) => ({
    type: 'image',
    demo: n,
    url: '',
    thumb: '',
    width: 720,
    height: 900,
    video: ''
  }))
};

/* ------------------------------------------------------------------ HTTP 服务 */
function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function sendText(res, status, text, type) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': (type || 'text/plain') + '; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}
function hostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some((s) => h === s || h.endsWith('.' + s));
}
function tokenOk(req, query) {
  if (!API_TOKEN) return true;
  return query.get('t') === API_TOKEN || req.headers['x-api-token'] === API_TOKEN;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) return req.destroy(new Error('请求体过大'));
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({ url: raw.trim() });
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    return sendText(res, 400, 'bad request');
  }
  const path = u.pathname;
  const q = u.searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-api-token'
    });
    return res.end();
  }

  try {
    if (path === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        uptimeSec: Math.round((Date.now() - START_AT) / 1000),
        region: process.env.RENDER_REGION || 'unknown',
        cacheEntries: cache.size,
        cookieMode: IG_COOKIE.label
      });
    }

    if (path === '/api/selftest') {
      const st = await selfTest();
      return sendJson(res, 200, Object.assign({ ok: st.reachable }, st));
    }

    if (path === '/api/demo') {
      return sendJson(res, 200, { ok: true, data: DEMO });
    }

    if (path === '/api/debug') {
      const raw = q.get('sc') || q.get('url') || '';
      const t = extractTarget(raw);
      if (!t) return sendJson(res, 400, { ok: false, error: '缺少 sc 参数' });
      const mi = await fetchMediaInfo(t.shortcode);
      const ogs = await fetchOgByIndex(t.shortcode, t.kind, 10);
      return sendJson(res, 200, {
        ok: true,
        shortcode: t.shortcode,
        cookieMode: IG_COOKIE.label,
        gqlStatus: mi.gqlStatus,
        gqlNote: mi.gqlNote,
        apiStatus: mi.status,
        apiNote: mi.note,
        apiCount: mi.items.length,
        apiItems: mi.items.slice(0, 3).map((x) => ({ type: x.type, w: x.width, h: x.height, url: x.url.slice(0, 90) })),
        ogCount: ogs.length,
        ogItems: ogs.map((u) => u.slice(0, 90)),
        mediaId: mediaIdFromShortcode(t.shortcode)
      });
    }

    if (path === '/api/parse') {
      if (!tokenOk(req, q)) return sendJson(res, 401, { ok: false, error: '缺少访问口令' });
      let link = q.get('url');
      if (req.method === 'POST') {
        const body = await readBody(req);
        link = body.url || link;
      }
      if (!link) return sendJson(res, 400, { ok: false, error: '缺少 url 参数' });
      const data = await parse(link);
      return sendJson(res, 200, { ok: true, data });
    }

    if (path === '/api/img') {
      const d = q.get('d');
      if (d) {
        const buf = demoPng(Number(d) || 1, 720, 900);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        });
        return res.end(buf);
      }
      if (!tokenOk(req, q)) return sendJson(res, 401, { ok: false, error: '缺少访问口令' });
      let raw = q.get('u') || '';
      if (raw.startsWith('b64:')) raw = Buffer.from(raw.slice(4), 'base64url').toString('utf8');
      let target;
      try {
        target = new URL(raw);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: 'u 不是合法 URL' });
      }
      if (!hostAllowed(target.hostname)) {
        return sendJson(res, 403, { ok: false, error: '域名不在白名单：' + target.hostname });
      }
      const up = await fetchWithRetry(target.toString(), {
        timeout: TIMEOUT,
        retries: 1,
        headers: { Accept: 'image/*,video/*,*/*;q=0.8', Referer: IG + '/' }
      });
      if (up.statusCode !== 200) {
        return sendJson(res, 502, { ok: false, error: '上游返回 HTTP ' + up.statusCode });
      }
      res.writeHead(200, {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Content-Length': up.body.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(up.body);
    }

    if (path === '/') {
      const st = await selfTest();
      return sendText(res, 200, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>IG 媒体 API</title>
<style>body{font-family:system-ui,"Microsoft YaHei";background:#0b0b12;color:#e8e8f0;padding:36px;line-height:1.8}
.card{background:#15151f;border:1px solid #26263a;border-radius:14px;padding:22px;max-width:680px}
a{color:#7cd1ff}.ok{color:#5ee08a}.bad{color:#ff7b7b}code{background:#1e1e2c;padding:2px 6px;border-radius:6px}</style></head><body><div class="card">
<h1>IG 媒体 API v${VERSION}</h1>
<p>服务状态：<span class="ok">运行中</span>，端口 <code>${PORT}</code>，区域 <code>${process.env.RENDER_REGION || 'unknown'}</code></p>
<p>Instagram 连通性：${st.reachable ? '<span class="ok">可以访问</span>' : '<span class="bad">不可达</span>'}（${st.elapsedMs}ms）${st.reachable ? '' : '<br><small>' + st.message + '</small>'}</p>
<ul><li><a href="/api/health">/api/health</a></li><li><a href="/api/selftest">/api/selftest</a></li>
<li><a href="/api/demo">/api/demo</a></li><li><a href="/api/parse?url=https://www.instagram.com/p/C8example/">/api/parse?url=…</a></li></ul>
<p>小程序里把服务器地址填成这个域名即可。</p></div></body></html>`, 'text/html');
    }

    return sendJson(res, 404, { ok: false, error: '没有这个接口：' + path });
  } catch (e) {
    const code = e.code === 'BAD_LINK' || e.code === 'NOT_FOUND' ? 400 : 502;
    console.log('[error]', path, e.message);
    return sendJson(res, code, { ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

if (process.argv.includes('--selftest')) {
  selfTest().then((st) => {
    console.log('\n=== 环境自检 ===');
    console.log('可达性 :', st.reachable ? '可以访问 instagram.com' : '访问失败');
    console.log('状态码 :', st.statusCode || '-');
    console.log('耗时   :', st.elapsedMs + 'ms');
    console.log('说明   :', st.message, '\n');
    process.exit(st.reachable ? 0 : 2);
  });
} else {
  server.listen(PORT, HOST, () => {
    console.log('IG 媒体 API 已启动 http://' + HOST + ':' + PORT + '  (自检: node index.js --selftest)');
  });
  server.on('error', (e) => {
    console.error('[启动失败]', e.message);
    process.exit(1);
  });
}
