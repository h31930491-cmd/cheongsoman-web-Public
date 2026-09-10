// 장기 액세스 토큰(60일) 자동 갱신. GitHub Actions 가 주 1회 실행한다.
//
// 왜 필요한가: Instagram 장기 토큰은 60일짜리다. 공식 문서상
//   · 갱신하려면 토큰이 "at least 24 hours old" 이고 아직 유효해야 하며,
//   · "Tokens that have not been used in 60 days will expire and can no longer be refreshed."
// 즉 한 번 만료되면 사장님이 처음부터 다시 발급받아야 한다. 주 1회 갱신으로 그 사고를 막는다.
//
// 환경변수:
//   IG_ACCESS_TOKEN  현재 장기 토큰
//   GH_TOKEN         저장소 Secrets 를 쓸 수 있는 PAT (gh CLI 가 사용)
//   GITHUB_REPOSITORY  owner/repo (Actions 가 자동으로 넣어준다)
// 옵션: --dry-run  갱신만 하고 시크릿은 건드리지 않음 / --check 토큰 유효기간만 조회
import { execFileSync } from 'node:child_process';

const SECRET_NAME = 'IG_ACCESS_TOKEN';
const dryRun = process.argv.includes('--dry-run');
const checkOnly = process.argv.includes('--check');

const token = process.env.IG_ACCESS_TOKEN;
if (!token) {
  console.error('IG_ACCESS_TOKEN 이 없습니다.');
  process.exit(1);
}

// 토큰 자체는 절대 로그에 남기지 않는다. 앞뒤 몇 글자만 찍어 어떤 토큰인지 구분만 한다.
const brief = (t) => `${t.slice(0, 6)}...${t.slice(-4)} (길이 ${t.length})`;

async function refresh() {
  const u = new URL('https://graph.instagram.com/refresh_access_token');
  u.searchParams.set('grant_type', 'ig_refresh_token');
  u.searchParams.set('access_token', token);
  const res = await fetch(u);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`토큰 갱신 실패 (HTTP ${res.status}) code=${e.code ?? '-'}: ${e.message ?? '응답 해석 실패'}`);
  }
  return json; // { access_token, token_type, expires_in }
}

async function main() {
  console.log(`현재 토큰: ${brief(token)}`);

  if (checkOnly) {
    // debug_token 은 Instagram Login 토큰에서 항상 열려 있지 않아, 유효성 확인은 가벼운 호출로 대신한다.
    const res = await fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${token}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) {
      console.error('토큰이 유효하지 않습니다:', j.error?.message ?? `HTTP ${res.status}`);
      return 1;
    }
    console.log(`토큰 정상. 계정: ${j.username ?? '-'} (id ${j.id ?? '-'})`);
    return 0;
  }

  const r = await refresh();
  const days = Math.round((r.expires_in ?? 0) / 86400);
  console.log(`갱신 성공. 새 토큰: ${brief(r.access_token)} / 유효기간 약 ${days}일`);

  if (dryRun) {
    console.log('모의 실행이라 시크릿은 바꾸지 않았습니다.');
    return 0;
  }

  if (r.access_token === token) {
    console.log('토큰 값이 그대로입니다. 시크릿 갱신을 건너뜁니다.');
    return 0;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY 가 없습니다.');
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN(PAT) 이 없습니다. 시크릿을 갱신할 수 없습니다.');

  // gh CLI 가 저장소 공개키로 암호화까지 처리한다(러너에 기본 설치돼 있다).
  // 토큰 값은 인자가 아니라 표준입력으로 넘겨 프로세스 목록에 남지 않게 한다.
  execFileSync('gh', ['secret', 'set', SECRET_NAME, '--repo', repo, '--body-file', '-'], {
    input: r.access_token,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log(`저장소 시크릿 ${SECRET_NAME} 갱신 완료 (${repo})`);
  return 0;
}

// ig-post.mjs 와 같은 이유로 process.exit() 대신 exitCode 만 정한다(윈도우 libuv 어서션 회피).
main()
  .then((c) => {
    process.exitCode = c;
  })
  .catch((e) => {
    console.error(String(e.message || e));
    process.exitCode = 1;
  });
