// ══════════════════════════════════════════════════════
// HexCiv 選角階段負載測試腳本
// 用途：模擬 N 個玩家「幾乎同時」JOIN → 選陣營 → 調整編制 → 準備就緒，
//       在 GitHub Codespaces（或任何有 Node.js 的環境）裡就能重現多人同時
//       擠在 lobby 畫面的情境，不需要真人、不需要 20 支手機。
//
// 用法：
//   1) npm install ws
//   2) SERVER_URL=wss://你的render網址 ROOM_ID=test1 PLAYER_COUNT=20 node load-test.js
//      （不設環境變數的話會用底下的預設值）
//
// 跑完後看兩件事：
//   a) 這支腳本自己印出來的「收到訊息總數/秒」有沒有隨人數線性成長還是暴衝
//   b) Render 後台 Live tail 的 [Memory] 那行，heapUsed 是不是穩定，
//      以及新加的 replayEvents=X筆/約Y MB 有沒有被壓在合理範圍
// ══════════════════════════════════════════════════════

const WebSocket = require('ws');

const SERVER_URL    = process.env.SERVER_URL    || 'wss://your-server.onrender.com';
const ROOM_ID        = process.env.ROOM_ID        || ('loadtest_' + Date.now().toString().slice(-6));
const PLAYER_COUNT   = parseInt(process.env.PLAYER_COUNT || '20', 10);
// 是否讓所有人「幾乎同時」動作（貼近真實 20 人同時擠在選角畫面的情境）。
// 設 0 代表完全同時；設大於 0 代表每個人的動作之間錯開最多這麼多毫秒。
const JOIN_JITTER_MS    = parseInt(process.env.JOIN_JITTER_MS    || '300', 10);
const LOADOUT_CLICKS    = parseInt(process.env.LOADOUT_CLICKS    || '6', 10);   // 模擬每人點幾次 +/-
const LOADOUT_CLICK_GAP = parseInt(process.env.LOADOUT_CLICK_GAP || '150', 10); // 每次點擊間隔(ms)，模擬手速

const LOADOUT_TYPES = ['INFANTRY', 'MECH_INFANTRY', 'TANK', 'SCOUT', 'ARTILLERY'];

let totalSent = 0;
let totalReceived = 0;
let totalBytesReceived = 0;
let connectedCount = 0;
let errorCount = 0;
const startTime = Date.now();

function log(msg) {
  console.log(`[${((Date.now() - startTime) / 1000).toFixed(2)}s] ${msg}`);
}

function randDelay(max) {
  return Math.floor(Math.random() * max);
}

function makeClient(idx) {
  return new Promise((resolve) => {
    const team = idx % 2 === 0 ? 'RED' : 'BLUE';
    const ws = new WebSocket(SERVER_URL);
    let myPID = null;
    let received = 0;

    const send = (type, payload) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type, roomID: ROOM_ID, payload }));
      totalSent++;
    };

    ws.on('open', () => {
      connectedCount++;
      // 模擬 20 人幾乎同時湧入房間，錯開一點點避免每個人 TCP 連線瞬間完全疊在一起
      setTimeout(() => {
        send('JOIN', { role: 'PLAYER', name: `測試玩家${idx}`, team });
      }, randDelay(JOIN_JITTER_MS));
    });

    ws.on('message', (raw) => {
      received++;
      totalReceived++;
      totalBytesReceived += raw.length;
      let packet;
      try { packet = JSON.parse(raw); } catch (e) { return; }

      if (packet.type === 'JOIN_ACK') {
        myPID = packet.payload?.playerID;
        // 選好陣營後，模擬使用者連續點擊調整兵種（這是先前造成廣播風暴的高頻動作，
        // 修正後應該只會各自送出、不會被隊友的回應觸發連鎖重送）
        let sent = 0;
        const clickLoop = setInterval(() => {
          if (sent >= LOADOUT_CLICKS || ws.readyState !== WebSocket.OPEN) {
            clearInterval(clickLoop);
            send('PLAYER_READY', { team, loadout: { INFANTRY: 1 } });
            resolve({ idx, received: () => received });
            return;
          }
          const tid = LOADOUT_TYPES[sent % LOADOUT_TYPES.length];
          send('TEAM_LOADOUT_UPDATE', {
            team,
            loadout: { [tid]: 1 },
            pts: sent + 1,
          });
          sent++;
        }, LOADOUT_CLICK_GAP);
      }
    });

    ws.on('error', (err) => {
      errorCount++;
      log(`玩家${idx} 連線錯誤: ${err.message}`);
    });

    ws.on('close', () => {
      // 保底：即使沒收到 JOIN_ACK 也要讓 Promise resolve，避免整支腳本卡住
      resolve({ idx, received: () => received });
    });
  });
}

async function main() {
  log(`開始模擬 ${PLAYER_COUNT} 人連線 → 房間 ${ROOM_ID} → ${SERVER_URL}`);

  const clients = [];
  for (let i = 1; i <= PLAYER_COUNT; i++) {
    clients.push(makeClient(i));
  }

  // 每 2 秒印一次即時統計，方便跟 Render 的 [Memory] log 對照時間點
  const statsTimer = setInterval(() => {
    log(`連線數=${connectedCount}/${PLAYER_COUNT}, 已送出=${totalSent}, 已收到=${totalReceived} 筆/約${(totalBytesReceived / 1024).toFixed(1)}KB, 錯誤=${errorCount}`);
  }, 2000);

  await Promise.all(clients);
  clearInterval(statsTimer);

  log('── 測試結束 ──');
  log(`總送出封包數：${totalSent}`);
  log(`總收到封包數：${totalReceived}（約 ${(totalBytesReceived / 1024 / 1024).toFixed(2)} MB）`);
  log(`連線錯誤次數：${errorCount}`);
  log('若「總收到封包數」遠超過「玩家數 × 每人點擊次數」的合理倍數（例如超過數千筆），代表廣播放大的問題可能還在，需要回頭檢查。');

  process.exit(0);
}

main();
