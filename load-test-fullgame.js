// ══════════════════════════════════════════════════════
// HexCiv 完整對局負載測試腳本
// 用途：延伸 load-test.js，除了選角/準備就緒，還會真的：
//   房主開始遊戲 → 每人部署幾個單位 → 全員部署完成解鎖 →
//   輪到自己陣營時真的移動單位、回報後勤快照、結束回合，
//   一路跑完指定回合數 —— 用來驗證「真正開打」後記憶體是否穩定
//   （選角階段的廣播風暴已經修好，但戰鬥階段的 UNIT_MOVE /
//    TURN_UPKEEP_SYNC / LOGISTICS_SNAPSHOT 目前還沒有實測數據）。
//
// 用法：
//   npm install ws   （如果之前跑過 load-test.js 應該已經裝過了）
//   SERVER_URL=wss://你的render網址 ROOM_ID=fulltest1 PLAYER_COUNT=20 TURNS_TO_SIMULATE=4 node load-test-fullgame.js
//
// 跑完看：
//   a) 這支腳本印出來的統計（總送出/總收到封包數、耗時）
//   b) Render Live tail 搜尋 Memory，看整場對局期間 heapUsed 是否穩定、
//      replayEvents 的體積有沒有被 MAX_REPLAY_BYTES（5MB）壓住
// ══════════════════════════════════════════════════════

const WebSocket = require('ws');

const SERVER_URL        = process.env.SERVER_URL        || 'wss://your-server.onrender.com';
const ROOM_ID            = process.env.ROOM_ID            || ('fulltest_' + Date.now().toString().slice(-6));
const PLAYER_COUNT       = parseInt(process.env.PLAYER_COUNT       || '20', 10);
const TURNS_TO_SIMULATE  = parseInt(process.env.TURNS_TO_SIMULATE  || '4', 10);   // 模擬幾個完整回合（紅+藍算一回合）
const UNITS_PER_PLAYER   = parseInt(process.env.UNITS_PER_PLAYER   || '3', 10);
const MAP_SIZE           = 40; // 對應遊戲的 40×40 地圖
const HARD_TIMEOUT_MS    = 5 * 60 * 1000; // 保底：5 分鐘後不管跑到哪都強制結束，避免腳本卡死

let totalSent = 0, totalReceived = 0, totalBytesReceived = 0;
let connectedCount = 0, errorCount = 0, spawnedUnits = 0, movesSent = 0;
const startTime = Date.now();

function log(msg) {
  console.log(`[${((Date.now() - startTime) / 1000).toFixed(2)}s] ${msg}`);
}
function randInt(max) { return Math.floor(Math.random() * max); }
function randDelay(max) { return Math.floor(Math.random() * max); }

