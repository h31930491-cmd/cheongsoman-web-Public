// 예약 시각이 된 게시물을 스레드(Threads)에 올린다. ig-post.mjs 다음 단계로 GitHub Actions 가 실행한다.
//
// 동작(인스타와 독립):
//   ig/queue.json 에서 item.threads.enabled 이고 threads.status='pending' 이며 scheduledAt 이 지난 항목만 올린다.
//   threads 필드가 없는 항목(기존 게시물)은 "스레드 게시 안 함"으로 건너뛴다.
//   성공 → threads.status='posted' + mediaId/permalink/postedAt. 실패 → threads.attempts+1, lastError, 3회면 'failed'.
//   인스타 쪽 status/mediaId 는 절대 건드리지 않는다(같은 파일의 다른 필드).
//
// 환경변수: THREADS_USER_ID, THREADS_ACCESS_TOKEN
// 옵션:  --dry-run   실제 호출 없이 무엇을 올릴지만 출력
//        --check     토큰 확인(GET /me)만 하고 끝. 결과를 ig/threads-check.json 에 기록
//        --probe     토큰 확인 + 다음 대기 항목의 사진으로 컨테이너 생성까지만(게시 안 함, 24시간 뒤 만료) + 결과 기록
import fs from 'node:fs';
import path from 'node:path';
import { checkImageUrl } from './ig-api.mjs'; // 공개·JPEG 확인은 인스타와 같은 검사(사본 만들지 않음)
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

const SITE_BASE = process.env.IG_SITE_BASE || 'https://cheongsoman.com';
const MAX_ATTEMPTS = 3;
const QUEUE_PATH = path.resolve(process.env.IG_QUEUE || 'ig/queue.json');
const CHECK_PATH = path.resolve(process.env.TH_CHECK_FILE || 'ig/threads-check.json');

const dryRun = process.argv.includes('--dry-run');
const checkOnly = process.argv.includes('--check');
const probe = process.argv.includes('--probe');

function log(...a) {
  console.log(...a);
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) {
    log(`큐 파일이 없습니다: ${QUEUE_PATH} — 할 일 없음`);
    return null;
  }
  const q = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  if (!Array.isArray(q.items)) q.items = [];
  return q;
}

function saveQueue(q) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2) + '\n', 'utf8');
}

/** 스레드 대상: threads.enabled 이고 pending 이며 예약 시각이 지난 항목. threads 없음 = 대상 아님. */
function dueItems(q, now) {
  return q.items.filter((it) => {
    const th = it.threads;
    if (!th || !th.enabled) return false;
    if (th.status !== 'pending') return false; // posted/failed 는 다시 건드리지 않는다
    const t = Date.parse(it.scheduledAt);
    if (Number.isNaN(t)) {
      log(`  [건너뜀] ${it.id}: scheduledAt 을 해석할 수 없습니다 (${it.scheduledAt})`);
      return false;
    }
    return t <= now;
  });
}

function imageUrls(item) {
  return item.images.map((p) => `${SITE_BASE}/${String(p).replace(/^\/+/, '')}`);
}

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

async function postItem(item, userId, token) {
  const creationId = await buildContainer(item, userId, token);
  const mediaId = await publish(userId, creationId, token);
  const permalink = await getPermalink(mediaId, token);
  return { mediaId, permalink };
}

