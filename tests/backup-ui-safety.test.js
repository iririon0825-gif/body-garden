// バックアップ安全改修: R1/R2/R3/R4/R6/R7相当/R10 と UI 制御

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadEnv, sampleState, clone } = require("./helpers");

function setupBackupUI() {
  const env = loadEnv();
  vm.runInContext(
    `function escapeHtml(s){return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
     const __t = { modal: "", hidden: 0 };
     const UI = { state:null, lineIcon(){return "";}, showModal(h){__t.modal=h;}, hideModal(){__t.hidden++;} };
     const __events = new Map();
     const __els = new Map();
     function __makeEl(id){
       return {
         id, disabled:false, checked:false, files:[], value:"", textContent:"", _html:"",
         className:"", classList:{toggle(){}}, setAttribute(){}, click(){}, focus(){}, select(){},
         addEventListener(type,fn){__events.set(id+":"+type,fn);},
         set innerHTML(v){this._html=v;}, get innerHTML(){return this._html;}
       };
     }
     function __el(id){ if(!__els.has(id)) __els.set(id,__makeEl(id)); return __els.get(id); }
     const document = {
       getElementById(id){return __el(id);},
       querySelectorAll(){return [];},
       createElement(){return __makeEl("created");},
       body:{firstChild:null,insertBefore(){},appendChild(){}}
     };
     const window = { addEventListener(){} };
     const navigator = { clipboard:{ async writeText(){} } };
     const location = { reload(){} };
     const URL = { createObjectURL(){return "blob:x";}, revokeObjectURL(){} };
     class Blob { constructor(parts,opts){this.parts=parts;this.opts=opts;} }
     class File extends Blob { constructor(parts,name,opts){super(parts,opts);this.name=name;} }`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-backup.js"), "utf8"), env.ctx, { filename:"ui-backup.js" });
  return { env, ...env, ui:env.get("BackupUI"), t:env.get("__t"), events:env.get("__events"), els:env.get("__els"), UI:env.get("UI") };
}

test("R10: default stateの最上位項目とKNOWN_TOP_KEYSが一致し、schema/formatは据え置き", () => {
  const env = loadEnv();
  const state = env.get("createDefaultState()");
  assert.deepEqual(Object.keys(state).sort(), clone(env.Backup.KNOWN_TOP_KEYS).sort());
  assert.ok(env.Backup.COUNT_KEYS.every((k) => Array.isArray(state[k])));
  assert.equal(state.schemaVersion, 7);
  assert.equal(env.Backup.FORMAT_VERSION, 1);
});

test("latestRecordDate: Protein・体調・月経だけ新しい場合も検出する", () => {
  const env = loadEnv();
  const s = sampleState(env);
  s.dailyRecords = s.dailyRecords.filter((r) => r.date <= "2026-10-01");
  s.proteinEntries.push({ ...s.proteinEntries[0], id:10, date:"2026-10-04" });
  assert.equal(env.Backup.latestRecordDate(s), "2026-10-04");
  s.conditionEntries.push({ ...s.conditionEntries[0], id:11, date:"2026-10-05" });
  assert.equal(env.Backup.latestRecordDate(s), "2026-10-05");
  s.cycleEntries = [{ id:1, startDate:"2026-10-06", endDate:"2026-10-09", comment:"", createdAt:"2026-10-06T00:00:00.000Z" }];
  assert.equal(env.Backup.latestRecordDate(s), "2026-10-09");
});

test("latestRecordDate: 未来の注射予定は除外し、投与済みはadministeredAtを使う", () => {
  const env = loadEnv();
  const s = sampleState(env);
  s.dailyRecords = [{ date:"2026-10-01", weight:66, bodyComposition:{}, comment:"" }];
  s.proteinEntries = [];
  s.conditionEntries = [];
  s.cycleEntries = [];
  s.injections = [
    { ...env.get("createEmptyInjection()"), id:1, status:"scheduled", scheduledAt:"2099-12-31", regularDate:"2099-12-31" },
    { ...env.get("createEmptyInjection()"), id:2, status:"administered", administeredAt:"2026-10-08", administeredTime:"08:00", dose:2.5 },
  ];
  assert.equal(env.Backup.latestRecordDate(s), "2026-10-08");
});

test("R4: latestRecordDateが現在より古ければfreshness警告になる", () => {
  const env = loadEnv();
  const current = sampleState(env);
  current.proteinEntries.push({ ...current.proteinEntries[0], id:20, date:"2026-10-10" });
  const incoming = sampleState(env);
  const summary = env.Backup.summarize(incoming,current,7);
  assert.equal(summary.representative.current.latestRecordDate,"2026-10-10");
  assert.equal(summary.freshness.older,true);
  assert.ok(summary.freshness.reasons.some((x)=>x.includes("最後の記録日")));
});

test("R6: 利用開始または最後の書き出し操作から7日で案内対象", () => {
  const env = loadEnv();
  const s = sampleState(env);
  s.profile.startDate = "2026-10-01";
  assert.deepEqual(clone(env.Backup.backupReminder(s,null,new Date("2026-10-08T12:00:00"))),{due:true,days:7,basis:"startDate"});
  assert.equal(env.Backup.backupReminder(s,"2026-10-05T12:00:00Z",new Date("2026-10-10T12:00:00Z")).due,false);
});

test("R2: 新データ書き込み失敗で元データが残っている場合は同じ値を再書き込みしない", () => {
  const env = loadEnv();
  const old = sampleState(env);
  const oldRaw = JSON.stringify(old);
  env.ls.map.set(env.STORAGE_KEY,oldRaw);
  env.ls.setCalls.length = 0;
  env.ls.failSetKeys.add(env.STORAGE_KEY);
  const r = env.Backup.applyRestore(sampleState(env));
  assert.equal(r.ok,false);
  assert.equal(r.rolledBack,true);
  assert.equal(env.ls.getItem(env.STORAGE_KEY),oldRaw);
  assert.equal(env.ls.setCalls.filter((k)=>k===env.STORAGE_KEY).length,1);
});

test("R3: 本体ロールバック不能でもpreRestoreに復元前データが残れば救出可能", () => {
  const env = loadEnv();
  const old = sampleState(env); old.profile.startWeight = 68;
  const incoming = sampleState(env); incoming.profile.startWeight = 64;
  const oldRaw = JSON.stringify(old);
  env.ls.map.set(env.STORAGE_KEY,oldRaw);
  env.ls.map.set(env.Backup.PRE_RESTORE_KEY,JSON.stringify({schemaVersion:7,marker:"older"}));
  const realSet = env.ls.setItem.bind(env.ls);
  let first = true;
  env.ls.setItem = (k,v) => {
    if(k===env.STORAGE_KEY && String(v).includes('"startWeight":64') && first){first=false;env.ls.setCalls.push(k);env.ls.map.set(k,String(v)+" ");return;}
    if(k===env.STORAGE_KEY && String(v)===oldRaw){env.ls.setCalls.push(k);throw new Error("rollback failed");}
    return realSet(k,v);
  };
  const r = env.Backup.applyRestore(incoming);
  assert.equal(r.rolledBack,false);
  assert.equal(r.rescueAvailable,true);
  assert.equal(env.ls.getItem(env.Backup.PRE_RESTORE_KEY),oldRaw);
  assert.match(r.message,/救出できます/);
});

test("R3: preRestore一致を確認できないときは救出可能と言わない", () => {
  const env = loadEnv();
  env.Backup._preMatches = () => false;
  const old = sampleState(env); old.profile.startWeight = 68;
  const incoming = sampleState(env); incoming.profile.startWeight = 64;
  const oldRaw = JSON.stringify(old);
  env.ls.map.set(env.STORAGE_KEY,oldRaw);
  const realSet = env.ls.setItem.bind(env.ls);
  let first = true;
  env.ls.setItem = (k,v) => {
    if(k===env.STORAGE_KEY && String(v).includes('"startWeight":64') && first){first=false;env.ls.setCalls.push(k);env.ls.map.set(k,String(v)+" ");return;}
    if(k===env.STORAGE_KEY && String(v)===oldRaw){env.ls.setCalls.push(k);throw new Error("rollback failed");}
    return realSet(k,v);
  };
  const r = env.Backup.applyRestore(incoming);
  assert.equal(r.rescueAvailable,false);
  assert.doesNotMatch(r.message,/救出できます/);
  assert.match(r.message,/これ以上操作せず/);
});

test("R7相当: 共有とダウンロードを保存完了とは断定しない", () => {
  const { ui } = setupBackupUI();
  const share = ui._exportResultText({ok:true,method:"share",fileName:"a.json"});
  const dl = ui._exportResultText({ok:true,method:"download",fileName:"a.json"});
  assert.match(share,/受け渡し操作が完了/);
  assert.match(share,/保存完了までは確認できません/);
  assert.match(dl,/ダウンロードを開始/);
  assert.doesNotMatch(dl,/ダウンロードしました/);
});

test("R7相当: 手動テキスト表示だけではlastBackupAtを更新しない", () => {
  const { env, ui } = setupBackupUI();
  let n = 0;
  env.Backup.setLastBackupAt = () => n++;
  ui._showTextModal("{}");
  assert.equal(n,0);
});

test("R4 UI: 古い可能性がある復元は比較表示と確認チェックを要求する", () => {
  const { ui, t, events, els } = setupBackupUI();
  const result = {
    summary:{
      fileVersion:7,currentVersion:7,migrated:false,
      current:{dailyRecords:4,proteinEntries:2,conditionEntries:1,cycleEntries:1,injections:5,proteinProducts:1,registeredFoods:1},
      incoming:{dailyRecords:3,proteinEntries:2,conditionEntries:1,cycleEntries:1,injections:4,proteinProducts:1,registeredFoods:1},
      weightDays:{current:4,incoming:3},compositionDays:{current:2,incoming:1},range:{from:"2026-10-01",to:"2026-10-20"},
      representative:{
        current:{latestRecordDate:"2026-10-29",lastWeight:{date:"2026-10-29",value:65.4},lastInjection:{date:"2026-10-29"},stockRemaining:19},
        incoming:{latestRecordDate:"2026-10-22",lastWeight:{date:"2026-10-20",value:66},lastInjection:{date:"2026-10-22"},stockRemaining:20}
      },
      freshness:{older:true,reasons:["バックアップの最後の記録日が、現在より前です。"]}
    },
    envelope:{exportedAt:"2026-10-20T00:00:00Z"},warnings:[],state:{}
  };
  ui._showConfirm(result);
  assert.match(t.modal,/代表値の比較/);
  assert.match(t.modal,/最後の記録日/);
  assert.match(t.modal,/現在より古いデータへ戻る可能性/);
  assert.match(t.modal,/id="backup-confirm-ok" disabled/);
  const check = els.get("backup-stale-confirm");
  check.checked = true;
  events.get("backup-stale-confirm:change")();
  assert.equal(els.get("backup-confirm-ok").disabled,false);
});

test("restoreFailedUnknown: rollback不能かつ退避確認不能のときだけread-only", () => {
  const { env, ui } = setupBackupUI();
  env.Storage.readOnly = false;
  env.Backup.applyRestore = () => ({ok:false,rolledBack:false,rescueAvailable:false,message:"unknown"});
  ui._applyRestore({});
  assert.equal(env.Storage.readOnly,true);
  assert.equal(env.Storage.readOnlyReason,"restoreFailedUnknown");
});

test("restoreFailedUnknown: 救出確認済みまたはrollback済みならread-onlyにしない", () => {
  for(const result of [
    {ok:false,rolledBack:false,rescueAvailable:true,message:"rescue"},
    {ok:false,rolledBack:true,rescueAvailable:false,message:"rolled back"}
  ]){
    const { env, ui } = setupBackupUI();
    env.Storage.readOnly = false;
    env.Storage.readOnlyReason = null;
    env.Backup.applyRestore = () => result;
    ui._applyRestore({});
    assert.equal(env.Storage.readOnly,false);
    assert.notEqual(env.Storage.readOnlyReason,"restoreFailedUnknown");
  }
});

test("restoreFailedUnknown: 何も変更していない失敗（書き込み失敗以外）ではread-onlyにしない", () => {
  for(const result of [
    {ok:false,code:"PRE_RESTORE_FAILED",rolledBack:false,message:"pre failed"},
    {ok:false,code:"NEWER_STORED",rolledBack:false,message:"newer"},
    {ok:false,code:"STORAGE_UNAVAILABLE",rolledBack:false,message:"unavailable"}
  ]){
    const { env, ui } = setupBackupUI();
    env.Storage.readOnly = false;
    env.Storage.readOnlyReason = null;
    env.Backup.applyRestore = () => result;
    ui._applyRestore({});
    assert.equal(env.Storage.readOnly,false,result.code);
    assert.notEqual(env.Storage.readOnlyReason,"restoreFailedUnknown",result.code);
  }
});

test("設定画面: backup-noteと7日案内の表示文言を含む", () => {
  const { env, ui, els, UI } = setupBackupUI();
  const state = sampleState(env);
  UI.state = state;
  env.Backup.backupReminder = () => ({due:true,basis:"startDate",days:7});
  ui.render(state);
  const html = els.get("backup-root").innerHTML;
  assert.match(html,/「ファイル」アプリで保存を確認してください/);
  assert.match(html,/利用開始から7日以上/);
});
