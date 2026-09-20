// 페이스북 페이지 게시 API 얇은 래퍼 — ig-api.mjs/th-api.mjs 와 같은 구조(호스트·엔드포인트만 다르다).
// 공식 문서(2026-09-20 대조):
//   · graph-api/reference/page/photos — "Uploading an unpublished photo": POST /{page-id}/photos {url, published=false} → photo id
//       "Facebook stores it in a temporary upload state… about 24 hours. If you do not publish these photos within 24 hours, we delete them."
//     "Publishing a multi-photo post": POST /{page-id}/feed {message, attached_media[0]={"media_fbid":…}, attached_media[1]=…} → "returns the Page Post ID"
//   · graph-api/reference/photo — "a photo must be less than 10MB", url = "The URL of a photo that is already uploaded to the Internet"
//   · graph-api/reference/pagepost — permalink_url "The permanent static URL to the post", GET /{page-id}_{post-id}?fields=permalink_url
//   · pages-api/posts — 권한 pages_manage_posts · pages_read_engagement, 페이지 액세스 토큰(CREATE_CONTENT 권한자)
//   · 한 게시물 최대 사진 수·본문 글자 수 한도는 문서에 명시 없음(캐러셀 개념 없이 attached_media 나열).
//   · 페이지 토큰은 "do not have an expiration date"(facebook-login/guides/access-tokens/get-long-lived) — 갱신 없이 유효성 확인만.
const API_HOST = 'https://graph.facebook.com';
const VERSION = process.env.FB_API_VERSION || 'v26.0'; // ig-api.mjs 와 같은 세대(2026-07-29 릴리스)

function url(pathname, params = {}) {
  const u = new URL(`${API_HOST}/${VERSION}/${pathname}`.replace(/([^:])\/{2,}/g, '$1/'));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u;
}

// 에러는 200 이 아닌 코드 + JSON 본문으로 온다. 메시지를 그대로 살려 던진다.
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

export const fbGet = (pathname, params, token) => request('GET', pathname, params, token);
export const fbPost = (pathname, params, token) => request('POST', pathname, params, token);

/** 토큰·페이지 확인 — GET /{page-id}?fields=id,name (페이지 토큰이면 자기 페이지). */
export async function getPage(pageId, token) {
  return fbGet(pageId, { fields: 'id,name' }, token);
}

/** 사진 1장 업로드(게시 안 함) — 24시간 안에 feed 에 붙여야 한다. 반환 = photo id. */
export async function uploadPhotoUnpublished(pageId, imageUrl, token) {
  const r = await fbPost(`${pageId}/photos`, { url: imageUrl, published: 'false' }, token);
  return r.id;
}

/** 업로드한 사진들을 한 게시물로 묶어 게시(attached_media). 반환 = Page Post ID(page-id_post-id). */
export async function createMultiPhotoPost(pageId, photoIds, message, token) {
  const params = { message };
  photoIds.forEach((id, i) => {
    params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
  });
  const r = await fbPost(`${pageId}/feed`, params, token);
  return r.id;
}

/** 사진 1장 게시(단일 사진 게시물). 반환 = post_id(있으면) 또는 photo id. */
export async function createSinglePhotoPost(pageId, imageUrl, caption, token) {
  const r = await fbPost(`${pageId}/photos`, { url: imageUrl, caption, published: 'true' }, token);
  return r.post_id ?? r.id;
}

/** 게시물 주소(permalink_url). 실패해도 게시는 성공이므로 null. */
export async function getPermalink(postId, token) {
  try {
    const r = await fbGet(postId, { fields: 'permalink_url' }, token);
    return r.permalink_url ?? null;
  } catch {
    return null;
  }
}
