// ✅ 여기에 본인 웹앱 URL/키 입력
const GOOGLE_SHEET_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwmPJbU8J4Cou0f41pTmn1y6gafcc-E2PT8sa7rX1XteeaA9o2LpC2ffzSk9qCJ7MkZ/exec';
const GOOGLE_SHEET_SECRET_KEY = 'qjxlzjfcnfcorvy2dnjfqnxjtlwkr';
const GOOGLE_SHEET_EDIT_URL = 'https://docs.google.com/spreadsheets/d/1nTQdEsl0COQyjXGBWHMhOHDKyLSqbJqtN9lNzSDB4F4/edit?usp=sharing';

function openGoogleSheetEditUrl(){
  if(!GOOGLE_SHEET_EDIT_URL){
    alert('구글 시트 편집 URL이 설정되어 있지 않습니다.');
    return;
  }
  window.open(GOOGLE_SHEET_EDIT_URL, '_blank');
}

function ymdLocal(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function buildGamesHist(activePlayers){
  const map = new Map();
  for(const p of activePlayers){
    const g = Number(p.gamesPlayed||0);
    map.set(g, (map.get(g)||0)+1);
  }
  const keys = Array.from(map.keys()).sort((a,b)=>a-b);
  return keys.map(k=>`G${k}:${map.get(k)}`).join('|');
}

function exportToGoogleSheet(){
  if(!GOOGLE_SHEET_WEBAPP_URL || GOOGLE_SHEET_WEBAPP_URL.includes('PASTE_YOUR_WEBAPP_URL')){
    alert('구글 웹앱 URL을 먼저 설정해주세요.');
    return;
  }

  const all = players.slice();
  const active = all.filter(p=>!p.isLate);

  if(all.length === 0){
    alert('전송할 참여자가 없습니다.');
    return;
  }

  const totalActive = active.length;
  const maleActive = active.filter(p=>p.gender==='남').length;
  const femaleActive = totalActive - maleActive;

  const minGames = totalActive ? Math.min(...active.map(p=>p.gamesPlayed)) : 0;
  const maxGames = totalActive ? Math.max(...active.map(p=>p.gamesPlayed)) : 0;
  const avgGames = totalActive ? (active.reduce((s,p)=>s+(p.gamesPlayed||0),0) / totalActive) : 0;
  const gamesHist = buildGamesHist(active);

  const date = ymdLocal();
  const sessionId = `${date}_${Date.now()}`;

  const rows = all.map(p => ({
    name: p.name,
    gender: p.gender,
    level: p.level,
    gamesPlayed: p.gamesPlayed,
    hasShuttlecock: !!p.hasShuttlecock,
    isLate: !!p.isLate,
    lateJoiner: !!p.lateJoiner,
    summary: {
      totalActive,
      maleActive,
      femaleActive,
      minGames,
      maxGames,
      avgGames: Math.round(avgGames*100)/100,
      gamesHist
    }
  }));

  const payload = { key: GOOGLE_SHEET_SECRET_KEY, date, sessionId, rows };

  fetch(GOOGLE_SHEET_WEBAPP_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(() => {
    alert('전송 요청을 보냈습니다. 시트에 반영되었는지 확인해주세요.');
  }).catch(err => {
    alert('전송 실패: ' + err);
  });
}

/* 참가자 추가 스프레드시트에서 불러오기 */
function loadParticipantsFromSheet(){
  if(!GOOGLE_SHEET_WEBAPP_URL){
    alert('구글 웹앱 URL이 설정되어 있지 않습니다.');
    return;
  }

  const cbName = `__cb_participants_${Date.now()}`;

  window[cbName] = function(res){
    try{
      if(!res || !res.ok){
        alert('참가자 불러오기 실패: ' + (res?.error || 'unknown'));
        return;
      }

      const list = Array.isArray(res.rows) ? res.rows : [];
      if(list.length === 0){
        alert('참가자 시트에 데이터가 없습니다.');
        return;
      }

      let added = 0;
      for(const r of list){
        const name = String(r.name||'').trim();
        const gender = String(r.gender||'').trim();
        const level = String(r.level||'').trim();
        if(!name || !gender || !level) continue;

        const exists = players.some(p => p.name === name && p.gender === gender && p.level === level);
        if(exists) continue;

        players.push({
          id: nextPlayerId++,
          name,
          gender,
          level,
          levelScore: levelScoreMap[level] ?? 1,
          gamesPlayed: 0,
          hasShuttlecock: false,
          isLate: false,
          lateJoiner: false,
          joinedAtSeq: null
        });
        added++;
      }

      render();
      alert(`참가자 시트에서 ${added}명 추가 완료 (중복 제외).`);
    } finally {
      delete window[cbName];
    }
  };

  const url =
    `${GOOGLE_SHEET_WEBAPP_URL}?action=participants` +
    `&key=${encodeURIComponent(GOOGLE_SHEET_SECRET_KEY)}` +
    `&callback=${encodeURIComponent(cbName)}` +
    `&_=${Date.now()}`;

  const s = document.createElement('script');
  s.src = url;
  s.onerror = function(){
    alert('참가자 불러오기 실패: 네트워크/배포 설정을 확인하세요.');
    delete window[cbName];
  };
  document.body.appendChild(s);

  setTimeout(() => { try{ s.remove(); }catch(e){} }, 5000);
}