function makeClient(idx) {
  return new Promise((resolve) => {
    // ⚠ 修正：房主判斷不能用腳本內部的 idx，要用伺服器實際分配的 playerID。
    //    20 條連線幾乎同時搶著送 JOIN，誰先到伺服器、被分配到 playerID=1 是不固定的，
    //    跟腳本裡的 idx=1 常常不是同一個連線——之前版本假設 idx===1 就是房主，
    //    導致「假房主」送出 GAME_START 時被伺服器拒絕（真正的 1 號玩家另有其人），
    //    結果整場卡在等待遊戲開始，永遠不會進到部署/戰鬥階段。
    let isHost = false;
    const team   = idx % 2 === 0 ? 'RED' : 'BLUE';
    const ws     = new WebSocket(SERVER_URL);

    let myPID = null;
    let myUnits = [];          // 這個玩家自己的單位 uid 清單
    let activeTeam = null;
    let turnCount = 1;
    let actedThisTurn = false;
    let allDeployed = false;
    let finished = false;
    let received = 0;

    const finish = () => {
      if (finished) return;
      finished = true;
      try { ws.close(); } catch (e) {}
      resolve({ idx, received: () => received });
    };

    const send = (type, payload) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type, roomID: ROOM_ID, payload }));
      totalSent++;
    };

    // 部署階段：生成自己的幾個單位，然後回報部署完成
    const doDeploy = () => {
      for (let n = 0; n < UNITS_PER_PLAYER; n++) {
        const uid = `p${idx}_u${n}`;
        myUnits.push(uid);
        send('UNIT_SPAWN', {
          uid, team, type: 'INFANTRY',
          q: randInt(MAP_SIZE), r: randInt(MAP_SIZE),
          hp: 100,
        });
        spawnedUnits++;
      }
      send('PLAYER_DEPLOYED', {});
      log(`玩家${idx}（${team}）已送出 ${UNITS_PER_PLAYER} 個單位 + PLAYER_DEPLOYED`);
    };

    // 輪到自己陣營時：移動幾個單位、送一次後勤快照、結束回合
    const doTurnActions = () => {
      if (activeTeam !== team || actedThisTurn || !allDeployed) return;
      actedThisTurn = true;
      log(`玩家${idx}（${team}）輪到我方回合（第${turnCount}回合），開始行動`);

      setTimeout(() => {
        // 模擬移動：每個單位往鄰近格子挪一下
        for (const uid of myUnits) {
          send('UNIT_MOVE', {
            uid,
            q: randInt(MAP_SIZE), r: randInt(MAP_SIZE),
          });
          movesSent++;
        }
        // 模擬後勤快照廣播（這是先前懷疑過、體積較大的封包類型，實際測一下）
        send('LOGISTICS_SNAPSHOT', {
          units: myUnits.map(uid => ({
            uid, food: randInt(100), fuel: randInt(100),
            ammo: randInt(100), manpower: randInt(10),
          })),
        });
        // 結束回合
        setTimeout(() => send('END_TURN', {}), randDelay(200));
      }, randDelay(300));
    };

    ws.on('open', () => {
      connectedCount++;
      setTimeout(() => {
        send('JOIN', { role: 'PLAYER', name: `測試玩家${idx}`, team });
      }, randDelay(300));
    });

    ws.on('message', (raw) => {
      received++; totalReceived++; totalBytesReceived += raw.length;
      let packet;
      try { packet = JSON.parse(raw); } catch (e) { return; }
      handlePacket(packet);
    });

    // ⚠ 修正核心 bug：伺服器在同一個 100ms 批次視窗內若有多筆封包要送給
    //   同一條連線，會打包成 { type:'BATCH', payload:{ events:[...] } }
    //   而不是一筆一筆分開送——20 人幾乎同時部署完成時，DEPLOY_UPDATE /
    //   ALL_DEPLOYED 很容易被一起包進同一個 BATCH。原本的 switch 只認得
    //   「裸」封包類型，完全沒攤開處理 BATCH，導致包在裡面的 ALL_DEPLOYED
    //   被整包無視，遊戲永遠卡在部署階段、只能靠伺服器的 120 秒逾時安全網
    //   硬推進——這就是為什麼伺服器端 log 一切正常，腳本卻顯示卡住不動。
    //   把原本寫在 ws.on('message') 裡的 switch 抽成獨立函式，BATCH 收到
    //   時把 events 陣列裡的每一筆都遞迴丟回這裡重新處理即可。
    function handlePacket(packet) {
      if (packet.type === 'BATCH') {
        for (const evt of (packet.payload?.events || [])) handlePacket(evt);
        return;
      }

      switch (packet.type) {
        case 'JOIN_ACK':
          myPID = packet.payload?.playerID;
          isHost = (myPID === 1);  // 用伺服器實際分配的 PID 判斷，不是猜的
          if (isHost) log(`玩家${idx} 確認自己是房主（伺服器分配 PID=1）`);
          send('TEAM_LOADOUT_UPDATE', { team, loadout: { INFANTRY: 1 }, pts: 1 });
          setTimeout(() => send('PLAYER_READY', { team, loadout: { INFANTRY: 1 }, pts: 1 }), randDelay(200));
          break;

        case 'READY_UPDATE':
          if (isHost) {
            log(`房主收到 READY_UPDATE：readyCount=${packet.payload?.readyCount}, totalCount=${packet.payload?.totalCount}`);
          }
          if (isHost && packet.payload?.readyCount >= packet.payload?.totalCount) {
            log(`房主判定全員已準備，300ms 後送出 GAME_START`);
            setTimeout(() => send('GAME_START', { seed: 12345, mapType: 'north' }), 300);
          }
          break;

        case 'GAME_START':
          activeTeam = packet.payload?.activeTeam || 'RED';
          turnCount  = packet.payload?.turnCount  || 1;
          log(`玩家${idx} 收到 GAME_START，準備部署`);
          setTimeout(doDeploy, randDelay(500));
          break;

        case 'DEPLOY_UPDATE':
          if (isHost) {
            log(`房主收到 DEPLOY_UPDATE：deployedCount=${packet.payload?.deployedCount}, totalCount=${packet.payload?.totalCount}`);
          }
          break;

        case 'ALL_DEPLOYED':
          allDeployed = true;
          activeTeam  = packet.payload?.activeTeam || activeTeam;
          log(`玩家${idx}（${team}）收到 ALL_DEPLOYED，activeTeam=${activeTeam}, forced=${packet.payload?.forced}`);
          doTurnActions();
          break;

        case 'TURN_ADVANCE':
          activeTeam    = packet.payload?.activeTeam;
          turnCount     = packet.payload?.turnCount || turnCount;
          actedThisTurn = false;
          log(`玩家${idx}（${team}）收到 TURN_ADVANCE，activeTeam=${activeTeam}, turnCount=${turnCount}`);
          if (turnCount > TURNS_TO_SIMULATE) {
            finish();
          } else {
            doTurnActions();
          }
          break;

        case 'ERROR':
          log(`玩家${idx}(PID=${myPID}) 收到伺服器錯誤: ${packet.payload?.msg}`);
          break;
      }
    }

    ws.on('error', (err) => { errorCount++; log(`玩家${idx} 連線錯誤: ${err.message}`); });
    ws.on('close', (code, reason) => {
      // ⚠ 除錯用：如果房主連線中途意外斷開，會直接看得出來，
      //   而不是像之前一樣悶頭等到 5 分鐘逾時才發現遊戲根本沒開始。
      if (!finished) log(`玩家${idx}${isHost ? '（房主）' : ''} 連線關閉 code=${code} reason=${reason || '(無)'}`);
      finish();
    });
  });
}

