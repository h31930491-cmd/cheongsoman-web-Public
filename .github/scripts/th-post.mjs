// 예약 시각이 된 게시물을 스레드(Threads)에 올린다. ig-post.mjs 다음 단계로 GitHub Actions 가 실행한다.
//
// 동작(인스타와 독립): 큐 처리 골격은 post-common.mjs(스레드·페이스북 공용). 여기엔 스레드 고유 부분만 있다.
//   ig/queue.json 에서 item.threads.enabled 이고 threads.status='pending' 이며 scheduledAt 이 지난 항목만 올린다.
//   threads 필드가 없는 항목(기존 게시물)은 "스레드 게시 안 함"으로 건너뛴다.
//   성공 → threads.status='posted' + mediaId/permalink/postedAt. 실패 → threads.attempts+1, lastError, 3회면 'failed'.
//   인스타 쪽 status/mediaId 는 절대 건드리지 않는다(같은 파일의 다른 필드).
//
// 환경변수: THREADS_USER_ID, THREADS_ACCESS_TOKEN
// 옵션:  --dry-run   실제 호출 없이 무엇을 올릴지만 출력
//        --check     토큰 확인(GET /me)만 하고 끝. 결과를 ig/threads-check.json 에 기록
//        --probe     토큰 확인 + 다음 대기 항목의 사진으로 컨테이너 생성까지만(게시 안 함, 24시간 뒤 만료) + 결과 기록
//        --test-post 큐를 읽지도 쓰지도 않고 사진 1장(TEST_IMAGE_URL)을 고정 본문으로 실제 게시(연동 확인용, 게시 후 손으로 삭제). 결과 기록
import path from 'node:path';
import { checkImageUrl } from './ig-api.mjs'; // 공개·JPEG 확인은 인스타와 같은 검사(사본 만들지 않음)
import { imageUrls, loadQueue, log, runCheck, runMain, runQueuePost, runTestPost } from './post-common.mjs';
import {
  TH_CAROUSEL_MAX,
  createCarousel,
  createCarouselItem,
  createSingleImage,
  fitText,
  getMe,
  getPermalink,
  getPublishingLimit,
  publish,
  waitReady,
} from './th-api.mjs';

const CHECK_PATH = path.resolve(process.env.TH_CHECK_FILE || 'ig/threads-check.json');

const dryRun = process.argv.includes('--dry-run');
const checkOnly = process.argv.includes('--check');
const probe = process.argv.includes('--probe');
const testPost = process.argv.includes('--test-post');
const TEST_IMAGE_URL = process.env.TH_TEST_IMAGE_URL || 'https://cheongsoman.com/ig/2026-09-21-0700/01.jpg'; // 이미 공개된 사진
const TEST_TEXT = '청소만 스레드 연동 테스트입니다. 곧 지웁니다.';

/** 본문 + 사진으로 컨테이너까지 만든다(게시는 호출부). 캐러셀 20장 한도 초과분은 잘라내고 로그. */
async function buildContainer(item, userId, token) {
  let urls = imageUrls(item);
  if (urls.length > TH_CAROUSEL_MAX) {
    log(`  사진 ${urls.length}장 → 스레드 캐러셀 한도 ${TH_CAROUSEL_MAX}장으로 잘라냅니다`);
    urls = urls.slice(0, TH_CAROUSEL_MAX);
  }
  log(`  사진 ${urls.length}장 공개 여부 확인`);
  for (const u of urls) await checkImageUrl(u);

  const fit = fitText(item.caption);
  if (fit.trimmed) log(`  본문 ${fit.original}자 → 500자 한도로 잘랐습니다(끝에 … 표시)`);

  let creationId;
  if (urls.length >= 2) {
    const childIds = [];
    for (let i = 0; i < urls.length; i++) {
      const id = await createCarouselItem(userId, urls[i], token);
      await waitReady(id, token);
      childIds.push(id);
      log(`  자식 컨테이너 ${i + 1}/${urls.length} 준비됨 (${id})`);
    }
    creationId = await createCarousel(userId, childIds, fit.text, token);
    log(`  캐러셀 컨테이너 생성 (${creationId})`);
  } else {
    creationId = await createSingleImage(userId, urls[0], fit.text, token);
    log(`  단일 사진 컨테이너 생성 (${creationId})`);
  }
  await waitReady(creationId, token);
  return creationId;
}

async function main() {
  const userId = process.env.THREADS_USER_ID;
  const token = process.env.THREADS_ACCESS_TOKEN;
  const ready = () => {
    if (!userId || !token) {
      console.error('THREADS_USER_ID / THREADS_ACCESS_TOKEN 이 없습니다. 저장소 Secrets 를 확인하세요.');
      return false;
    }
    return true;
  };

  if (testPost) {
    if (!ready()) return 1;
    return runTestPost({
      label: '스레드',
      checkPath: CHECK_PATH,
      imageUrl: TEST_IMAGE_URL,
      text: TEST_TEXT,
      testPost: async () => {
        await checkImageUrl(TEST_IMAGE_URL);
        const creationId = await createSingleImage(userId, TEST_IMAGE_URL, TEST_TEXT, token);
        log(`테스트 컨테이너 생성 (${creationId})`);
        await waitReady(creationId, token);
        const id = await publish(userId, creationId, token);
        return { id, permalink: await getPermalink(id, token) };
      },
    });
  }

  if (checkOnly || probe) {
    if (!ready()) return 1;
    return runCheck({
      key: 'threads',
      label: '스레드',
      mode: probe ? 'probe' : 'check',
      checkPath: CHECK_PATH,
      q: loadQueue(),
      verifyToken: async () => {
        const me = await getMe(token);
        const matchesUserId = String(me.id) === String(userId);
        log(`토큰 정상. 계정 @${me.username ?? '-'} (id ${me.id ?? '-'})${matchesUserId ? '' : ' ⚠ THREADS_USER_ID 와 다름'}`);
        const limit = await getPublishingLimit(userId, token);
        if (limit.used !== null) log(`24시간 게시 한도: ${limit.used} / ${limit.total ?? '?'}`);
        return { id: me.id ?? null, username: me.username ?? null, matchesUserId, limit };
      },
      checkImage: checkImageUrl,
      probeBuild: async (item) => ({ creationId: await buildContainer(item, userId, token) }),
      probeNote: '게시하지 않음 — 24시간 뒤 자동 만료',
    });
  }

  return runQueuePost({
    key: 'threads',
    label: '스레드',
    idField: 'mediaId',
    dryRun,
    describe: (it) => {
      const fit = fitText(it.caption);
      return `본문 ${fit.original}자${fit.trimmed ? ' → 500자로 잘림' : ''}: ${fit.text.split('\n')[0].slice(0, 60)}...`;
    },
    ready,
    beforeAll: async () => {
      const limit = await getPublishingLimit(userId, token);
      if (limit.used !== null) log(`스레드 24시간 게시 한도: ${limit.used} / ${limit.total ?? '?'}`);
    },
    postItem: async (item) => {
      const creationId = await buildContainer(item, userId, token);
      const id = await publish(userId, creationId, token);
      return { id, permalink: await getPermalink(id, token) };
    },
  });
}

runMain(main);
