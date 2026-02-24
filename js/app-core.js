// ----------------------------
// State
// ----------------------------
let nextPlayerId = 1;
let nextCourtId  = 2;
let nextGameId   = 1;

let courts = [1];
let players = [];
let games = [];
let scheduledGames = [];

const levelScoreMap = { "E":1,"D":2,"C":3,"B":4,"A":5,"S":6 };

// ✅ 하이브리드 핵심: "매칭 시작" 전역 시퀀스(코트 비동기 포함)
let startSeq = 0;
let lastStartIndexByPlayer = {};
let consecStartCountByPlayer = {};
let restBanUntilSeqByPlayer = {};

// ✅ 합류 직후 “융화 모드” (자동 완화/세이프티 강화)
const INTEGRATION_WINDOW_STARTS = 8; // 합류 후 startSeq 기준 8회 정도는 자연 융화용 완화
function hasRecentJoinerIntegrationActive(){
  const next = startSeq + 1;
  const act = players.filter(p=>!p.isLate);
  for(const p of act){
    if(p.lateJoiner && typeof p.joinedAtSeq === 'number'){
      if(next - p.joinedAtSeq <= INTEGRATION_WINDOW_STARTS){
        return true;
      }
    }
  }
  return false;
}

// ✅ 막힘 방지 세이프티 상태(3:1 단계 완화)
const matchState = {
  liveThreeOneAssistLevel: 0,   // 라이브에서만 증가/감소
};

// 매칭 옵션
const matchOptions = {
  preferF4: false,
  allowThreeOne: false,
  highTierEnabled: false,
  highTierRatio: 0.20,
  highTierMinLevelScore: 3, // C
  genderMode: 'auto',

  // ✅ 사용자 설정 허용: N 최소 4~최대 30 / W 최소 8~최대 40
  overlapWindowN: 14,
  ratioWindowW: 18,

  // ✅ 라이브 실패 기반 assist 상승
  liveFailToAssistThreshold: 2,
  liveAssistMax: 2
};

// ✅ “여성 휴식강제 예외” 최대 2명(요청사항)
const FEMALE_REST_EXCEPTION_MAX = 2;

// ✅ 라이브 연속 실패 카운터
let liveFailStreak = 0;

// ✅ 하이브리드 Phase 설정
const HYBRID_PHASES = [
  { id: 1, name: "P1", rest: { mode: "hard" },     overlap: { mode: "hard" },           ratioWeight: 1.0 },
  { id: 2, name: "P2", rest: { mode: "hard" },     overlap: { mode: "strongPenalty" },  ratioWeight: 1.0 },
  { id: 3, name: "P3", rest: { mode: "allowOne" }, overlap: { mode: "lightPenalty" },   ratioWeight: 0.25 },
  { id: 4, name: "P4", rest: { mode: "soft" },     overlap: { mode: "off" },            ratioWeight: 0.0 }
];

function nowTs(){ return Date.now(); }

function gameTypeLabel(t){
  if(t==='mixed') return '혼복';
  if(t==='md') return '남복';
  if(t==='wd') return '여복';
  if(t==='any31') return '3:1';
  return 'any';
}

function genderModeLabel(m){
  if(m==='equal') return '남녀균등(5:5)';
  if(m==='enough') return '여자 충분';
  if(m==='few') return '여자 소수';
  if(m==='very_few') return '여자 극소수';
  if(m==='auto') return '자동';
  return String(m);
}

function formatPct(x){
  const v = Math.round((x||0)*1000)/10;
  return `${v}%`;
}

function formatPlayer(p){
  if(!p) return '';
  const tags = [];
  tags.push(`<span class="miniTag">${p.gender}</span>`);
  tags.push(`<span class="miniTag">${p.level}</span>`);
  tags.push(`<span class="miniTag">G${p.gamesPlayed}</span>`);
  if(p.hasShuttlecock) tags.push(`<span class="miniTag">콕O</span>`);
  if(p.isLate) tags.push(`<span class="miniTag">늦참O</span>`);
  if(p.lateJoiner && !p.isLate) tags.push(`<span class="miniTag">합류</span>`);
  const next = startSeq + 1;
  const forced = !p.isLate && (restBanUntilSeqByPlayer[p.id] || 0) >= next;
  if(forced) tags.push(`<span class="miniTag">휴식</span>`);
  return `<div class="name"><strong>${p.name}</strong>${tags.join('')}</div>`;
}

function getPlayingPlayerSet(){
  const set = new Set();
  games.filter(g=>g.status==='playing').forEach(g=>{
    g.playerIds.forEach(id=>set.add(id));
  });
  return set;
}

function inferTypeFromGroup(group){
  if(group.length!==4) return 'any';
  const men = group.filter(p=>p.gender==='남').length;
  const women = 4 - men;
  if(men===4) return 'md';
  if(women===4) return 'wd';
  if(men===2 && women===2) return 'mixed';
  if((men===3 && women===1) || (men===1 && women===3)) return 'any31';
  return 'any';
}

function quartetKey(ids){
  return ids.slice().sort((a,b)=>a-b).join('-');
}

// ----------------------------
// ✅ 취소/삭제 등으로 꼬임 방지: startSeq/휴식상태 재구성
// ----------------------------
function rebuildStartSequenceFromGames(){
  startSeq = 0;
  lastStartIndexByPlayer = {};
  consecStartCountByPlayer = {};
  restBanUntilSeqByPlayer = {};

  const started = games.slice().sort((a,b)=>a.createdAt - b.createdAt);

  for(const g of started){
    if(g.status !== 'playing' && g.status !== 'finished') continue;
    startSeq++;
    for(const pid of g.playerIds){
      const last = lastStartIndexByPlayer[pid];
      if(typeof last === 'number' && last === startSeq - 1){
        consecStartCountByPlayer[pid] = (consecStartCountByPlayer[pid] || 1) + 1;
      }else{
        consecStartCountByPlayer[pid] = 1;
      }
      lastStartIndexByPlayer[pid] = startSeq;

      if(consecStartCountByPlayer[pid] >= 2){
        restBanUntilSeqByPlayer[pid] = Math.max(restBanUntilSeqByPlayer[pid] || 0, startSeq + 1);
      }
    }
  }
}

// ----------------------------
// Scheduled(자동생성 예정 경기)만 삭제
// ----------------------------
function clearScheduledGames(){
  if(!scheduledGames || scheduledGames.length === 0){
    alert('삭제할 배치(예정) 경기가 없습니다.');
    return;
  }
  if(!confirm('배치(자동생성)된 예정 경기를 모두 삭제하시겠습니까?\n(참여자/진행중/종료 게임은 삭제되지 않습니다.)')){
    return;
  }
  scheduledGames = [];
  render();
}