async function main() {
  log(`開始模擬 ${PLAYER_COUNT} 人完整對局（${TURNS_TO_SIMULATE} 回合）→ 房間 ${ROOM_ID} → ${SERVER_URL}`);

  const clients = [];
  for (let i = 1; i <= PLAYER_COUNT; i++) clients.push(makeClient(i));

  const statsTimer = setInterval(() => {
    log(`連線=${connectedCount}/${PLAYER_COUNT}, 送出=${totalSent}, 收到=${totalReceived}筆/約${(totalBytesReceived/1024).toFixed(1)}KB, 已生成單位=${spawnedUnits}, 已送出移動=${movesSent}, 錯誤=${errorCount}`);
  }, 3000);

  const hardTimeout = setTimeout(() => {
    log('⚠ 已達 5 分鐘保底逾時，強制結束（可能是還沒跑完指定回合數，或卡在某個環節沒收到預期封包）');
  }, HARD_TIMEOUT_MS);

  await Promise.race([
    Promise.all(clients),
    new Promise(r => setTimeout(r, HARD_TIMEOUT_MS)),
  ]);

  clearInterval(statsTimer);
  clearTimeout(hardTimeout);

  log('── 測試結束 ──');
  log(`總送出封包數：${totalSent}`);
  log(`總收到封包數：${totalReceived}（約 ${(totalBytesReceived/1024/1024).toFixed(2)} MB）`);
  log(`共生成單位：${spawnedUnits}，共送出移動：${movesSent}`);
  log(`連線錯誤次數：${errorCount}`);
  process.exit(0);
}

main();
