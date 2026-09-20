// 큐 게시 공통부 — 스레드(th-post.mjs)·페이스북(fb-post.mjs)이 같이 쓴다. 인스타(ig-post.mjs)는 건드리지 않는다(기존 동작 보존).
//
// 골격: 큐 읽기 → 대상 선별(item[key].enabled && status==='pending' && scheduledAt 경과) → 플랫폼별 postItem →
//       item[key] 필드만 갱신(다른 플랫폼 필드 무접촉) → 큐 저장. 3회 실패면 'failed'.
// 플랫폼별로 다른 것(토큰 확인·컨테이너/업로드·게시·permalink·본문 한도)은 인자로 받는다.
import fs from 'node:fs';
import path from 'node:path';

export const SITE_BASE = process.env.IG_SITE_BASE || 'https://cheongsoman.com';
export const QUEUE_PATH = path.resolve(process.env.IG_QUEUE || 'ig/queue.json');
export const MAX_ATTEMPTS = 3;

export function log(...a) {
  console.log(...a);
}

export function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) {
    log(`큐 파일이 없습니다: ${QUEUE_PATH} — 할 일 없음`);
    return null;
  }
  const q = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  if (!Array.isArray(q.items)) q.items = [];
  return q;
}

export function saveQueue(q) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2) + '\n', 'utf8');
}

/** 플랫폼 대상: item[key].enabled 이고 pending 이며 예약 시각이 지난 항목. 필드 없음 = 대상 아님(옛 게시물). */
export function dueItems(q, now, key) {
  return q.items.filter((it) => {
    const p = it[key];
    if (!p || !p.enabled) return false;
    if (p.status !== 'pending') return false; // posted/failed 는 다시 건드리지 않는다
    const t = Date.parse(it.scheduledAt);
    if (Number.isNaN(t)) {
      log(`  [건너뜀] ${it.id}: scheduledAt 을 해석할 수 없습니다 (${it.scheduledAt})`);
      return false;
    }
    return t <= now;
  });
}

export function pendingCount(q, key) {
  return q.items.filter((i) => i[key]?.enabled && i[key].status === 'pending').length;
}

export function imageUrls(item) {
  return item.images.map((p) => `${SITE_BASE}/${String(p).replace(/^\/+/, '')}`);
}

