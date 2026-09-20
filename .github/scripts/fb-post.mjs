// 예약 시각이 된 게시물을 페이스북 페이지(청소만)에 올린다. 스레드 단계 다음으로 GitHub Actions 가 실행한다.
//
// 동작(인스타·스레드와 독립): 큐 처리 골격은 post-common.mjs. 여기엔 페이스북 고유 부분만 있다.
//   ig/queue.json 에서 item.facebook.enabled 이고 facebook.status='pending' 이며 scheduledAt 이 지난 항목만 올린다.
//   facebook 필드가 없는 항목(기존 게시물)은 "게시 안 함". 성공 → facebook.status='posted' + postId/permalink/postedAt.
//   인스타 status·스레드 threads 필드는 절대 건드리지 않는다.
//   게시 방법(문서): 사진마다 POST /{page}/photos published=false → POST /{page}/feed attached_media[...] (사진 1장이면 /photos 로 바로 게시)
//
// 환경변수: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN  (--fix-token 은 GH_TOKEN 도 필요)
// 옵션:  --dry-run / --check(페이지·토큰 확인, ig/facebook-check.json 기록) / --probe(사진 업로드까지, 게시 안 함 — 24시간 뒤 자동 삭제)
//        --test-post(큐 무접촉, 사진 1장 고정 본문 실제 게시 — 확인 후 삭제)
//        --diagnose  토큰 종류(GET /me)·페이지 작업 권한(GET /{page}?fields=tasks)·권한 목록(GET /me/permissions) 진단. 토큰 값은 출력 안 함
//        --fix-token 토큰이 '사용자 토큰'이면 GET /me/accounts 에서 FB_PAGE_ID 의 페이지 토큰을 받아 시크릿 FB_PAGE_ACCESS_TOKEN 을 되쓴다(gh, 값 미출력)
//
// 게시 실패 대비: /photos 가 "(#200) publish_actions … deprecated"(code 200) 로 막히면 /feed 에 link(첫 사진 URL)로 대체 게시하고
//  facebook.mode='link-fallback' 으로 기록한다(미리보기 카드 1장 — 여러 장 불가). 원인은 --diagnose 로 확인.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { checkImageUrl } from './ig-api.mjs'; // 공개·JPEG 확인은 인스타와 같은 검사(사본 만들지 않음)
import {
  createLinkPost,
  createMultiPhotoPost,
  createSinglePhotoPost,
  getAccounts,
  getMe,
  getPage,
  getPageTasks,
  getPermalink,
  getPermissions,
  uploadPhotoUnpublished,
} from './fb-api.mjs';
import { imageUrls, loadQueue, log, runCheck, runMain, runQueuePost, runTestPost, writeCheck } from './post-common.mjs';

const CHECK_PATH = path.resolve(process.env.FB_CHECK_FILE || 'ig/facebook-check.json');

const dryRun = process.argv.includes('--dry-run');
const checkOnly = process.argv.includes('--check');
const probe = process.argv.includes('--probe');
const testPost = process.argv.includes('--test-post');
const diagnose = process.argv.includes('--diagnose');
const fixToken = process.argv.includes('--fix-token');
const TEST_IMAGE_URL = process.env.FB_TEST_IMAGE_URL || 'https://cheongsoman.com/ig/2026-09-21-0700/01.jpg'; // 이미 공개된 사진
const TEST_TEXT = '청소만 페이스북 연동 테스트입니다. 곧 지웁니다.';

/** /photos 거부(code 200 publish_actions) 판정 — 이때만 /feed link 게시로 대체한다. */
const isPhotosBlocked = (e) => e && e.fbCode === 200 && /publish_actions/.test(String(e.message || ''));

/** 사진 업로드(게시 안 함)까지 — probe 용. 반환 = photo id 목록. */
async function uploadAll(item, pageId, token) {
  const urls = imageUrls(item);
  log(`  사진 ${urls.length}장 공개 여부 확인`);
  for (const u of urls) await checkImageUrl(u);
  const ids = [];
  for (let i = 0; i < urls.length; i++) {
    const id = await uploadPhotoUnpublished(pageId, urls[i], token);
    ids.push(id);
    log(`  사진 업로드 ${i + 1}/${urls.length} (${id})`);
  }
  return ids;
}

