/* ============================================
   버티컬 배드민턴 매칭 시스템 — Google Apps Script
   ============================================
   구글 시트 > 확장 프로그램 > Apps Script 에 이 파일 내용을 붙여넣고
   "배포 관리 > 기존 배포 수정 > 새 버전"으로 배포하세요. (URL 유지됨)
   액세스 권한: 모든 사용자
   ============================================ */

// 0. 앱 상태 조회용 — 직접 주소창으로 확인/디버깅할 때를 위해 남겨둠.
// 앱(app.js)은 이 doGet을 쓰지 않고, gviz/tq로 '상태' 탭 값을 직접 읽는다.
// (Apps Script exec URL은 <script> 태그로 불러오면 실행되지 않아 JSONP가 안 통하기 때문)
function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (e.parameter.action === 'getState') {
    var tabName = e.parameter.sheetTab || '상태';
    var tab = ss.getSheetByName(tabName);
    var json = tab ? tab.getRange('A1').getValue() : '';
    return ContentService.createTextOutput(json || '').setMimeType(ContentService.MimeType.TEXT);
  }

  return ContentService.createTextOutput('ok');
}

// 1. 외부 시스템 연동용 수신 함수
function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = JSON.parse(e.postData.contents);

  // 앱 상태 전체(JSON 문자열)를 '상태' 탭 한 셀에 통째로 저장/덮어쓰기
  if (data.action === 'saveState') {
    var tabName = data.sheetTab || '상태';
    var tab = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
    tab.getRange('A1').setValue(data.state);
  }

  // 운동 종료 / 초기화 시 호출 — 저장된 상태 JSON을 비움
  if (data.action === 'clearState') {
    var tabName = data.sheetTab || '상태';
    var tab = ss.getSheetByName(tabName);
    if (tab) tab.getRange('A1').setValue('');
  }

  if (data.action === 'saveGameLog') {
    var tabName = data.sheetTab || '게임매칭';
    var tab = ss.getSheetByName(tabName);
    if (!tab) {
      tab = ss.insertSheet(tabName);
      tab.appendRow(['날짜','게임번호','유형','코트','Team A','A급수','Team B','B급수','소요시간','시각']);
    }
    for (var i = 0; i < data.games.length; i++) {
      var g = data.games[i];
      tab.appendRow([data.date, g.gameNum, g.type, g.court, g.teamA, g.teamA_levels, g.teamB, g.teamB_levels, g.duration, g.time]);
    }
  }

  // 충돌 방지를 위해 기존 출석 업데이트 로직 주석 처리 또는 안전하게 분리 필요
  if (data.action === 'updateAttendance') {
    var tab = ss.getSheetByName('참가자');
    if (!tab) return ContentService.createTextOutput('no tab');
    var lastRow = tab.getLastRow();
    if (lastRow < 2) return ContentService.createTextOutput('no data');
    var names = tab.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var j = 0; j < data.players.length; j++) {
      var p = data.players[j];
      for (var r = 0; r < names.length; r++) {
        if (names[r][0] === p.name) {
          var row = r + 2;

          // [주의] 현재 D열은 '구분', E열은 'KEY'로 사용 중이므로
          // 기존 앱 연동 시 값이 꼬이지 않도록 대관비 뒤쪽(예: F열, N열 등)으로 옮기거나 확인이 필요합니다.
          // 일단 기존 로직은 그대로 유지되나 시트 컬럼 구조와 매칭되는지 확인 필요합니다.
          var cellD = tab.getRange(row, 4);
          var existing = cellD.getValue();
          var newVal = existing ? existing + ', ' + data.date : data.date;
          cellD.setValue(newVal);

          var cellE = tab.getRange(row, 5);
          var count = Number(cellE.getValue()) || 0;
          cellE.setValue(count + 1);
          break;
        }
      }
    }
  }

  if (data.action === 'saveAttendance') {
    var tab = ss.getSheetByName('출석기록');
    if (!tab) {
      tab = ss.insertSheet('출석기록');
      tab.appendRow(['날짜','이름','급수','성별','게임수']);
    }
    for (var k = 0; k < data.players.length; k++) {
      var p = data.players[k];
      tab.appendRow([data.date, p.name, p.level, p.gender, p.gameCount]);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({success:true})).setMimeType(ContentService.MimeType.JSON);
}