function writeCheck(result) {
  fs.writeFileSync(CHECK_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
  log(`확인 결과 기록: ${CHECK_PATH}`);
}

/** --check / --probe: 토큰·계정 확인(+컨테이너 생성 시험). 큐는 바꾸지 않는다. */
async function runCheck(q, userId, token) {
  const result = { checkedAt: new Date().toISOString(), mode: probe ? 'probe' : 'check', token: null, image: null, container: null };
  try {
    const me = await getMe(token);
    result.token = { ok: true, id: me.id ?? null, username: me.username ?? null, matchesUserId: String(me.id) === String(userId) };
    log(`토큰 정상. 계정 @${me.username ?? '-'} (id ${me.id ?? '-'})${result.token.matchesUserId ? '' : ' ⚠ THREADS_USER_ID 와 다름'}`);
    const limit = await getPublishingLimit(userId, token);
    result.limit = limit;
    if (limit.used !== null) log(`24시간 게시 한도: ${limit.used} / ${limit.total ?? '?'}`);
  } catch (e) {
    result.token = { ok: false, error: String(e.message || e).slice(0, 500) };
    log(`토큰 확인 실패: ${result.token.error}`);
    writeCheck(result);
    return 1;
  }

  // 다음 스레드 대상(pending) 1건의 사진으로 공개 여부 + (probe 면) 컨테이너 생성까지
  const next = q ? q.items.find((it) => it.threads?.enabled && it.threads.status === 'pending') : null;
  if (next) {
    try {
      const urls = imageUrls(next);
      for (const u of urls) await checkImageUrl(u);
      result.image = { ok: true, item: next.id, count: urls.length };
      log(`사진 ${urls.length}장 공개 확인 (${next.id})`);
    } catch (e) {
      result.image = { ok: false, item: next.id, error: String(e.message || e).slice(0, 500) };
      log(`사진 확인 실패: ${result.image.error}`);
    }
    if (probe && result.image.ok) {
      try {
        const creationId = await buildContainer(next, userId, token);
        result.container = { ok: true, item: next.id, creationId, note: '게시하지 않음 — 24시간 뒤 자동 만료' };
        log(`컨테이너 생성 성공 (${creationId}) — 게시하지 않고 둡니다(24시간 뒤 만료)`);
      } catch (e) {
        result.container = { ok: false, item: next.id, error: String(e.message || e).slice(0, 500) };
        log(`컨테이너 생성 실패: ${result.container.error}`);
      }
    }
  } else {
    log('스레드 대기 항목이 없어 사진·컨테이너 확인은 건너뜁니다.');
  }
  writeCheck(result);
  return 0;
}

async function main() {
  const q = loadQueue();
  const userId = process.env.THREADS_USER_ID;
  const token = process.env.THREADS_ACCESS_TOKEN;

  if (checkOnly || probe) {
    if (!userId || !token) {
      console.error('THREADS_USER_ID / THREADS_ACCESS_TOKEN 이 없습니다. 저장소 Secrets 를 확인하세요.');
      return 1;
    }
    return runCheck(q, userId, token);
  }
  if (!q) return 0;

  const now = Date.now();
  const due = dueItems(q, now);
  const pending = q.items.filter((i) => i.threads?.enabled && i.threads.status === 'pending').length;
  log(`스레드 큐: 전체 ${q.items.length}건 / 대기 ${pending}건 / 지금 올릴 것 ${due.length}건`);

  if (due.length === 0) {
    log('스레드에 올릴 게시물이 없습니다.');
    return 0;
  }

  if (dryRun) {
    for (const it of due) {
      const fit = fitText(it.caption);
      log(`\n[모의·스레드] ${it.id} (사진 ${it.images.length}장) 예약 ${it.scheduledAt}`);
      it.images.forEach((p) => log(`   ${SITE_BASE}/${p}`));
      log(`   본문 ${fit.original}자${fit.trimmed ? ' → 500자로 잘림' : ''}: ${fit.text.split('\n')[0].slice(0, 60)}...`);
    }
    log('\n모의 실행이라 실제 게시는 하지 않았고 queue.json 도 그대로 둡니다.');
    return 0;
  }

  if (!userId || !token) {
    console.error('THREADS_USER_ID / THREADS_ACCESS_TOKEN 이 없습니다. 저장소 Secrets 를 확인하세요.');
    return 1;
  }

  const limit = await getPublishingLimit(userId, token);
  if (limit.used !== null) log(`스레드 24시간 게시 한도: ${limit.used} / ${limit.total ?? '?'}`);

  let failed = 0;
  let changed = false;

  for (const item of due) {
    const th = item.threads;
    log(`\n스레드 게시 시작: ${item.id} (예약 ${item.scheduledAt})`);
    try {
      const { mediaId, permalink } = await postItem(item, userId, token);
      th.status = 'posted';
      th.mediaId = mediaId;
      th.permalink = permalink;
      th.postedAt = new Date().toISOString();
      th.lastError = null;
      changed = true;
      log(`  ✔ 스레드 게시 완료 mediaId=${mediaId} ${permalink ?? ''}`);
    } catch (e) {
      th.attempts = (th.attempts || 0) + 1;
      th.lastError = String(e.message || e).slice(0, 500);
      if (th.attempts >= MAX_ATTEMPTS) {
        th.status = 'failed';
        log(`  ✖ ${th.attempts}회 실패 — threads.status=failed 로 확정합니다.`);
      } else {
        log(`  ✖ 실패 (${th.attempts}/${MAX_ATTEMPTS}) — 다음 실행에서 다시 시도합니다.`);
      }
      log(`    ${th.lastError}`);
      changed = true;
      failed++;
    }
  }

  if (changed) saveQueue(q);
  return failed > 0 ? 1 : 0;
}

// ig-post.mjs 와 같은 이유로 process.exit() 대신 exitCode 만 정한다(윈도우 libuv 어서션 회피).
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('예상치 못한 오류:', e);
    process.exitCode = 1;
  });