/** 사진 여러 장 → /photos 업로드 + /feed attached_media. /photos 가 막히면 link 게시로 대체(mode 로 구분). */
async function publishPhotos(pageId, urls, message, token) {
  try {
    if (urls.length >= 2) {
      const ids = [];
      for (let i = 0; i < urls.length; i++) {
        ids.push(await uploadPhotoUnpublished(pageId, urls[i], token));
        log(`  사진 업로드 ${i + 1}/${urls.length} (${ids[i]})`);
      }
      const id = await createMultiPhotoPost(pageId, ids, message, token);
      log(`  멀티포토 게시물 생성 (${id})`);
      return { id, mode: 'photos' };
    }
    const id = await createSinglePhotoPost(pageId, urls[0], message, token);
    log(`  단일 사진 게시물 생성 (${id})`);
    return { id, mode: 'photos' };
  } catch (e) {
    if (!isPhotosBlocked(e)) throw e;
    log(`  /photos 거부 → /feed link 게시로 대체합니다(사진 1장 미리보기 카드). 원인: ${e.message}`);
    const id = await createLinkPost(pageId, urls[0], message, token);
    log(`  링크 게시물 생성 (${id})`);
    return { id, mode: 'link-fallback' };
  }
}

/** --diagnose: 토큰 종류·페이지 권한·권한 목록. 토큰 값은 절대 출력하지 않는다. 결과는 ig/facebook-check.json */
async function runDiagnose(pageId, token) {
  const result = { checkedAt: new Date().toISOString(), mode: 'diagnose', me: null, tokenKind: null, pageTasks: null, permissions: null, accounts: null, verdict: [] };
  try {
    const me = await getMe(token);
    result.me = { id: me.id ?? null, name: me.name ?? null };
    result.tokenKind = String(me.id) === String(pageId) ? 'page' : 'user-or-other';
    log(`GET /me → id ${me.id} "${me.name}" → ${result.tokenKind === 'page' ? '페이지 토큰(정상)' : '⚠ 페이지 토큰이 아님(사용자 토큰으로 보임)'}`);
  } catch (e) {
    result.me = { error: String(e.message || e) };
    log(`GET /me 실패: ${e.message}`);
  }
  try {
    const p = await getPageTasks(pageId, token);
    result.pageTasks = { id: p.id ?? null, name: p.name ?? null, tasks: p.tasks ?? null };
    const can = Array.isArray(p.tasks) && p.tasks.includes('CREATE_CONTENT');
    log(`GET /${pageId}?fields=tasks → "${p.name}" tasks=${JSON.stringify(p.tasks ?? null)} → CREATE_CONTENT ${can ? '있음' : '없음/미표시'}`);
  } catch (e) {
    result.pageTasks = { error: String(e.message || e) };
    log(`GET /${pageId}?fields=tasks 실패: ${e.message}`);
  }
  try {
    const perms = await getPermissions(token);
    result.permissions = perms.map((x) => `${x.permission}:${x.status}`);
    log(`GET /me/permissions → ${result.permissions.join(', ') || '(없음)'}`);
  } catch (e) {
    result.permissions = { error: String(e.message || e) };
    log(`GET /me/permissions 실패: ${e.message}`);
  }
  if (result.tokenKind !== 'page') {
    try {
      const accounts = await getAccounts(token);
      result.accounts = accounts.map((a) => ({ id: a.id, name: a.name, tasks: a.tasks ?? null, hasPageToken: !!a.access_token }));
      log(`GET /me/accounts → ${result.accounts.map((a) => `${a.name}(${a.id}) ${a.hasPageToken ? '페이지 토큰 있음' : '토큰 없음'}`).join(' / ') || '(관리 페이지 없음)'}`);
      const target = accounts.find((a) => String(a.id) === String(pageId));
      if (target?.access_token) result.verdict.push('시크릿 FB_PAGE_ACCESS_TOKEN 이 사용자 토큰이다. --fix-token 으로 페이지 토큰으로 교체 가능.');
      else result.verdict.push(`이 사용자 토큰으로는 페이지 ${pageId} 의 토큰을 받을 수 없다(관리 권한/권한 범위 확인).`);
    } catch (e) {
      result.accounts = { error: String(e.message || e) };
      log(`GET /me/accounts 실패: ${e.message}`);
    }
  } else {
    result.verdict.push('페이지 토큰이다. /photos 거부가 계속되면 페이지 체계·앱 권한(pages_manage_posts 승인) 문제 — 오류 전문을 본다.');
  }
  for (const v of result.verdict) log(`판정: ${v}`);
  writeCheck(CHECK_PATH, result);
  return 0;
}