function onEdit(e) {
  // e 객체가 없으면 에러 방지 (스크립트 편집기에서 직접 실행 방지)
  if (!e) return;

  var sheet = e.source.getActiveSheet();

  // 💡 필수 추가: '참가자' 시트에서만 작동하도록 제한
  if (sheet.getName() !== "참가자") return;

  // 2. 이름 탭 실시간 입력 감지 및 자동 분리 함수
  var range = e.range;
  var col = range.getColumn();
  var row = range.getRow();

  // A열(이름)이 수정되었고, 타이틀 행(1행)보다 아래인 경우에만 작동
  if (col === 1 && row > 1) {
    var numRows = range.getNumRows();

    for (var i = 0; i < numRows; i++) {
      var currentRow = row + i;

      // 💡 수정: 셀 값을 가져올 때 오류가 나지 않도록 안전하게 처리
      var cellValue = sheet.getRange(currentRow, 1).getValue();
      var rawValue = (cellValue === null || cellValue === undefined || cellValue === "") ? "" : cellValue.toString().trim();

      // [핵심] 이름 칸을 지우면 해당 행의 성별, 급수, 구분, KEY를 깨끗하게 초기화
      if (rawValue === "") {
        sheet.getRange(currentRow, 2, 1, 4).clearContent();
        continue; // 아래 로직을 건너뛰고 다음 줄로 넘어감
      }

      // [케이스 1] 슬래시(/)가 포함된 게스트 데이터 입력 시
      if (rawValue.indexOf('/') !== -1) {
        var parts = rawValue.split('/');
        var realName = parts[0] ? parts[0].trim() : "";
        var gender = parts[1] ? parts[1].trim() : "";
        var level = parts[2] ? parts[2].trim() : "";

        // 이름 칸에는 슬래시를 떼고 순수 이름만 남김
        sheet.getRange(currentRow, 1).setValue(realName);

        // 각각의 자리에 자동 분리 입력
        sheet.getRange(currentRow, 2).setValue(gender);     // B열: 성별
        sheet.getRange(currentRow, 3).setValue(level);      // C열: 급수
        sheet.getRange(currentRow, 4).setValue("게스트");   // D열: 구분

        // E열 KEY 자동 조합 (이름 성별 급수)
        if (realName && gender && level) {
          sheet.getRange(currentRow, 5).setValue(realName + " " + gender + " " + level);
        } else {
          sheet.getRange(currentRow, 5).setValue("");
        }
      }
      // [케이스 2] 슬래시가 없는 일반 이름 입력 시 -> 고정멤버 명단 조회
      else {
        var lastRow = sheet.getLastRow();
        if (lastRow < 2) lastRow = 2;

        // G~I열에 있는 버티컬 고정 멤버 명단 범위를 가져옴
        var fixedMembers = sheet.getRange("G2:I" + lastRow).getValues();

        var found = false;
        var gender = "";
        var level = "";

        for (var j = 0; j < fixedMembers.length; j++) {
          var fixedName = fixedMembers[j][0] ? fixedMembers[j][0].toString().trim() : "";
          if (fixedName === rawValue) {
            gender = fixedMembers[j][1];
            level = fixedMembers[j][2];
            found = true;
            break;
          }
        }

        if (found) {
          // 고정멤버 정보를 찾은 경우 자동 입력
          sheet.getRange(currentRow, 2).setValue(gender);       // B열: 성별
          sheet.getRange(currentRow, 3).setValue(level);        // C열: 급수
          sheet.getRange(currentRow, 4).setValue("고정멤버");   // D열: 구분
          sheet.getRange(currentRow, 5).setValue(rawValue + " " + gender + " " + level); // E열: KEY
        } else {
          // 고정멤버 명단에도 없고 슬래시도 안 쓴 이름인 경우 -> 구분만 게스트로 처리
          sheet.getRange(currentRow, 4).setValue("게스트");
        }
      }
    }
  }
}
