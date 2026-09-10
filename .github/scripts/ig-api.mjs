// Instagram 콘텐츠 발행 API 얇은 래퍼.
// 공식 문서: https://developers.facebook.com/docs/instagram-platform/content-publishing/
//
// 확정 사실(문서 인용):
//  · 사진은 공개 URL(image_url) 로만 올린다. 로컬 파일 직접 업로드는 사진에서 지원되지 않는다.
//  · "JPEG is the only image format supported."
//  · 캐러셀: 자식 컨테이너(is_carousel_item=true) 를 만들고 부모(media_type=CAROUSEL, children=최대 10개)
//    를 만든 뒤 media_publish 한다.
//  · 컨테이너는 24시간 안에 게시하지 않으면 status_code=EXPIRED 가 된다.
//  · 게시 한도: 24시간 이동 기준 100건. "Carousels count as a single post."
const API_HOST = 'https://graph.instagram.com';
const VERSION = process.env.IG_API_VERSION || 'v26.0'; // 2026-07-29 릴리스가 최신(Graph API 변경 로그)

function url(pathname, params = {}) {
  const u = new URL(`${API_HOST}/${VERSION}/${pathname}`.replace(/([^:])\/{2,}/g, '$1/'));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u;
}

// Graph API 는 에러를 200 이 아닌 코드 + JSON 본문으로 준다. 메시지를 그대로 살려 던진다.
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

export const igGet = (pathname, params, token) => request('GET', pathname, params, token);
export const igPost = (pathname, params, token) => request('POST', pathname, params, token);

/** 캐러셀 자식 1장(사진). is_carousel_item=true 로 만들어야 children 에 넣을 수 있다. */
export async function createCarouselItem(igUserId, imageUrl, token) {
  const r = await igPost(`${igUserId}/media`, { image_url: imageUrl, is_carousel_item: 'true' }, token);
  return r.id;
}

/** 단일 사진 게시용 컨테이너(캐러셀이 아닐 때). 본문(caption)이 여기 붙는다. */
export async function createSingleImage(igUserId, imageUrl, caption, token) {
  const r = await igPost(`${igUserId}/media`, { image_url: imageUrl, caption }, token);
  return r.id;
}

/** 부모 캐러셀 컨테이너. children 은 자식 컨테이너 ID 를 콤마로 이은 목록(최대 10). */
export async function createCarousel(igUserId, childIds, caption, token) {
  const r = await igPost(
    `${igUserId}/media`,
    { media_type: 'CAROUSEL', children: childIds.join(','), caption },
    token,
  );
  return r.id;
}

/**
 * 컨테이너가 게시 가능해질 때까지 기다린다.
 * status_code: IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED
 * 사진은 보통 즉시 FINISHED 지만, 문서가 폴링을 권장하므로 확인하고 넘어간다.
 */
export async function waitReady(containerId, token, { tries = 20, delayMs = 3000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await igGet(containerId, { fields: 'status_code,status' }, token);
    last = r.status_code;
    if (last === 'FINISHED') return true;
    if (last === 'ERROR' || last === 'EXPIRED') {
      throw new Error(`컨테이너 ${containerId} 상태 ${last}: ${r.status ?? ''}`);
    }
    await new Promise((r2) => setTimeout(r2, delayMs));
  }
  throw new Error(`컨테이너 ${containerId} 가 준비되지 않았습니다(마지막 상태 ${last}).`);
}

/** 실제 게시. creation_id 는 (캐러셀이면 부모) 컨테이너 ID. */
export async function publish(igUserId, creationId, token) {
  const r = await igPost(`${igUserId}/media_publish`, { creation_id: creationId }, token);
  return r.id;
}

/** 게시물 주소. 실패해도 게시 자체는 성공이므로 호출 측에서 무시할 수 있게 null 을 돌려준다. */
export async function getPermalink(mediaId, token) {
  try {
    const r = await igGet(mediaId, { fields: 'permalink' }, token);
    return r.permalink ?? null;
  } catch {
    return null;
  }
}

/** 24시간 게시 한도 사용량. 한도 초과로 실패하기 전에 로그로 남겨두면 원인 파악이 쉽다. */
export async function getPublishingLimit(igUserId, token) {
  try {
    const r = await igGet(`${igUserId}/content_publishing_limit`, { fields: 'config,quota_usage' }, token);
    const d = (r.data || [])[0] || {};
    return { used: d.quota_usage ?? null, total: d.config?.quota_total ?? null };
  } catch {
    return { used: null, total: null };
  }
}

/**
 * 이미지 URL 이 실제로 공개돼 있고 JPEG 인지 확인한다.
 * Meta 서버가 가져가지 못하면 컨테이너 생성이 실패하므로, 그 전에 우리가 먼저 확인한다.
 */
export async function checkImageUrl(imageUrl) {
  const res = await fetch(imageUrl, { method: 'GET', headers: { range: 'bytes=0-1023' } });
  if (!res.ok) throw new Error(`이미지 URL 응답 HTTP ${res.status}: ${imageUrl}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('jpeg') && !ct.includes('jpg')) {
    throw new Error(`이미지가 JPEG 이 아닙니다 (content-type: ${ct || '없음'}): ${imageUrl}`);
  }
  return true;
}
