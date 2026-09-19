// Threads 게시 API 얇은 래퍼 — ig-api.mjs 와 같은 구조(호스트·필드명만 다르다).
// 공식 문서(2026-09-19 대조): https://developers.facebook.com/docs/threads/posts
//
// 확정 사실(문서 인용):
//  · 컨테이너: POST /{threads-user-id}/threads  {media_type: IMAGE|VIDEO|TEXT|CAROUSEL, image_url, text, is_carousel_item, children}
//  · 게시:     POST /{threads-user-id}/threads_publish {creation_id}
//  · 상태:     GET /{container-id}?fields=status,error_message  → EXPIRED / ERROR / FINISHED / IN_PROGRESS / PUBLISHED
//              "recommended to wait on average 30 seconds before publishing", 상태 조회는 "once per minute, for no more than 5 minutes"
//  · 캐러셀:   "at least 2 and no more than 20" (인스타는 10 — 다르다)
//  · 본문:     "Text posts are limited to 500 characters" (인스타 2,200 — 다르다)
//  · 이미지:   "JPEG and PNG", 8MB, "must be on a public server"
//  · 한도:     "250 published posts within a 24-hour period"
//  · 토큰 갱신: GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=… (60일, 24시간 이상 된 토큰만)
const API_HOST = 'https://graph.threads.net';
const VERSION = process.env.TH_API_VERSION || 'v1.0';

export const TH_TEXT_LIMIT = 500;
export const TH_CAROUSEL_MAX = 20;

function url(pathname, params = {}) {
  const u = new URL(`${API_HOST}/${VERSION}/${pathname}`.replace(/([^:])\/{2,}/g, '$1/'));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u;
}

// 에러는 200 이 아닌 코드 + JSON 본문으로 온다. 메시지를 그대로 살려 던진다(ig-api.mjs 와 동일 규칙).
async function request(method, pathname, params, token) {
  const u = url(pathname, method === 'GET' ? { ...params, access_token: token } : {});
  const init = { method };
  if (method !== 'GET') {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) body.set(k, String(v));
    }
    body.set('access_token', token);
    init.body = body;
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  }
  const res = await fetch(u, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} 응답을 해석하지 못했습니다 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(
      `${method} ${pathname} 실패 (HTTP ${res.status}) code=${e.code ?? '-'} sub=${e.error_subcode ?? '-'}: ${e.message ?? text.slice(0, 300)}`,
    );
  }
  return json;
}

export const thGet = (pathname, params, token) => request('GET', pathname, params, token);
export const thPost = (pathname, params, token) => request('POST', pathname, params, token);

/** 토큰 확인 — GET /me (threads_basic). 계정 id·username 을 돌려준다. */
export async function getMe(token) {
  return thGet('me', { fields: 'id,username' }, token);
}

/** 캐러셀 자식 1장(사진). is_carousel_item=true. */
export async function createCarouselItem(userId, imageUrl, token) {
  const r = await thPost(`${userId}/threads`, { media_type: 'IMAGE', image_url: imageUrl, is_carousel_item: 'true' }, token);
  return r.id;
}

/** 단일 사진 컨테이너. 본문(text)이 여기 붙는다. */
export async function createSingleImage(userId, imageUrl, text, token) {
  const r = await thPost(`${userId}/threads`, { media_type: 'IMAGE', image_url: imageUrl, text }, token);
  return r.id;
}

/** 부모 캐러셀 컨테이너. children 은 자식 ID 를 콤마로 이은 목록(2~20). */
export async function createCarousel(userId, childIds, text, token) {
  const r = await thPost(`${userId}/threads`, { media_type: 'CAROUSEL', children: childIds.join(','), text }, token);
  return r.id;
}

/**
 * 컨테이너가 게시 가능해질 때까지 기다린다. 필드명이 인스타(status_code)와 달리 status 다.
 * 문서 권장(30초 대기·1분 간격 최대 5분)을 따르되, 사진은 보통 금방 FINISHED 라 3초 간격으로 먼저 본다.
 */
export async function waitReady(containerId, token, { tries = 40, delayMs = 3000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await thGet(containerId, { fields: 'status,error_message' }, token);
    last = r.status;
    if (last === 'FINISHED') return true;
    if (last === 'ERROR' || last === 'EXPIRED') {
      throw new Error(`컨테이너 ${containerId} 상태 ${last}: ${r.error_message ?? ''}`);
    }
    await new Promise((r2) => setTimeout(r2, delayMs));
  }
  throw new Error(`컨테이너 ${containerId} 가 준비되지 않았습니다(마지막 상태 ${last}).`);
}

/** 실제 게시. creation_id 는 (캐러셀이면 부모) 컨테이너 ID. */
export async function publish(userId, creationId, token) {
  const r = await thPost(`${userId}/threads_publish`, { creation_id: creationId }, token);
  return r.id;
}

/** 게시물 주소(fields=permalink). 실패해도 게시는 성공이므로 null. */
export async function getPermalink(mediaId, token) {
  try {
    const r = await thGet(mediaId, { fields: 'permalink' }, token);
    return r.permalink ?? null;
  } catch {
    return null;
  }
}

/** 24시간 게시 한도 사용량(threads_publishing_limit). 못 읽으면 null. */
export async function getPublishingLimit(userId, token) {
  try {
    const r = await thGet(`${userId}/threads_publishing_limit`, { fields: 'quota_usage,config' }, token);
    const d = (r.data || [])[0] || {};
    return { used: d.quota_usage ?? null, total: d.config?.quota_total ?? null };
  } catch {
    return { used: null, total: null };
  }
}

/** 본문을 500자 한도에 맞춘다. 잘랐으면 trimmed=true — 호출부가 로그로 남긴다. 글자 수는 코드포인트 기준. */
export function fitText(text) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= TH_TEXT_LIMIT) return { text: chars.join(''), trimmed: false, original: chars.length };
  return { text: chars.slice(0, TH_TEXT_LIMIT - 1).join('') + '…', trimmed: true, original: chars.length };
}
