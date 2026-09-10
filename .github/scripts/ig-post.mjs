// 예약 시각이 된 인스타 게시물을 실제로 올린다. GitHub Actions 가 5분마다 실행한다.
//
// 동작:
//   ig/queue.json 에서 status='pending' 이고 scheduledAt 이 지난 항목만 골라 게시한다.
//   게시에 성공하면 status='posted' + mediaId 를 기록한다. 이 기록이 중복 게시를 막는 근거다.
//   실패하면 attempts 를 올리고 lastError 를 남긴다. 3회 실패하면 status='failed' 로 못박아 더 시도하지 않는다.
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN
// 옵션:  --dry-run  실제 호출 없이 무엇을 올릴지만 출력(토큰 없이 확인용)
import fs from 'node:fs';
import path from 'node:path';
import {
  checkImageUrl,
  createCarousel,
  createCarouselItem,
  createSingleImage,
  getPermalink,
  getPublishingLimit,
  publish,
  waitReady,
} from './ig-api.mjs';

const SITE_BASE = process.env.IG_SITE_BASE || 'https://cheongsoman.com';
const MAX_ATTEMPTS = 3;
const QUEUE_PATH = path.resolve(process.env.IG_QUEUE || 'ig/queue.json');

const dryRun = process.argv.includes('--dry-run');

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

/** 예약 시각이 지난 pending 항목. scheduledAt 은 '+09:00' 오프셋을 달고 있어 Date 가 그대로 해석한다. */
function dueItems(q, now) {
  return q.items.filter((it) => {
    if (it.status !== 'pending') return false; // posted/failed 는 절대 다시 건드리지 않는다
    const t = Date.parse(it.scheduledAt);
    if (Number.isNaN(t)) {
      log(`  [건너뜀] ${it.id}: scheduledAt 을 해석할 수 없습니다 (${it.scheduledAt})`);
      return false;
    }
    return t <= now;
  });
}

async function postItem(item, igUserId, token) {
  const urls = item.images.map((p) => `${SITE_BASE}/${String(p).replace(/^\/+/, '')}`);

  log(`  사진 ${urls.length}장 공개 여부 확인`);
  for (const u of urls) await checkImageUrl(u);

  let creationId;
  if (item.mediaType === 'CAROUSEL' || urls.length >= 2) {
    const childIds = [];
    for (let i = 0; i < urls.length; i++) {
      const id = await createCarouselItem(igUserId, urls[i], token);
      await waitReady(id, token);
      childIds.push(id);
      log(`  자식 컨테이너 ${i + 1}/${urls.length} 준비됨 (${id})`);
    }
    creationId = await createCarousel(igUserId, childIds, item.caption, token);
    log(`  캐러셀 컨테이너 생성 (${creationId})`);
  } else {
    creationId = await createSingleImage(igUserId, urls[0], item.caption, token);
    log(`  단일 사진 컨테이너 생성 (${creationId})`);
  }

  await waitReady(creationId, token);
  const mediaId = await publish(igUserId, creationId, token);
  const permalink = await getPermalink(mediaId, token);
  return { mediaId, permalink };
}

async function main() {
  const q = loadQueue();
  if (!q) return 0;

  const now = Date.now();
  const due = dueItems(q, now);

  const pending = q.items.filter((i) => i.status === 'pending').length;
  log(`큐: 전체 ${q.items.length}건 / 대기 ${pending}건 / 지금 올릴 것 ${due.length}건`);

  if (due.length === 0) {
    log('올릴 게시물이 없습니다.');
    return 0;
  }

  if (dryRun) {
    for (const it of due) {
      log(`\n[모의] ${it.id} (${it.mediaType}, 사진 ${it.images.length}장) 예약 ${it.scheduledAt}`);
      it.images.forEach((p) => log(`   ${SITE_BASE}/${p}`));
      log(`   본문: ${String(it.caption).split('\n')[0].slice(0, 60)}...`);
    }
    log('\n모의 실행이라 실제 게시는 하지 않았고 queue.json 도 그대로 둡니다.');
    return 0;
  }

  const igUserId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!igUserId || !token) {
    console.error('IG_USER_ID / IG_ACCESS_TOKEN 이 없습니다. 저장소 Secrets 를 확인하세요.');
    return 1;
  }

  const limit = await getPublishingLimit(igUserId, token);
  if (limit.used !== null) log(`24시간 게시 한도: ${limit.used} / ${limit.total ?? '?'}`);

  let failed = 0;
  let changed = false;

  for (const item of due) {
    log(`\n게시 시작: ${item.id} (예약 ${item.scheduledAt})`);
    try {
      const { mediaId, permalink } = await postItem(item, igUserId, token);
      item.status = 'posted';
      item.mediaId = mediaId;
      item.permalink = permalink;
      item.postedAt = new Date().toISOString();
      item.lastError = null;
      changed = true;
      log(`  ✔ 게시 완료 mediaId=${mediaId} ${permalink ?? ''}`);
    } catch (e) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = String(e.message || e).slice(0, 500);
      if (item.attempts >= MAX_ATTEMPTS) {
        item.status = 'failed';
        log(`  ✖ ${item.attempts}회 실패 — status=failed 로 확정합니다.`);
      } else {
        log(`  ✖ 실패 (${item.attempts}/${MAX_ATTEMPTS}) — 다음 실행에서 다시 시도합니다.`);
      }
      log(`    ${item.lastError}`);
      changed = true;
      failed++;
    }
  }

  if (changed) saveQueue(q);
  return failed > 0 ? 1 : 0;
}

// process.exit() 를 바로 부르면 fetch 가 열어둔 소켓이 닫히기 전에 프로세스를 끊어
// 윈도우에서 libuv 어서션(UV_HANDLE_CLOSING)이 터지고 종료코드가 127 로 어긋난다.
// exitCode 만 정하고 이벤트 루프가 스스로 빠지게 둔다.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('예상치 못한 오류:', e);
    process.exitCode = 1;
  });