/** 점검 결과 파일(ig/<platform>-check.json) 기록 — 워크플로 커밋 단계가 함께 올린다. */
export function writeCheck(checkPath, result) {
  fs.writeFileSync(checkPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  log(`확인 결과 기록: ${checkPath}`);
}

/**
 * 큐 게시 메인 루프(플랫폼 공통).
 *  key        큐 항목의 플랫폼 필드명('threads' | 'facebook')
 *  label      로그용 이름('스레드' | '페이스북')
 *  idField    성공 시 기록할 ID 필드명('mediaId' | 'postId')
 *  dryRun     실제 호출 없이 대상만 출력
 *  describe   (item) => 모의 실행 로그 한 줄(본문 한도 안내 등, 플랫폼별)
 *  ready      () => boolean  자격 증명 존재 여부(없으면 종료 1)
 *  beforeAll  async () => void  게시 전 1회(한도 조회 로그 등, 선택)
 *  postItem   async (item) => ({ id, permalink })
 */
export async function runQueuePost({ key, label, idField, dryRun, describe, ready, beforeAll, postItem }) {
  const q = loadQueue();
  if (!q) return 0;

  const now = Date.now();
  const due = dueItems(q, now, key);
  log(`${label} 큐: 전체 ${q.items.length}건 / 대기 ${pendingCount(q, key)}건 / 지금 올릴 것 ${due.length}건`);

  if (due.length === 0) {
    log(`${label}에 올릴 게시물이 없습니다.`);
    return 0;
  }

  if (dryRun) {
    for (const it of due) {
      log(`\n[모의·${label}] ${it.id} (사진 ${it.images.length}장) 예약 ${it.scheduledAt}`);
      it.images.forEach((p) => log(`   ${SITE_BASE}/${p}`));
      log(`   ${describe(it)}`);
    }
    log('\n모의 실행이라 실제 게시는 하지 않았고 queue.json 도 그대로 둡니다.');
    return 0;
  }

  if (!ready()) return 1;
  if (beforeAll) await beforeAll();

  let failed = 0;
  let changed = false;

  for (const item of due) {
    const p = item[key];
    log(`\n${label} 게시 시작: ${item.id} (예약 ${item.scheduledAt})`);
    try {
      const { id, permalink } = await postItem(item);
      p.status = 'posted';
      p[idField] = id;
      p.permalink = permalink;
      p.postedAt = new Date().toISOString();
      p.lastError = null;
      changed = true;
      log(`  ✔ ${label} 게시 완료 ${idField}=${id} ${permalink ?? ''}`);
    } catch (e) {
      p.attempts = (p.attempts || 0) + 1;
      p.lastError = String(e.message || e).slice(0, 500);
      if (p.attempts >= MAX_ATTEMPTS) {
        p.status = 'failed';
        log(`  ✖ ${p.attempts}회 실패 — ${key}.status=failed 로 확정합니다.`);
      } else {
        log(`  ✖ 실패 (${p.attempts}/${MAX_ATTEMPTS}) — 다음 실행에서 다시 시도합니다.`);
      }
      log(`    ${p.lastError}`);
      changed = true;
      failed++;
    }
  }

  if (changed) saveQueue(q);
  return failed > 0 ? 1 : 0;
}

/**
 * --check / --probe 공통: 토큰·계정 확인 → 다음 대기 항목 사진 공개 확인 → (probe) 업로드/컨테이너 생성까지(게시 안 함). 큐는 바꾸지 않는다.
 *  verifyToken  async () => ({ ...기록할 필드 })  실패 시 throw
 *  checkImage   async (url) => void
 *  probeBuild   async (item) => ({ ...기록할 필드 })  게시 직전 단계까지만
 *  probeNote    기록에 남길 안내('게시하지 않음 — 24시간 뒤 자동 만료' 등)
 */
export async function runCheck({ key, label, mode, checkPath, q, verifyToken, checkImage, probeBuild, probeNote }) {
  const result = { checkedAt: new Date().toISOString(), mode, token: null, image: null, container: null };
  try {
    const t = await verifyToken();
    result.token = { ok: true, ...t };
  } catch (e) {
    result.token = { ok: false, error: String(e.message || e).slice(0, 500) };
    log(`토큰 확인 실패: ${result.token.error}`);
    writeCheck(checkPath, result);
    return 1;
  }

  const next = q ? q.items.find((it) => it[key]?.enabled && it[key].status === 'pending') : null;
  if (next) {
    try {
      const urls = imageUrls(next);
      for (const u of urls) await checkImage(u);
      result.image = { ok: true, item: next.id, count: urls.length };
      log(`사진 ${urls.length}장 공개 확인 (${next.id})`);
    } catch (e) {
      result.image = { ok: false, item: next.id, error: String(e.message || e).slice(0, 500) };
      log(`사진 확인 실패: ${result.image.error}`);
    }
    if (mode === 'probe' && result.image.ok) {
      try {
        const built = await probeBuild(next);
        result.container = { ok: true, item: next.id, ...built, note: probeNote };
        log(`${label} 게시 직전 단계 성공 ${JSON.stringify(built)} — 게시하지 않고 둡니다(${probeNote})`);
      } catch (e) {
        result.container = { ok: false, item: next.id, error: String(e.message || e).slice(0, 500) };
        log(`${label} 게시 직전 단계 실패: ${result.container.error}`);
      }
    }
  } else {
    log(`${label} 대기 항목이 없어 사진·게시 직전 단계 확인은 건너뜁니다.`);
  }
  writeCheck(checkPath, result);
  return 0;
}

/** --test-post 공통: 큐 무접촉. 사진 1장 + 고정 본문으로 실제 게시. testPost async () => ({ id, permalink }) */
export async function runTestPost({ label, checkPath, imageUrl, text, testPost }) {
  const result = { checkedAt: new Date().toISOString(), mode: 'test-post', image: imageUrl, text, post: null };
  try {
    const { id, permalink } = await testPost();
    result.post = { ok: true, id, permalink, postedAt: new Date().toISOString() };
    log(`✔ ${label} 테스트 게시 완료 id=${id} permalink=${permalink ?? '(조회 실패)'}`);
    log('  확인 후 앱에서 직접 삭제하세요.');
  } catch (e) {
    result.post = { ok: false, error: String(e.message || e).slice(0, 500) };
    log(`✖ ${label} 테스트 게시 실패: ${result.post.error}`);
  }
  writeCheck(checkPath, result);
  return result.post.ok ? 0 : 1;
}

/** 공통 main 래퍼 — process.exit() 대신 exitCode 만 정한다(윈도우 libuv 어서션 회피, ig-post.mjs 와 같은 이유). */
export function runMain(main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error('예상치 못한 오류:', e);
      process.exitCode = 1;
    });
}