// ----------------------------
// RNG
// ----------------------------
let __rngState = 123456789;
function initRng(seed){
  __rngState = (seed >>> 0) || 123456789;
}
function rand01(){
  let x = __rngState >>> 0;
  x ^= (x << 13) >>> 0;
  x ^= (x >>> 17) >>> 0;
  x ^= (x << 5) >>> 0;
  __rngState = x >>> 0;
  return (__rngState >>> 0) / 4294967296;
}
function shuffleInPlace(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(rand01() * (i+1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}
function shuffleWithinSameGamesPlayed(sortedArr){
  let i = 0;
  while(i < sortedArr.length){
    let j = i+1;
    while(j < sortedArr.length && sortedArr[j].gamesPlayed === sortedArr[i].gamesPlayed) j++;
    const chunk = sortedArr.slice(i, j);
    if(chunk.length > 1){
      shuffleInPlace(chunk);
      for(let k=0;k<chunk.length;k++){
        sortedArr[i+k] = chunk[k];
      }
    }
    i = j;
  }
  return sortedArr;
}

// ----------------------------
// Utils: clamp / 추천값 계산
// ----------------------------
function clampInt(v, min, max, fallback){
  const n = parseInt(v, 10);
  if(Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function getActivePoolCount(){
  return players.filter(p=>!p.isLate).length;
}
function getCurrentTargetGamesGuess(){
  const sel = document.getElementById('batchCount');
  const v = sel ? parseInt(sel.value || '0', 10) : 0;
  return (v && v > 0) ? v : 28;
}

/**
 * ✅ 추천값: “기본은 추천값 적용이 표준”
 * - 인원 적거나 여자 풀 얇으면 N을 낮춰 막힘 방지(8~12)
 * - 인원 충분하면 12~16
 */
function computeRecommendedNW(){
  const active = getActivePoolCount();
  const targetGames = getCurrentTargetGamesGuess();

  const pool = players.filter(p=>!p.isLate);
  const total = pool.length || 1;
  const f = pool.filter(p=>p.gender==='여').length;
  const fr = f / total;

  // ✅ 여자 비율이 낮을수록 N을 낮춰 조합 잠김을 방지
  const baseN =
    (active <= 12) ? 8 :
    (active <= 16) ? 10 :
    12;

  const femaleAdj =
    (fr < 0.28) ? -2 :
    (fr < 0.35) ? -1 :
    0;

  const recN = Math.max(4, Math.min(16, baseN + femaleAdj));

  // W는 25~30게임 운영 기준 16~22
  const recW = Math.max(16, Math.min(22, Math.round(targetGames * 0.65) || 18));

  return { recN, recW, active, targetGames };
}
function applyRecommendedNW(){
  const { recN, recW } = computeRecommendedNW();
  const nEl = document.getElementById('optOverlapN');
  const wEl = document.getElementById('optRatioW');
  if(nEl) nEl.value = String(recN);
  if(wEl) wEl.value = String(recW);
  renderGenderInfoInModal();
}

// ----------------------------
// Team split (레벨 밸런스 중심)
// ----------------------------
function bestTeamSplit(group, type){
  const [a,b,c,d] = group;
  const candidates = [
    [[a,b],[c,d]],
    [[a,c],[b,d]],
    [[a,d],[b,c]],
  ];

  function isValidTeam(team, type){
    if(type==='md') return team.every(p=>p.gender==='남');
    if(type==='wd') return team.every(p=>p.gender==='여');
    if(type==='mixed'){
      const men = team.filter(p=>p.gender==='남').length;
      const women = team.filter(p=>p.gender==='여').length;
      return men===1 && women===1;
    }
    // any / 3:1(any31) 은 팀 성별 제한 없음(레벨 밸런스만)
    return true;
  }

  function sumLv(team){
    return (team[0]?.levelScore ?? 0) + (team[1]?.levelScore ?? 0);
  }

  let best = null;
  for(const [t1,t2] of candidates){
    if(!isValidTeam(t1,type)) continue;
    if(!isValidTeam(t2,type)) continue;

    const diff = Math.abs(sumLv(t1) - sumLv(t2));
    const key = (() => {
      const ids1 = t1.map(p=>p.id).slice().sort((x,y)=>x-y).join(',');
      const ids2 = t2.map(p=>p.id).slice().sort((x,y)=>x-y).join(',');
      return ids1 < ids2 ? ids1 + '|' + ids2 : ids2 + '|' + ids1;
    })();

    if(!best || diff < best.diff || (diff === best.diff && key < best.key)){
      best = {teams:[t1,t2], diff, key};
    }
  }
  return best ? {teams: best.teams} : null;
}

// ----------------------------
// ✅ 성비 모드
// ----------------------------
function getActivePoolForGenderMode(ctx){
  if(ctx && Array.isArray(ctx.activePool) && ctx.activePool.length){
    return ctx.activePool.slice();
  }
  return players.filter(p=>!p.isLate);
}
function computeAutoGenderModeFromPool(pool){
  const total = pool.length;
  if(total <= 0) return 'few';

  const f = pool.filter(p=>p.gender==='여').length;
  const m = total - f;
  const r = f / total;

  if(m === f) return 'equal';

  if(r < 0.28) return 'very_few';
  if(r < 0.43) return 'few';
  if(r < 0.48) return 'enough';
  return 'equal';
}
function resolveGenderMode(ctx){
  if(matchOptions.genderMode && matchOptions.genderMode !== 'auto'){
    return matchOptions.genderMode;
  }
  const pool = getActivePoolForGenderMode(ctx);
  return computeAutoGenderModeFromPool(pool);
}
function getTypeTargetsByMode(mode){
  if(mode === 'equal'){
    return { wd:0.40, md:0.40, mixed:0.20 };
  }

  const pool = players.filter(p=>!p.isLate);
  const total = pool.length || 1;
  const f = pool.filter(p=>p.gender==='여').length;
  const r = f / total;

  const baseMixed =
    (mode === 'enough') ? 0.30 :
    (mode === 'few') ? 0.28 :
    0.18;

  let mixed = Math.min(baseMixed, 2 * r);

  let wd = r - mixed / 2;
  if(wd < 0) wd = 0;

  let md = 1 - wd - mixed;
  if(md < 0) md = 0;

  const sum = wd + md + mixed;
  if(sum > 0){
    wd /= sum; md /= sum;
    const mixed2 = 1 - wd - md;
    return { wd, md, mixed: mixed2 };
  }

  return { wd:0.0, md:1.0, mixed:0.0 };
}
function buildTargetRatioText(mode){
  const t = getTypeTargetsByMode(mode);
  const wd = Math.round(t.wd * 100);
  const md = Math.round(t.md * 100);
  const mx = Math.round(t.mixed * 100);
  return `여복 ${wd}% / 남복 ${md}% / 혼복 ${mx}%`;
}

// ✅ 3:1 권장 판단(표시용)
function computeThreeOneRecommendation(){
  const pool = players.filter(p=>!p.isLate);
  const total = pool.length;
  if(total<=0) return { rec:false, level:'-' };
  const f = pool.filter(p=>p.gender==='여').length;
  const r = f/total;

  if(r < 0.28) return { rec:true, level:'강' };
  if(r < 0.35) return { rec:true, level:'중' };
  if(r < 0.43) return { rec:true, level:'약' };
  return { rec:false, level:'OFF 권장' };
}

// ----------------------------
// ✅ 비율 추적(최근 W경기)
// ----------------------------
function getTypeCountsForContext(ctx, windowN){
  let md=0, wd=0, mixed=0;
  const N = Math.max(1, windowN || matchOptions.ratioWindowW || 18);

  if(ctx?.mode === 'batch'){
    const arr = (ctx.scheduledSoFar || []).slice(-N);
    for(const g of arr){
      if(g.type==='md') md++;
      else if(g.type==='wd') wd++;
      else if(g.type==='mixed') mixed++;
    }
  }else{
    const arr = games.filter(g=>g.status==='finished').slice(-N);
    for(const g of arr){
      if(g.type==='md') md++;
      else if(g.type==='wd') wd++;
      else if(g.type==='mixed') mixed++;
    }
  }
  return {md, wd, mixed};
}
function getTypeCountByKey(counts, type){
  if(type==='md') return counts.md;
  if(type==='wd') return counts.wd;
  if(type==='mixed') return counts.mixed;
  return 0;
}
function targetRatioPenalty(type, ctx){
  const mode = resolveGenderMode(ctx);
  const targets = getTypeTargetsByMode(mode);

  const windowN = ctx?.targetWindowN || matchOptions.ratioWindowW || 18;
  const counts = getTypeCountsForContext(ctx, windowN);

  const total = counts.md + counts.wd + counts.mixed;
  const nextTotal = total + 1;

  const t = targets[type] ?? 0;
  const desired = nextTotal * t;
  const actual = getTypeCountByKey(counts, type);
  const diff = (actual - desired);

  const base = (mode === 'equal') ? 60 : 28;

  if(diff > 0) return diff * base;
  return diff * (base * 0.75);
}
function typeSoftBiasPenalty(type, ctx){
  let p = 0;
  const w = (typeof ctx?.ratioWeight === 'number') ? ctx.ratioWeight : 1.0;

  if(w > 0){
    p += targetRatioPenalty(type, ctx) * w;

    const mode = resolveGenderMode(ctx);
    const windowN = ctx?.targetWindowN || matchOptions.ratioWindowW || 18;
    const {md, wd, mixed} = getTypeCountsForContext(ctx, windowN);
    const mdOver = Math.max(0, md - wd);

    if(type === 'md'){
      if(mode === 'equal') p += mdOver * 6 * w;
      else if(mode === 'enough') p += mdOver * 4 * w;
      else if(mode === 'few') p += mdOver * 2 * w;
      else p += mdOver * 1 * w;
    }

    if(type === 'wd' && mode === 'very_few'){
      p += 15 * w;
    }

    if(type === 'mixed' && mode === 'very_few'){
      if(mixed >= md) p += 8 * w;
    }
  }

  return p;
}

// ----------------------------
// ✅ 3인중복(최근 N경기)  — “정확히 사용자가 설정한 N” 반영
// ----------------------------
function getRecentGamesForOverlap(ctx, windowN){
  const N = Math.max(1, windowN || matchOptions.overlapWindowN || 14);
  if(ctx?.mode === 'batch'){
    return (ctx.scheduledSoFar || []).slice(-N).map(g => g.playerIds.slice());
  }else{
    return games.filter(g=>g.status==='finished').slice(-N).map(g => g.playerIds.slice());
  }
}
function countOverlap(aIds, bIds){
  const setB = new Set(bIds);
  let c = 0;
  for(const x of aIds){
    if(setB.has(x)) c++;
  }
  return c;
}

// ----------------------------
// ✅ 늦참 해제(합류) 인원 처리
// ----------------------------
function getCoreActivePool(pool){
  const core = pool.filter(p => !p.isLate && !p.lateJoiner);
  if(core.length >= 4) return core;
  return pool.filter(p => !p.isLate);
}
function getBaselineMinCore(pool){
  const core = getCoreActivePool(pool);
  if(core.length === 0) return 0;
  return Math.min(...core.map(p=>p.gamesPlayed));
}
function violatesHardMaxMinusMin(group, baselineMinCore){
  for(const p of group){
    if(p.lateJoiner) continue;
    const after = p.gamesPlayed + 1;
    if(after > baselineMinCore + 2) return true;
  }
  return false;
}
function violatesStrongRecommend(group, baselineMinCore){
  for(const p of group){
    if(p.lateJoiner) continue;
    const after = p.gamesPlayed + 1;
    if(after > baselineMinCore + 1) return true;
  }
  return false;
}

// ----------------------------
// ✅ 휴식강제 대상 계산
// ----------------------------
function computeRestForcedSetForNextStart(activePool){
  const next = startSeq + 1;
  const set = new Set();
  for(const p of activePool){
    const ban = restBanUntilSeqByPlayer[p.id] || 0;
    if(ban >= next){
      set.add(p.id);
    }
  }
  return set;
}

// ----------------------------
// ✅ (강화) 3:1 “예방 트리거” — 더 공격적으로
// ----------------------------
function shouldPreAssistThreeOne(availPool, restForcedSet){
  if(!matchOptions.allowThreeOne) return false;
  if(!availPool || availPool.length < 4) return false;

  const usable = availPool.filter(p => !restForcedSet.has(p.id));
  const base = (usable.length >= 4) ? usable : availPool;

  const w = base.filter(p=>p.gender==='여').length;
  const m = base.length - w;
  const total = base.length || 1;
  const fr = w / total;

  // ✅ 합류(융화) 모드면 preAssist를 더 쉽게 킴
  const integrating = hasRecentJoinerIntegrationActive();

  // (1) 극단 상황: 기존과 동일
  if(w <= 1) return true;
  if(m <= 1) return true;

  // (2) 공격적 강화: 여자풀이 얇은데 hard 휴식까지 겹치면 막히기 직전
  if(fr < 0.40 && w <= 2) return true;
  if(fr < 0.35 && w <= 3) return true;

  // (3) 융화 모드: 합류 직후에는 더 빠르게 ON해서 자연스럽게 섞이게 함
  if(integrating){
    if(fr < 0.45 && w <= 3) return true;
    if(w <= 4 && fr < 0.40) return true;
  }

  return false;
}

// ----------------------------
// ✅ 3:1 페널티(Assist 단계 반영)
// ----------------------------
function threeOnePenalty(ctx){
  const assist = ctx?.threeOneAssistLevel || 0;
  const phaseId = ctx?.phaseId || 1;

  const integrating = !!ctx?.integrating;

  // 합류 직후에는 3:1을 좀 더 “부드럽게” 허용(막힘 감소 + 자연 융화)
  const relax = integrating ? 0.75 : 1.0;

  const baseByAssist = (assist === 0) ? 900 : (assist === 1) ? 260 : 60;
  const phaseExtra = (phaseId === 1) ? 120 : (phaseId === 2) ? 60 : (phaseId === 3) ? 20 : 0;

  return (baseByAssist + phaseExtra) * relax;
}

// ----------------------------
// ✅ lateJoiner 내부 “회전” 보정
// ----------------------------
function lateJoinerFairPenalty(group, activePool){
  const joiners = activePool.filter(p => p.lateJoiner && !p.isLate);
  if(joiners.length < 2) return 0;

  const minJ = Math.min(...joiners.map(p=>p.gamesPlayed));
  let pen = 0;
  for(const p of group){
    if(!p.lateJoiner) continue;
    const over = p.gamesPlayed - minJ;
    if(over >= 2) pen += (over - 1) * 18;
  }

  const jWomen = joiners.filter(p=>p.gender==='여');
  if(jWomen.length >= 2){
    const minW = Math.min(...jWomen.map(p=>p.gamesPlayed));
    for(const p of group){
      if(p.lateJoiner && p.gender==='여'){
        const overW = p.gamesPlayed - minW;
        if(overW >= 2) pen += (overW - 1) * 20;
      }
    }
  }

  return pen;
}

// ----------------------------
// Scoring / picking
// ----------------------------
function scoreQuartet(group, type, baselineMinCore, ctx){
  const ids = group.map(p=>p.id);
  let penalty = 0;

  const men = group.filter(p=>p.gender==='남').length;
  const women = 4 - men;

  const is31 = ((men===3 && women===1) || (men===1 && women===3));
  if(is31){
    if(!matchOptions.allowThreeOne) return 1e9;
    penalty += threeOnePenalty(ctx);
  }

  if(type === 'md' && men !== 4) return 1e9;
  if(type === 'wd' && women !== 4) return 1e9;
  if(type === 'mixed' && !(men===2 && women===2)) return 1e9;
  if(type === 'any31'){
    if(!is31) return 1e9;
  }

  const split = bestTeamSplit(group, (type==='any31' ? 'any' : type));
  if(!split) return 1e9;

  const restForcedSet = ctx?.restForcedSet || new Set();

  // ✅ 휴식강제 예외(여성 최대 2명)
  const violators = ids.filter(pid => restForcedSet.has(pid));
  const violatorPlayers = violators.map(pid => group.find(p=>p.id===pid)).filter(Boolean);
  const violatorMen = violatorPlayers.filter(p=>p.gender==='남').length;
  const violatorWomen = violatorPlayers.filter(p=>p.gender==='여').length;

  if(ctx?.restMode === 'hard'){
    // 남성 휴식 대상은 hard에서 절대 포함 불가
    if(violatorMen > 0) return 1e9;

    // 여성 휴식 대상은 최대 2명까지 예외 허용 + 패널티
    if(violatorWomen > FEMALE_REST_EXCEPTION_MAX) return 1e9;
    if(violatorWomen > 0){
      // 예외 1명/2명 패널티(너무 쉽게 남발되지 않도록)
      penalty += (violatorWomen === 1) ? 160 : 320;
    }
  }else if(ctx?.restMode === 'allowOne'){
    if(violators.length > 1) return 1e9;
    if(violators.length === 1) penalty += 180;
  }else if(ctx?.restMode === 'soft'){
    penalty += violators.length * 90;
  }

  // ✅ 합류 직후(융화 모드)에는 overlap 강도를 한 단계 낮춰 잠김 방지
  let overlapMode = ctx?.overlapMode || 'strongPenalty';
  if(ctx?.integrating){
    if(overlapMode === 'hard') overlapMode = 'strongPenalty';
    else if(overlapMode === 'strongPenalty') overlapMode = 'lightPenalty';
  }

  if(overlapMode !== 'off'){
    const overlapN = ctx?.overlapWindowN || matchOptions.overlapWindowN || 14;
    const recent = getRecentGamesForOverlap(ctx, overlapN);

    for(const past of recent){
      const ov = countOverlap(ids, past);
      if(ov >= 3){
        if(overlapMode === 'hard') return 1e9;
        if(overlapMode === 'strongPenalty') penalty += 350;
        if(overlapMode === 'lightPenalty') penalty += 130;
      }
    }
  }

  if(Array.isArray(ctx?.lastFinishedIds) && ctx.lastFinishedIds.length===4){
    const lastKey = quartetKey(ctx.lastFinishedIds);
    const nowKey  = quartetKey(ids);
    if(lastKey === nowKey) penalty += 120;
  }

  for(const p of group){
    if(p.lateJoiner) continue;

    const diff = p.gamesPlayed - baselineMinCore;
    if(diff <= 0) penalty += 0;
    else if(diff === 1) penalty += 4;
    else if(diff === 2) penalty += 35;
    else penalty += 220;
  }

  penalty += lateJoinerFairPenalty(group, ctx?.activePool || []);

  if(matchOptions.preferF4){
    if(women===4) penalty -= 12;
  }

  // ✅ 비율추적은 md/wd/mixed에만 적용(3:1/any는 중립)
  if(type==='md' || type==='wd' || type==='mixed'){
    penalty += typeSoftBiasPenalty(type, ctx);
  }

  return penalty;
}

function pickBestQuartet(cand, type, usedQuartetKeys, baselineMinCore, ctx){
  const list = cand;
  if(list.length < 4) return null;

  const phaseCaps = [1, 2];
  const EPS = 1e-9;

  for(const cap of phaseCaps){
    const sorted = list.slice().sort((a,b)=>{
      if(a.gamesPlayed!==b.gamesPlayed) return a.gamesPlayed-b.gamesPlayed;
      return a.name.localeCompare(b.name,'ko');
    });
    shuffleWithinSameGamesPlayed(sorted);

    const capN = Math.min(sorted.length, 16);
    const sub = sorted.slice(0, capN);

    let best = null;

    for(let i=0;i<sub.length-3;i++){
      for(let j=i+1;j<sub.length-2;j++){
        for(let k=j+1;k<sub.length-1;k++){
          for(let l=k+1;l<sub.length;l++){
            const group = [sub[i],sub[j],sub[k],sub[l]];
            const ids = group.map(p=>p.id);
            const qk = quartetKey(ids);
            if(usedQuartetKeys.has(qk)) continue;

            if(violatesHardMaxMinusMin(group, baselineMinCore)) continue;
            if(cap === 1 && violatesStrongRecommend(group, baselineMinCore)) continue;

            const s = scoreQuartet(group, type, baselineMinCore, ctx);
            if(s >= 1e9) continue;

            if(!best || s < best.score - EPS){
              best = {group, score:s, key:qk, finalType:type};
            } else if(best && Math.abs(s - best.score) <= EPS){
              if(rand01() < 0.5){
                best = {group, score:s, key:qk, finalType:type};
              }
            }
          }
        }
      }
    }

    if(best) return best;
  }

  return null;
}

function pickForAnySmart(candidates, usedKeys, baselineMinCore, ctx){
  let tries = ['mixed','md','wd'];

  // assist>=1일 때만 3:1 후보 포함
  if(matchOptions.allowThreeOne && (ctx?.threeOneAssistLevel || 0) >= 1){
    tries.push('any31');
  }

  shuffleInPlace(tries);

  const results = [];
  for(const t of tries){
    const r = pickBestQuartet(candidates, t, usedKeys, baselineMinCore, ctx);
    if(r) results.push(r);
  }
  if(results.length>0){
    results.sort((a,b)=>a.score-b.score);
    const bestScore = results[0].score;
    const tied = results.filter(x=>Math.abs(x.score-bestScore)<=1e-9);
    if(tied.length>1){
      return tied[Math.floor(rand01()*tied.length)];
    }
    return results[0];
  }
  return null;
}

// ----------------------------
// High tier pool
// ----------------------------
function buildHighTierPool(basePool, gender){
  const cand = basePool
    .filter(p=>p.gender===gender && p.levelScore >= matchOptions.highTierMinLevelScore)
    .slice();

  cand.sort((a,b)=>{
    if(b.levelScore !== a.levelScore) return b.levelScore - a.levelScore;
    if(a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    return a.name.localeCompare(b.name,'ko');
  });
  return cand;
}

// ----------------------------
// ✅ start(게임 시작) 시 휴식 강제 상태 갱신
// ----------------------------
function onGameStartedUpdateRestState(playerIds){
  startSeq++;
  for(const pid of playerIds){
    const last = lastStartIndexByPlayer[pid];
    if(typeof last === 'number' && last === startSeq - 1){
      consecStartCountByPlayer[pid] = (consecStartCountByPlayer[pid] || 1) + 1;
    }else{
      consecStartCountByPlayer[pid] = 1;
    }
    lastStartIndexByPlayer[pid] = startSeq;

    if(consecStartCountByPlayer[pid] >= 2){
      restBanUntilSeqByPlayer[pid] = Math.max(restBanUntilSeqByPlayer[pid] || 0, startSeq + 1);
    }
  }
}

function startGameOnCourtFromPlan(courtId, plan){
  const ids = plan.playerIds.slice();

  const g = {
    id: nextGameId++,
    courtId,
    type: plan.type,
    status:'playing',
    playerIds: ids,
    teams: plan.teams,
    createdAt: nowTs(),
    finishedAt: null,
    isHighTier: !!plan.isHighTier
  };
  games.push(g);

  onGameStartedUpdateRestState(ids);

  render();
}

// ----------------------------
// ✅ 라이브 계획 생성(강화된 3:1 세이프티 + 합류 융화 모드)
// ----------------------------
function buildLivePlanAny(courtId){
  initRng(Date.now() ^ ((Math.random()*0xFFFFFFFF)>>>0));

  const busy = getPlayingPlayerSet();
  const activePool = players.filter(p=>!p.isLate);
  const availAny   = activePool.filter(p=>!busy.has(p.id));
  if(availAny.length < 4) return null;

  const baselineMinCore = getBaselineMinCore(activePool);
  const usedKeys = new Set();

  const restForcedSet = computeRestForcedSetForNextStart(activePool);
  const lastFinished = games.filter(g=>g.status==='finished').slice(-1)[0];
  const lastFinishedIds = lastFinished ? lastFinished.playerIds.slice() : [];

  const integrating = hasRecentJoinerIntegrationActive();

  // ✅ (③) 예방 트리거 + (합류 융화 모드면 baseAssist 최소 1)
  const preAssist = shouldPreAssistThreeOne(availAny, restForcedSet);
  const baseAssist = Math.max(matchState.liveThreeOneAssistLevel || 0, preAssist ? 1 : 0, integrating ? 1 : 0);

  for(let assistLevel = baseAssist; assistLevel <= matchOptions.liveAssistMax; assistLevel++){
    for(const ph of HYBRID_PHASES){
      const ctx = {
        mode: 'live',
        phaseId: ph.id,
        integrating,
        activePool,
        scheduledSoFar: null,
        targetWindowN: matchOptions.ratioWindowW || 18,
        overlapWindowN: matchOptions.overlapWindowN || 14,
        ratioWeight: ph.ratioWeight,
        restMode: ph.rest.mode,
        overlapMode: ph.overlap.mode,
        restForcedSet,
        lastFinishedIds,
        threeOneAssistLevel: assistLevel
      };

      let cand = availAny;

      if(cand.length < 4) continue;

      let pick = pickForAnySmart(cand, usedKeys, baselineMinCore, ctx);
      if(!pick) continue;

      const realType = (pick.finalType === 'any31') ? 'any' : pick.finalType;
      const split = bestTeamSplit(pick.group, realType);
      if(!split) continue;

      const ids = pick.group.map(p=>p.id);
      const teams = [
        [split.teams[0][0].id, split.teams[0][1].id],
        [split.teams[1][0].id, split.teams[1][1].id]
      ];

      return {
        type: realType,
        playerIds: ids,
        teams,
        isHighTier: false,
        __phase: ph.id,
        __assist: assistLevel
      };
    }
  }

  return null;
}

function generateMatchForCourt(courtId){
  if (games.some(g => g.status === 'playing' && g.courtId === courtId)) {
    alert('해당 코트는 이미 진행 중인 게임이 있습니다. 종료 후 매칭해주세요.');
    return;
  }

  const plan = buildLivePlanAny(courtId);
  if(!plan){
    liveFailStreak++;
    if(liveFailStreak >= matchOptions.liveFailToAssistThreshold){
      matchState.liveThreeOneAssistLevel = Math.min(matchOptions.liveAssistMax, (matchState.liveThreeOneAssistLevel||0) + 1);
    }
    alert('매칭 가능한 인원이 부족하거나 조건으로 매칭을 만들 수 없습니다.');
    return;
  }

  liveFailStreak = 0;

  // ✅ 성공 시 assist를 무조건 내리지 않음(재막힘 방지)
  if((matchState.liveThreeOneAssistLevel||0) > 0 && (plan.__assist||0) === 0){
    matchState.liveThreeOneAssistLevel = Math.max(0, (matchState.liveThreeOneAssistLevel||0) - 1);
  }

  startGameOnCourtFromPlan(courtId, plan);
}

function finishGame(gameId){
  const g = games.find(x=>x.id===gameId);
  if(!g) return;
  g.status='finished';
  g.finishedAt = nowTs();

  g.playerIds.forEach(pid=>{
    const p=players.find(x=>x.id===pid);
    if(p) p.gamesPlayed++;
  });

  render();
}

function cancelGame(gameId){
  const g = games.find(x=>x.id===gameId);
  if(!g) return;
  if(!confirm('진행중 게임을 취소하시겠습니까? (게임수는 증가하지 않습니다)')) return;

  games = games.filter(x=>x.id!==gameId);
  rebuildStartSequenceFromGames();
  render();
}

// ----------------------------
// Batch matching (N games)
// ----------------------------
function generateBatchMatches(){
  initRng(Date.now() ^ ((Math.random()*0xFFFFFFFF)>>>0));

  const count = parseInt(document.getElementById('batchCount').value || '0', 10);
  if(!count || count<=0) return;

  const basePool = players.filter(p=>!p.isLate);
  if(basePool.length < 4){
    alert('참여자가 부족합니다(늦참 제외).');
    return;
  }

  scheduledGames = [];

  const simPlayers = basePool.map(p=>({...p}));
  const usedKeys = new Set();

  let simStartSeq = startSeq;
  const simLastStart = {};
  const simConsec = {};
  const simRestBan = {};

  for(const p of basePool){
    simLastStart[p.id] = lastStartIndexByPlayer[p.id];
    simConsec[p.id] = consecStartCountByPlayer[p.id];
    simRestBan[p.id] = restBanUntilSeqByPlayer[p.id];
  }

  function simComputeRestForcedSet(){
    const next = simStartSeq + 1;
    const set = new Set();
    for(const p of simPlayers){
      const ban = simRestBan[p.id] || 0;
      if(ban >= next){
        set.add(p.id);
      }
    }
    return set;
  }

  function simOnPlannedStart(ids){
    simStartSeq++;
    for(const pid of ids){
      const last = simLastStart[pid];
      if(typeof last === 'number' && last === simStartSeq - 1){
        simConsec[pid] = (simConsec[pid] || 1) + 1;
      }else{
        simConsec[pid] = 1;
      }
      simLastStart[pid] = simStartSeq;
      if(simConsec[pid] >= 2){
        simRestBan[pid] = Math.max(simRestBan[pid] || 0, simStartSeq + 1);
      }
    }
  }

  const hiMenPoolAll = matchOptions.highTierEnabled ? buildHighTierPool(basePool, '남') : [];
  const hiWomenPoolAll = matchOptions.highTierEnabled ? buildHighTierPool(basePool, '여') : [];

  let hiMenTarget = matchOptions.highTierEnabled ? Math.round(count * matchOptions.highTierRatio) : 0;
  let hiWomenTarget = matchOptions.highTierEnabled ? Math.round(count * matchOptions.highTierRatio) : 0;

  if(hiMenPoolAll.length < 4) hiMenTarget = 0;
  if(hiWomenPoolAll.length < 4) hiWomenTarget = 0;

  let hiMenMade = 0;
  let hiWomenMade = 0;

  const GLOBAL_HIGH_TIER_MIN_GAP = 2;
  let lastHighTierSeq = 0;

  function buildEvenSlots(total, target){
    if(!target || target<=0) return [];
    const step = total / (target + 1);
    const slots = [];
    for(let i=1;i<=target;i++){
      let pos = Math.round(step * i);
      pos = Math.max(1, Math.min(total, pos));
      slots.push(pos);
    }
    return Array.from(new Set(slots)).sort((a,b)=>a-b);
  }
  function isSlotFree(pos, usedSet, minGap){
    for(const v of usedSet){
      if(Math.abs(v - pos) < minGap) return false;
    }
    return true;
  }
  function placeAround(pos, usedSet, total, minGap){
    for(let d=0; d<=total; d++){
      const cands = d===0 ? [pos] : [pos+d, pos-d];
      for(const cand of cands){
        if(cand<1 || cand>total) continue;
        if(isSlotFree(cand, usedSet, minGap)) return cand;
      }
    }
    return null;
  }

  const usedSlots = new Set();
  const menSlotsRaw = buildEvenSlots(count, hiMenTarget);
  const menSlots = [];
  for(const s of menSlotsRaw){
    const placed = placeAround(s, usedSlots, count, GLOBAL_HIGH_TIER_MIN_GAP);
    if(placed!=null){ menSlots.push(placed); usedSlots.add(placed); }
  }

  const womenSlotsRaw = buildEvenSlots(count, hiWomenTarget);
  const womenSlots = [];
  for(const s of womenSlotsRaw){
    const placed = placeAround(s, usedSlots, count, GLOBAL_HIGH_TIER_MIN_GAP);
    if(placed!=null){ womenSlots.push(placed); usedSlots.add(placed); }
  }

  const menSlotSet = new Set(menSlots);
  const womenSlotSet = new Set(womenSlots);

  let created = 0;
  let safetyRounds = 0;

  let batchThreeOneAssistLevel = 0;

  while(created < count){
    safetyRounds++;
    if(safetyRounds > 4000) break;

    const beforeRound = created;
    const usedThisRound = new Set();

    for(const cid of courts){
      if(created >= count) break;

      const courtType = document.getElementById(`courtType_${cid}`)?.value || 'any';

      const availAny = simPlayers.filter(p=>!usedThisRound.has(p.id));
      if(availAny.length < 4) continue;

      const baselineMinCore = getBaselineMinCore(simPlayers);
      const restForcedSet = simComputeRestForcedSet();

      const integrating = false;

      const preAssist = shouldPreAssistThreeOne(availAny, restForcedSet);
      const assistForThisPick = Math.max(batchThreeOneAssistLevel, preAssist ? 1 : 0);

      let pick = null;
      let forcedType = null;
      let isHighTierPick = false;

      const nextPlannedIndex = created + 1;

      // 고티어 매칭
      if(matchOptions.highTierEnabled && courtType !== 'mixed'){
        const canTryGap = (lastHighTierSeq===0) ? true : ((nextPlannedIndex - lastHighTierSeq) >= GLOBAL_HIGH_TIER_MIN_GAP);

        const menStill = (hiMenMade < hiMenTarget) && (hiMenPoolAll.length >= 4);
        const womenStill = (hiWomenMade < hiWomenTarget) && (hiWomenPoolAll.length >= 4);

        const wantMen = canTryGap && menStill && menSlotSet.has(nextPlannedIndex);
        const wantWomen = canTryGap && womenStill && womenSlotSet.has(nextPlannedIndex);

        let genderTryOrder = [];
        if(wantMen && wantWomen){
          genderTryOrder = (rand01() < 0.5) ? ['남','여'] : ['여','남'];
        } else if(wantMen){
          genderTryOrder = ['남'];
        } else if(wantWomen){
          genderTryOrder = ['여'];
        }

        for(const gnd of genderTryOrder){
          const hiType = (gnd === '남') ? 'md' : 'wd';
          if(!(courtType === 'any' || courtType === hiType)) continue;

          const poolAll = (gnd === '남') ? hiMenPoolAll : hiWomenPoolAll;
          const hiAvail = poolAll
            .map(p => simPlayers.find(sp=>sp.id===p.id))
            .filter(Boolean)
            .filter(p => !usedThisRound.has(p.id));

          if(hiAvail.length < 4) continue;

          for(const ph of HYBRID_PHASES){
            const ctx = {
              mode:'batch',
              phaseId: ph.id,
              integrating,
              activePool: simPlayers,
              scheduledSoFar: scheduledGames,
              targetWindowN: matchOptions.ratioWindowW || 18,
              overlapWindowN: matchOptions.overlapWindowN || 14,
              ratioWeight: ph.ratioWeight,
              restMode: ph.rest.mode,
              overlapMode: ph.overlap.mode,
              restForcedSet,
              lastFinishedIds: [],
              threeOneAssistLevel: assistForThisPick
            };

            let cand = hiAvail;
            if(cand.length < 4) continue;

            const localPick = pickBestQuartet(cand, hiType, usedKeys, baselineMinCore, ctx);
            if(localPick){
              pick = localPick;
              forcedType = hiType;
              isHighTierPick = true;

              if(gnd === '남') hiMenMade++; else hiWomenMade++;
              lastHighTierSeq = nextPlannedIndex;
              break;
            }
          }
          if(pick) break;
        }
      }

      // 일반 매칭
      if(!pick){
        for(const ph of HYBRID_PHASES){
          const ctx = {
            mode:'batch',
            phaseId: ph.id,
            integrating,
            activePool: simPlayers,
            scheduledSoFar: scheduledGames,
            targetWindowN: matchOptions.ratioWindowW || 18,
            overlapWindowN: matchOptions.overlapWindowN || 14,
            ratioWeight: ph.ratioWeight,
            restMode: ph.rest.mode,
            overlapMode: ph.overlap.mode,
            restForcedSet,
            lastFinishedIds: [],
            threeOneAssistLevel: assistForThisPick
          };

          let cand = availAny;
          if(cand.length < 4) continue;

          if(courtType === 'any'){
            pick = pickForAnySmart(cand, usedKeys, baselineMinCore, ctx);
          }else{
            pick = pickBestQuartet(cand, courtType, usedKeys, baselineMinCore, ctx);
            if(pick) pick.finalType = courtType;
          }

          if(pick) break;
        }
      }

      if(!pick) continue;

      const group = pick.group;
      const finalType = forcedType ? forcedType : pick.finalType;
      const realType = (finalType === 'any31') ? 'any' : finalType;

      const split = bestTeamSplit(group, realType);
      if(!split) continue;

      const ids = group.map(p=>p.id);
      const teams = [
        [split.teams[0][0].id, split.teams[0][1].id],
        [split.teams[1][0].id, split.teams[1][1].id]
      ];

      scheduledGames.push({
        id: 100000 + (nextGameId++),
        type: realType,
        status:'scheduled',
        playerIds: ids,
        teams,
        createdAt: nowTs(),
        isHighTier: isHighTierPick
      });

      ids.forEach(pid=>{
        const sp = simPlayers.find(x=>x.id===pid);
        if(sp) sp.gamesPlayed++;
        usedThisRound.add(pid);
      });

      usedKeys.add(pick.key);
      simOnPlannedStart(ids);

      created++;
    }

    if(beforeRound === created){
      if(matchOptions.allowThreeOne && batchThreeOneAssistLevel < 2){
        batchThreeOneAssistLevel++;
        continue;
      }
      break;
    }
  }

  if(created < count){
    alert(`요청한 ${count}경기 중 ${created}경기만 생성되었습니다.\n(인원/타입/휴식강제/중복 제약으로 더 이상 생성 불가)`);
  }

  render();
}

// ✅ 배치 시작 시: 늦참/진행중 인원 포함된 예정경기는 자동 제거(버그 방지)
function popNextValidScheduledForCourt(courtId){
  const busy = getPlayingPlayerSet();
  for(let i=0;i<scheduledGames.length;i++){
    const g = scheduledGames[i];
    const hasLate = g.playerIds.some(pid => {
      const p = players.find(x=>x.id===pid);
      return !p || p.isLate;
    });
    const hasBusy = g.playerIds.some(pid => busy.has(pid));
    if(hasLate || hasBusy){
      scheduledGames.splice(i,1);
      i--;
      continue;
    }
    return scheduledGames.splice(i,1)[0];
  }
  return null;
}

function startScheduledToCourt(courtId){
  if(games.some(g=>g.status==='playing' && g.courtId===courtId)){
    alert('해당 코트는 이미 진행 중입니다.');
    return;
  }

  const next = popNextValidScheduledForCourt(courtId);
  if(!next){
    alert('배치 목록이 비어있거나(또는 늦참/진행중 인원 포함으로 자동 제거되어) 시작할 게임이 없습니다.');
    return;
  }

  startGameOnCourtFromPlan(courtId, next);
}

// ----------------------------
// Manual match
// ----------------------------
let manualCourtId = null;

function openManualModal(courtId){
  manualCourtId = courtId;
  const busy = getPlayingPlayerSet();
  const cand = players.filter(p=>!p.isLate && !busy.has(p.id));
  if(cand.length < 4){
    alert('수동 매칭 가능한 인원이 부족합니다(늦참/진행중 제외).');
    return;
  }

  const sels = [m1,m2,m3,m4];
  sels.forEach(s=>s.innerHTML='');

  cand
    .slice()
    .sort((a,b)=>a.name.localeCompare(b.name,'ko'))
    .forEach(p=>{
      const label = `${p.name}(${p.gender}/${p.level}/G${p.gamesPlayed}${p.lateJoiner?'/합류':''})`;
      sels.forEach(s=>{
        const opt=document.createElement('option');
        opt.value=String(p.id);
        opt.textContent=label;
        s.appendChild(opt.cloneNode(true));
      });
    });

  document.getElementById('manualBack').classList.add('open');
}

function closeManualModal(){
  document.getElementById('manualBack').classList.remove('open');
}

function saveManualGame(){
  const ids = [
    parseInt(document.getElementById('m1').value,10),
    parseInt(document.getElementById('m2').value,10),
    parseInt(document.getElementById('m3').value,10),
    parseInt(document.getElementById('m4').value,10),
  ];
  const set = new Set(ids);
  if(set.size!==4){
    alert('4명을 모두 다르게 선택하세요.');
    return;
  }

  const busy = getPlayingPlayerSet();
  if(ids.some(id=>busy.has(id))){
    alert('진행 중 게임과 인원이 겹칩니다.');
    return;
  }

  const courtId = manualCourtId;
  if(courtId==null){ alert('코트가 선택되지 않았습니다.'); return; }
  if(games.some(g=>g.status==='playing' && g.courtId===courtId)){
    alert('해당 코트는 이미 진행 중입니다.');
    return;
  }

  const group = ids.map(id=>players.find(p=>p.id===id)).filter(Boolean);

  let finalType = inferTypeFromGroup(group);
  if(finalType === 'any31' && !matchOptions.allowThreeOne){
    alert('현재 3:1 옵션이 OFF라서 이 조합(3:1)은 시작할 수 없습니다.');
    return;
  }

  const split = bestTeamSplit(group, (finalType==='any31' ? 'any' : finalType));
  if(!split){
    alert('해당 조합은 팀 구성 조건을 만족하지 않습니다.');
    return;
  }

  const teams = [
    [split.teams[0][0].id, split.teams[0][1].id],
    [split.teams[1][0].id, split.teams[1][1].id]
  ];

  const g = {
    id: nextGameId++,
    courtId,
    type: (finalType==='any31' ? 'any' : finalType),
    status:'playing',
    playerIds: ids,
    teams,
    createdAt: nowTs(),
    finishedAt: null,
    isHighTier: false
  };
  games.push(g);

  onGameStartedUpdateRestState(ids);

  closeManualModal();
  render();
}

// ----------------------------
// Options Modal + 성비 정보 표시
// ----------------------------
function renderThreeOneRecText(){
  const el = document.getElementById('optThreeOneRec');
  if(!el) return;
  const r = computeThreeOneRecommendation();
  if(r.rec){
    el.innerHTML = `(권장: <span class="recOn">ON(${r.level})</span>)`;
  }else{
    el.innerHTML = `(권장: <span class="recOff">OFF</span>)`;
  }
}

function renderGenderInfoInModal(){
  const box = document.getElementById('genderInfoBox');
  if(!box) return;

  const pool = players.filter(p=>!p.isLate);
  const total = pool.length;
  const f = pool.filter(p=>p.gender==='여').length;
  const m = total - f;
  const fr = (total>0) ? (f/total) : 0;

  const autoMode = computeAutoGenderModeFromPool(pool);
  const selected = document.getElementById('optGenderMode')?.value || matchOptions.genderMode || 'auto';
  const finalMode = (selected === 'auto') ? autoMode : selected;

  const tLine = `목표비율(타입): <b>${buildTargetRatioText(finalMode)}</b>`;

  const { recN, recW, active, targetGames } = computeRecommendedNW();
  const curN = matchOptions.overlapWindowN ?? 14;
  const curW = matchOptions.ratioWindowW ?? 18;

  const rec31 = computeThreeOneRecommendation();

  box.innerHTML = `
    <div>현재 성비(늦참 제외): <b>총 ${total}</b>명 · 남 <b>${m}</b> · 여 <b>${f}</b> · 여비율 <b>${formatPct(fr)}</b></div>
    <div style="margin-top:6px">자동 판정: <b>${genderModeLabel(autoMode)}</b></div>
    <div style="margin-top:6px">현재 적용 모드: <b>${genderModeLabel(finalMode)}</b></div>
    <div style="margin-top:6px">${tLine}</div>
    <div style="margin-top:8px"><b>현재 N/W</b>: N=<b>${curN}</b>, W=<b>${curW}</b></div>
    <div style="margin-top:6px"><b>추천 N/W</b> (활동 ${active}명, 목표 ${targetGames}경기 기준): N=<b>${recN}</b>, W=<b>${recW}</b></div>
    <div style="margin-top:8px"><b>3:1 권장</b>: ${rec31.rec ? `<b>ON(${rec31.level})</b>` : `<b>OFF</b>`} (막힘 방지 최우선 세이프티로 사용)</div>
    <div style="margin-top:6px" class="mini">※ 합류 직후에는 자동 “융화 모드”가 켜져 제약이 한시 완화됩니다.</div>
  `;

  renderThreeOneRecText();
}

function openMatchOptionsModal(){
  document.getElementById('optPreferF4').checked = !!matchOptions.preferF4;
  document.getElementById('optHighTier').checked = !!matchOptions.highTierEnabled;
  document.getElementById('optAllowThreeOne').checked = !!matchOptions.allowThreeOne;

  const gm = document.getElementById('optGenderMode');
  if(gm){
    gm.value = matchOptions.genderMode || 'auto';
    if(gm.dataset.bound !== '1'){
      gm.addEventListener('change', () => renderGenderInfoInModal());
      gm.dataset.bound = '1';
    }
  }

  const nEl = document.getElementById('optOverlapN');
  const wEl = document.getElementById('optRatioW');
  if(nEl) nEl.value = String(matchOptions.overlapWindowN ?? 14);
  if(wEl) wEl.value = String(matchOptions.ratioWindowW ?? 18);

  renderGenderInfoInModal();
  document.getElementById('matchOptBack').classList.add('open');
}

function closeMatchOptionsModal(){
  document.getElementById('matchOptBack').classList.remove('open');
}

function saveMatchOptions(){
  matchOptions.preferF4 = !!document.getElementById('optPreferF4').checked;
  matchOptions.highTierEnabled = !!document.getElementById('optHighTier').checked;
  matchOptions.allowThreeOne = !!document.getElementById('optAllowThreeOne').checked;

  const gm = document.getElementById('optGenderMode');
  matchOptions.genderMode = gm ? (gm.value || 'auto') : 'auto';

  const nEl = document.getElementById('optOverlapN');
  const wEl = document.getElementById('optRatioW');
  matchOptions.overlapWindowN = clampInt(nEl?.value, 4, 30, 14);
  matchOptions.ratioWindowW   = clampInt(wEl?.value, 8, 40, 18);

  closeMatchOptionsModal();
  render();
}

// ----------------------------
// Courts
// ----------------------------
function addCourt(){
  if(courts.length>=4){
    alert('코트는 최대 4개까지 가능합니다.');
    return;
  }
  courts.push(nextCourtId++);
  render();
}

function removeCourt(){
  if(courts.length<=1){
    alert('코트는 최소 1개여야 합니다.');
    return;
  }
  const removed = courts.pop();
  games = games.filter(g=>!(g.status==='playing' && g.courtId===removed));
  rebuildStartSequenceFromGames();
  render();
}

// ----------------------------
// Players
// ----------------------------
function openAddPlayerModal(){
  document.getElementById('addPlayerBack').classList.add('open');
  document.getElementById('apName').focus();
}
function closeAddPlayerModal(){
  document.getElementById('addPlayerBack').classList.remove('open');
}
function addPlayerFromModal(){
  const name = document.getElementById('apName').value.trim();
  const gender = document.getElementById('apGender').value;
  const level  = document.getElementById('apLevel').value;
  const gamesPlayed = Math.max(0, parseInt(document.getElementById('apGames').value||'0',10));

  if(!name){ alert('이름을 입력하세요.'); return; }

  players.push({
    id: nextPlayerId++,
    name, gender, level,
    levelScore: levelScoreMap[level] ?? 1,
    gamesPlayed,
    hasShuttlecock:false,
    isLate:false,
    lateJoiner:false,
    joinedAtSeq:null
  });

  document.getElementById('apName').value='';
  document.getElementById('apGames').value='0';
  closeAddPlayerModal();
  render();
}

function removePlayer(pid){
  if(games.some(g=>g.status==='playing' && g.playerIds.includes(pid))){
    alert('진행 중 게임에 포함된 참여자는 삭제할 수 없습니다.');
    return;
  }
  players = players.filter(p=>p.id!==pid);
  scheduledGames = scheduledGames.filter(g=>!g.playerIds.includes(pid));
  rebuildStartSequenceFromGames();
  render();
}

function toggleShuttle(pid){
  const p=players.find(x=>x.id===pid);
  if(!p) return;
  p.hasShuttlecock = !p.hasShuttlecock;
  renderPlayers();
}

// ✅ 늦참 토글
function toggleLate(pid){
  const p=players.find(x=>x.id===pid);
  if(!p) return;
  if(games.some(g=>g.status==='playing' && g.playerIds.includes(pid))){
    alert('진행 중 게임에 포함된 참여자는 늦참 변경이 불가합니다.');
    return;
  }

  p.isLate = !p.isLate;

  if(p.isLate){
    scheduledGames = scheduledGames.filter(g => !g.playerIds.includes(pid));
  }else{
    // ✅ 늦참 해제(합류)
    p.lateJoiner = true;
    p.joinedAtSeq = startSeq + 1;
  }

  render();
}

// ----------------------------
// Drawer / Reset / Sample
// ----------------------------
function toggleFinishedDrawer(force){
  const d=document.getElementById('finishedDrawer');
  if(typeof force === 'boolean'){
    d.classList.toggle('open', force);
    return;
  }
  d.classList.toggle('open');
}

function resetAll(){
  if(!confirm('전체 초기화 하시겠습니까?')) return;
  nextPlayerId=1;
  nextCourtId=2;
  nextGameId=1;
  courts=[1];
  players=[];
  games=[];
  scheduledGames=[];
  startSeq=0;
  lastStartIndexByPlayer={};
  consecStartCountByPlayer={};
  restBanUntilSeqByPlayer={};

  matchOptions.preferF4=false;
  matchOptions.allowThreeOne=false;
  matchOptions.highTierEnabled=false;
  matchOptions.genderMode='auto';
  matchOptions.overlapWindowN=14;
  matchOptions.ratioWindowW=18;

  matchState.liveThreeOneAssistLevel=0;
  liveFailStreak=0;
  render();
}

function seedSample(){
  loadParticipantsFromSheet();
}

