function render(){
  const sel = document.getElementById('batchCount');
  if(!sel.dataset.ready){
    for(let i=1;i<=30;i++){
      const opt=document.createElement('option');
      opt.value=String(i);
      opt.textContent=`${i}경기`;
      sel.appendChild(opt);
    }
    sel.value="28";
    sel.dataset.ready="1";
  }

  document.getElementById('courtCount').textContent = courts.length;

  const playing = games.filter(g=>g.status==='playing');
  document.getElementById('playingCount').textContent = playing.length;

  const busy = getPlayingPlayerSet();
  const waiting = players.filter(p=>!p.isLate && !busy.has(p.id));
  document.getElementById('waitingCount').textContent = waiting.length;

  const act = players.filter(p=>!p.isLate);
  let diffTxt='-';
  if(act.length>0){
    const minG = Math.min(...act.map(p=>p.gamesPlayed));
    const maxG = Math.max(...act.map(p=>p.gamesPlayed));
    diffTxt = `${maxG - minG}`;
  }
  document.getElementById('diffGames').textContent = diffTxt;

  const restForcedSet = computeRestForcedSetForNextStart(act);
  document.getElementById('restForcedCount').textContent = String(restForcedSet.size);

  const appliedMode = resolveGenderMode({ activePool: act });
  document.getElementById('targetRatioText').textContent = buildTargetRatioText(appliedMode);

  renderCourts();
  renderPlayers();
  renderScheduled();
  renderFinished();

  const isOpen = document.getElementById('matchOptBack')?.classList.contains('open');
  if(isOpen) renderGenderInfoInModal();
}

function renderCourts(){
  const root=document.getElementById('courts');
  root.innerHTML='';
  for(const courtId of courts){
    const currentGame = games.find(g=>g.status==='playing' && g.courtId===courtId);
    const courtCard=document.createElement('div');
    courtCard.className='courtCard';
    const courtTypeSelId = `courtType_${courtId}`;

    courtCard.innerHTML = `
      <div class="courtHead">
        <div class="courtTitle">코트 ${courtId}</div>
        <span class="tag">타입</span>
        <select id="${courtTypeSelId}">
          <option value="any">any</option>
          <option value="mixed">mixed</option>
          <option value="md">md</option>
          <option value="wd">wd</option>
        </select>
        <span class="right"></span>
        <button class="btn-primary" ${currentGame?'disabled':''} onclick="generateMatchForCourt(${courtId})">게임 매칭</button>
        <button class="btn-ghost" ${currentGame?'disabled':''} onclick="openManualModal(${courtId})">수동 매칭</button>
        <button class="btn-ghost" ${currentGame?'':'disabled'} onclick="finishGame(${currentGame?.id})">종료</button>
        <button class="btn-danger" ${currentGame?'':'disabled'} onclick="cancelGame(${currentGame?.id})">취소</button>
      </div>
      <div class="gameBox" id="courtBox_${courtId}"></div>
      <div class="row" style="margin-top:8px">
        <button class="btn-primary" ${currentGame?'disabled':''} onclick="startScheduledToCourt(${courtId})">배치 시작</button>
        <span class="muted">배치 목록에서 “가능한 1게임”을 찾아 이 코트에 시작(늦참/진행중 포함 게임 자동 제거)</span>
      </div>
    `;

    root.appendChild(courtCard);

    const sel=document.getElementById(courtTypeSelId);
    if(sel && sel.dataset.bound!=='1'){
      sel.addEventListener('change', ()=> render());
      sel.dataset.bound='1';
    }

    const box=document.getElementById(`courtBox_${courtId}`);
    if(!currentGame){
      box.innerHTML = `<div class="muted">진행 중인 게임이 없습니다.</div>`;
    }else{
      const t1 = currentGame.teams[0].map(id=>players.find(p=>p.id===id)).filter(Boolean);
      const t2 = currentGame.teams[1].map(id=>players.find(p=>p.id===id)).filter(Boolean);
      box.innerHTML = `
        <div class="row">
          <span class="pill"><strong>게임ID</strong> ${currentGame.id}</span>
          <span class="pill"><strong>타입</strong> ${gameTypeLabel(currentGame.type)}${currentGame.isHighTier ? ' ★' : ''}</span>
        </div>
        <div class="teams">
          <div class="team"><strong>팀 A</strong>${t1.map(formatPlayer).join("")}</div>
          <div class="team"><strong>팀 B</strong>${t2.map(formatPlayer).join("")}</div>
        </div>
      `;
    }
  }
}