/** --fix-token: 사용자 토큰 → 페이지 토큰으로 시크릿 교체(gh secret set, 표준입력 — 값 미출력). */
async function runFixToken(pageId, token) {
  const me = await getMe(token);
  if (String(me.id) === String(pageId)) {
    log('이미 페이지 토큰입니다. 바꿀 것이 없습니다.');
    return 0;
  }
  const accounts = await getAccounts(token);
  const target = accounts.find((a) => String(a.id) === String(pageId));
  if (!target?.access_token) {
    console.error(`이 토큰으로 페이지 ${pageId} 의 토큰을 받을 수 없습니다. 관리 페이지: ${accounts.map((a) => `${a.name}(${a.id})`).join(', ') || '없음'}`);
    return 1;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GH_TOKEN) {
    console.error('GITHUB_REPOSITORY / GH_TOKEN(PAT) 이 없어 시크릿을 갱신할 수 없습니다.');
    return 1;
  }
  execFileSync('gh', ['secret', 'set', 'FB_PAGE_ACCESS_TOKEN', '--repo', repo, '--body-file', '-'], {
    input: target.access_token,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  log(`시크릿 FB_PAGE_ACCESS_TOKEN 을 페이지 "${target.name}" 토큰으로 교체했습니다. 다음 실행부터 적용됩니다.`);
  return 0;
}

async function main() {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const ready = () => {
    if (!pageId || !token) {
      console.error('FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN 이 없습니다. 저장소 Secrets 를 확인하세요.');
      return false;
    }
    return true;
  };

  if (diagnose) {
    if (!ready()) return 1;
    return runDiagnose(pageId, token);
  }
  if (fixToken) {
    if (!ready()) return 1;
    return runFixToken(pageId, token);
  }

  if (testPost) {
    if (!ready()) return 1;
    return runTestPost({
      label: '페이스북',
      checkPath: CHECK_PATH,
      imageUrl: TEST_IMAGE_URL,
      text: TEST_TEXT,
      testPost: async () => {
        await checkImageUrl(TEST_IMAGE_URL);
        const { id, mode } = await publishPhotos(pageId, [TEST_IMAGE_URL], TEST_TEXT, token);
        log(`테스트 게시물 생성 (${id}, ${mode})`);
        return { id, permalink: await getPermalink(id, token), mode };
      },
    });
  }

  if (checkOnly || probe) {
    if (!ready()) return 1;
    return runCheck({
      key: 'facebook',
      label: '페이스북',
      mode: probe ? 'probe' : 'check',
      checkPath: CHECK_PATH,
      q: loadQueue(),
      verifyToken: async () => {
        const page = await getPage(pageId, token);
        const matchesPageId = String(page.id) === String(pageId);
        log(`토큰 정상. 페이지 "${page.name ?? '-'}" (id ${page.id ?? '-'})${matchesPageId ? '' : ' ⚠ FB_PAGE_ID 와 다름'}`);
        return { id: page.id ?? null, name: page.name ?? null, matchesPageId };
      },
      checkImage: checkImageUrl,
      probeBuild: async (item) => ({ photoIds: await uploadAll(item, pageId, token) }),
      probeNote: '게시하지 않음 — 미게시 사진은 24시간 뒤 자동 삭제',
    });
  }

  return runQueuePost({
    key: 'facebook',
    label: '페이스북',
    idField: 'postId',
    dryRun,
    describe: (it) => `본문 ${Array.from(String(it.caption ?? '')).length}자: ${String(it.caption ?? '').split('\n')[0].slice(0, 60)}...`,
    ready,
    postItem: async (item) => {
      const urls = imageUrls(item);
      log(`  사진 ${urls.length}장 공개 여부 확인`);
      for (const u of urls) await checkImageUrl(u);
      const { id, mode } = await publishPhotos(pageId, urls, item.caption, token);
      item.facebook.mode = mode; // 'photos' | 'link-fallback' — 대체 게시 여부를 큐에 남긴다
      return { id, permalink: await getPermalink(id, token) };
    },
  });
}

runMain(main);
