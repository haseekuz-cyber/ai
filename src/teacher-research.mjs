import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

function clean(value, max = 4_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
  }
  return true;
}

export async function validatePublicHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Only public HTTPS pages are allowed.');
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) throw new TypeError('Local addresses are blocked.');
  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new TypeError('Private or unresolved addresses are blocked.');
  return url;
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/');
}

export function htmlToText(html, maxLength = 12_000) {
  return decodeEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')).trim().slice(0, maxLength);
}

export function extractSearchResults(html, limit = 4) {
  const results = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    let url = decodeEntities(match[1]);
    try {
      const wrapped = new URL(url, 'https://html.duckduckgo.com');
      url = wrapped.searchParams.get('uddg') || wrapped.href;
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') continue;
    } catch { continue; }
    results.push({ title: htmlToText(match[2], 180), url });
    if (results.length >= limit) break;
  }
  return results;
}

async function fetchPublicText(urlValue, { maxBytes = 800_000, redirects = 0 } = {}) {
  const url = await validatePublicHttpsUrl(urlValue);
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(12_000),
    headers: { 'user-agent': 'AI-Workstation-Teacher/1.0', accept: 'text/html,text/plain;q=0.8' }
  });
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    if (redirects >= 3) throw new Error('Too many redirects.');
    return fetchPublicText(new URL(response.headers.get('location'), url).href, { maxBytes, redirects: redirects + 1 });
  }
  if (!response.ok) throw new Error(`Public page returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('Public page is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Public page is too large.');
  return { url: url.href, text };
}

export function extractPublicHttpsUrls(text, limit = 4) {
  const urls = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(/https:\/\/[^\s<>"']+/gi)) {
    const candidate = match[0].replace(/[),.;!?\]}]+$/g, '');
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' || seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      urls.push(parsed.href);
      if (urls.length >= limit) break;
    } catch { }
  }
  return urls;
}

export function youtubeVideoId(urlValue) {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0]?.slice(0, 20) || null;
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return null;
    if (url.pathname === '/watch') return url.searchParams.get('v')?.slice(0, 20) || null;
    const match = url.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/);
    return match?.[1]?.slice(0, 20) || null;
  } catch {
    return null;
  }
}

function xmlAttribute(value, name) {
  const match = String(value || '').match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

async function readYouTubeTranscript(videoId) {
  try {
    const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
    const list = await fetchPublicText(listUrl, { maxBytes: 200_000 });
    const tracks = [...list.text.matchAll(/<track\b[^>]*>/gi)].map((match) => ({
      language: xmlAttribute(match[0], 'lang_code'),
      name: xmlAttribute(match[0], 'name')
    })).filter((track) => track.language);
    const track = tracks.find((item) => item.language === 'ru') ||
      tracks.find((item) => item.language.startsWith('en')) || tracks[0];
    if (!track) return { transcript: '', language: null };
    const transcriptUrl = new URL('https://www.youtube.com/api/timedtext');
    transcriptUrl.searchParams.set('v', videoId);
    transcriptUrl.searchParams.set('lang', track.language);
    if (track.name) transcriptUrl.searchParams.set('name', track.name);
    transcriptUrl.searchParams.set('fmt', 'json3');
    const transcriptResponse = await fetchPublicText(transcriptUrl.href, { maxBytes: 1_500_000 });
    const payload = JSON.parse(transcriptResponse.text);
    const transcript = (payload.events || []).flatMap((event) => event.segs || [])
      .map((segment) => segment.utf8 || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 12_000);
    return { transcript, language: track.language };
  } catch {
    return { transcript: '', language: null };
  }
}

export async function readPublicLearningMaterial(urlValue) {
  const url = await validatePublicHttpsUrl(urlValue);
  const videoId = youtubeVideoId(url.href);
  if (videoId) {
    let metadata = {};
    try {
      const oembed = await fetchPublicText(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`,
        { maxBytes: 200_000 }
      );
      metadata = JSON.parse(oembed.text);
    } catch { }
    const transcript = await readYouTubeTranscript(videoId);
    const title = clean(metadata.title, 180) || `YouTube ${videoId}`;
    return {
      sourceType: 'youtube',
      title,
      url: url.href,
      author: clean(metadata.author_name, 180),
      excerpt: transcript.transcript || `YouTube-урок «${title}». Автоматические субтитры недоступны; JARVIS сохранил ссылку и метаданные, но не будет выдумывать содержание.`,
      transcriptAvailable: Boolean(transcript.transcript),
      language: transcript.language
    };
  }

  const page = await fetchPublicText(url.href);
  const title = htmlToText(page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url.hostname, 180);
  return {
    sourceType: 'web',
    title: title || url.hostname,
    url: page.url,
    author: '',
    excerpt: htmlToText(page.text, 12_000),
    transcriptAvailable: null,
    language: null
  };
}

export async function saveLearningMaterial(filePath, material) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let existing = [];
  try {
    existing = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing.some((item) => item.url === material.url)) return { saved: false, material: existing.find((item) => item.url === material.url) };
  const stored = {
    materialId: material.materialId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...material,
    savedAt: new Date().toISOString()
  };
  await fs.appendFile(filePath, `${JSON.stringify(stored)}\n`, 'utf8');
  return { saved: true, material: stored };
}

export async function researchPublicWeb(query, { limit = 3 } = {}) {
  const safeQuery = clean(query, 300);
  if (!safeQuery) return [];
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(safeQuery)}`;
  const search = await fetchPublicText(searchUrl);
  const candidates = extractSearchResults(search.text, Math.max(1, Math.min(limit, 4)));
  const sources = [];
  for (const candidate of candidates) {
    try {
      const page = await fetchPublicText(candidate.url);
      sources.push({ ...candidate, url: page.url, excerpt: htmlToText(page.text, 3_000) });
    } catch {
      sources.push({ ...candidate, excerpt: '' });
    }
  }
  return sources;
}