function renderPlayers(){
  const tb=document.getElementById('playerTbody');
  tb.innerHTML='';

  const sorted = players.slice().sort((a,b)=>{
    const r = a.name.localeCompare(b.name,'ko');
    if(r!==0) return r;
    return a.id - b.id;
  });

  sorted.forEach(p=>{
    const tr=document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.name}</strong> ${(!p.isLate && p.lateJoiner) ? `<span class="miniTag">합류</span>` : ``}</td>
      <td>${p.gender}</td>
      <td>${p.level}</td>
      <td class="center">${p.gamesPlayed}</td>
      <td class="center"><button class="btn-ghost" onclick="toggleShuttle(${p.id})">${p.hasShuttlecock?'O':'X'}</button></td>
      <td class="center"><button class="btn-ghost" onclick="toggleLate(${p.id})">${p.isLate?'O':'X'}</button></td>
      <td class="center"><button class="btn-danger" onclick="removePlayer(${p.id})">삭제</button></td>
    `;
    tb.appendChild(tr);
  });
}

function renderScheduled(){
  const area=document.getElementById('scheduledArea');
  if(scheduledGames.length===0){
    area.innerHTML = `<div class="muted">배치된 게임이 없습니다.</div>`;
    return;
  }

  area.innerHTML = scheduledGames.map((g, idx)=>{
    const t1 = g.teams[0].map(id=>players.find(p=>p.id===id)).filter(Boolean);
    const t2 = g.teams[1].map(id=>players.find(p=>p.id===id)).filter(Boolean);

    return `
      <div class="gameBox" style="margin:10px 0">
        <div class="row">
          <span class="pill"><strong>#</strong> ${idx+1}</span>
          <span class="pill"><strong>타입</strong> ${gameTypeLabel(g.type)}${g.isHighTier ? ' ★' : ''}</span>
          <span class="right"></span>
        </div>
        <div class="teams">
          <div class="team"><strong>팀 A</strong>${t1.map(formatPlayer).join("")}</div>
          <div class="team"><strong>팀 B</strong>${t2.map(formatPlayer).join("")}</div>
        </div>
      </div>
    `;
  }).join("");
}

function renderFinished(){
  const area=document.getElementById('finishedArea');
  const finished = games.filter(g=>g.status==='finished').slice().sort((a,b)=>b.finishedAt-a.finishedAt);
  document.getElementById('finishedCount').textContent = `(${finished.length})`;

  if(finished.length===0){
    area.innerHTML = `<div class="muted">종료된 게임이 없습니다.</div>`;
    return;
  }
  area.innerHTML = finished.map(g=>{
    const t1 = g.teams[0].map(id=>players.find(p=>p.id===id)).filter(Boolean);
    const t2 = g.teams[1].map(id=>players.find(p=>p.id===id)).filter(Boolean);
    return `
      <div class="gameBox" style="margin:10px 0">
        <div class="row">
          <span class="pill"><strong>게임ID</strong> ${g.id}</span>
          <span class="pill"><strong>코트</strong> ${g.courtId ?? '-'}</span>
          <span class="pill"><strong>타입</strong> ${gameTypeLabel(g.type)}${g.isHighTier ? ' ★' : ''}</span>
          <span class="right"></span>
        </div>
        <div class="teams">
          <div class="team"><strong>팀 A</strong>${t1.map(formatPlayer).join("")}</div>
          <div class="team"><strong>팀 B</strong>${t2.map(formatPlayer).join("")}</div>
        </div>
      </div>
    `;
  }).join("");
}

// init
render();

