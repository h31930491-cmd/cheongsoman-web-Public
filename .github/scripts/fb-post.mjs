// 예약 시각이 된 게시물을 페이스북 페이지(청소만)에 올린다. 스레드 단계 다음으로 GitHub Actions 가 실행한다.
//
// 동작(인스타·스레드와 독립): 큐 처리 골격은 post-common.mjs. 여기엔 페이스북 고유 부분만 있다.
//   ig/queue.json 에서 item.facebook.enabled 이고 facebook.status='pending' 이며 scheduledAt 이 지난 항목만 올린다.
//   facebook 필드가 없는 항목(기존 게시물)은 "게시 안 함". 성공 → facebook.status='posted' + postId/permalink/postedAt.
//   인스타 status·스레드 threads 필드는 절대 건드리지 않는다.
//   게시 방법(문서): 사진마다 POST /{page}/photos published=false → POST /{page}/feed attached_media[...] (사진 1장이면 /photos 로 바로 게시)
//
// 환경변수: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
// 옵션:  --dry-run / --check(페이지·토큰 확인, ig/facebook-check.json 기록) / --probe(사진 업로드까지, 게시 안 함 — 24시간 뒤 자동 삭제)
//        --test-post(큐 무접촉, 사진 1장 고정 본문 실제 게시 — 확인 후 삭제)
import path from 'node:path';
import { checkImageUrl } from './ig-api.mjs'; // 공개·JPEG 확인은 인스타와 같은 검사(사본 만들지 않음)
import { createMultiPhotoPost, createSinglePhotoPost, getPage, getPermalink, uploadPhotoUnpublished } from './fb-api.mjs';
import { imageUrls, loadQueue, log, runCheck, runMain, runQueuePost, runTestPost } from './post-common.mjs';

const CHECK_PATH = path.resolve(process.env.FB_CHECK_FILE || 'ig/facebook-check.json');

const dryRun = process.argv.includes('--dry-run');
const checkOnly = process.argv.includes('--check');
const probe = process.argv.includes('--probe');
const testPost = process.argv.includes('--test-post');
const TEST_IMAGE_URL = process.env.FB_TEST_IMAGE_URL || 'https://cheongsoman.com/ig/2026-09-21-0700/01.jpg'; // 이미 공개된 사진
const TEST_TEXT = '청소만 페이스북 연동 테스트입니다. 곧 지웁니다.';

/** 사진 업로드(게시 안 함)까지 — 게시는 호출부. 반환 = photo id 목록. */
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

  if (testPost) {
    if (!ready()) return 1;
    return runTestPost({
      label: '페이스북',
      checkPath: CHECK_PATH,
      imageUrl: TEST_IMAGE_URL,
      text: TEST_TEXT,
      testPost: async () => {
        await checkImageUrl(TEST_IMAGE_URL);
        const id = await createSinglePhotoPost(pageId, TEST_IMAGE_URL, TEST_TEXT, token);
        log(`테스트 게시물 생성 (${id})`);
        return { id, permalink: await getPermalink(id, token) };
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
      let id;
      if (urls.length >= 2) {
        const ids = await uploadAll(item, pageId, token);
        id = await createMultiPhotoPost(pageId, ids, item.caption, token);
        log(`  멀티포토 게시물 생성 (${id})`);
      } else {
        await checkImageUrl(urls[0]);
        id = await createSinglePhotoPost(pageId, urls[0], item.caption, token);
        log(`  단일 사진 게시물 생성 (${id})`);
      }
      return { id, permalink: await getPermalink(id, token) };
    },
  });
}

runMain(main);
