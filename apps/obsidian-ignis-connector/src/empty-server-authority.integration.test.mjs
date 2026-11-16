// @vitest-environment jsdom
// Real Ignis HTTP+SQLite server, native Connector reconciliation implementation,
// fresh server Vaults, isolated in-memory Obsidian Vault adapter. Production
// Vaults and OS-launchd services are never used.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import WebSocket from "ws";
import { randomBytes, createHash, webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import "fake-indexeddb/auto";

vi.mock("obsidian", () => ({
  Plugin: class {}, PluginSettingTab: class {}, Modal: class {},
  Setting: class {}, Notice: class {}, editorInfoField: null,
  TFile: class TFile {
    constructor(path, size) { this.path = path; this.stat = { size }; }
  },
  requestUrl: vi.fn(async ({url,method="GET",headers={},body}) => {
    const reply = await fetch(url, {method,headers,body});
    const arrayBuffer = await reply.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json = null;
    try { json = JSON.parse(text); } catch { /* Binary transport. */ }
    return {status:reply.status,arrayBuffer,text,json};
  })
}));
vi.mock("./live", () => ({ NativeYjs: class {} }));
import { TFile } from "obsidian";
import IgnisConnector from "./main.ts";

const root = resolve(".ignis-local-tools/empty-server-authority-20261110",`run-${process.pid}`);
const port = 38426;
const base = `http://127.0.0.1:${port}`;
const rootVault = join(root,"server-vaults");
const dataRoot = join(root,"server-state");
const vaults = ["BlankVault","OpenedOnlyVault","UnsavedDraftVault","StaleHistoryVault","NativeLiveVault","CheckpointVault","FoldersOnlyVault"];
let server;
let adminToken;
const devices = new Map();
const digest = value => createHash("sha256").update(value).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const until = async (probe,limit=10000) => {
  const end=Date.now()+limit;
  while (Date.now()<end) {
    const value=await probe();
    if (value) return value;
    await sleep(30);
  }
  throw Error("Timed out awaiting actual Yjs/HTTP convergence");
};
// jsdom deliberately lacks browser fetch: a minimal localhost-only native
// transport keeps this a real HTTP test without injecting a web shim.
function nodeFetch(url,{method="GET",headers={},body}={}) {
  if (!url.startsWith(base+"/")) throw Error("Test HTTP escaped isolated endpoint");
  return new Promise((resolve,reject) => {
    const req=http.request(url,{method,headers},response => {
      const chunks=[];
      response.on("data",chunk=>chunks.push(chunk));
      response.on("end",() => {
        const bytes=Buffer.concat(chunks);
        resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,
          json:async()=>JSON.parse(bytes.toString("utf8")),
          text:async()=>bytes.toString("utf8"),
          arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
      });
    });
    req.once("error",reject);
    if (body) req.write(body);
    req.end();
  });
}

async function api(vault, path) {
  const response = await fetch(`${base}/api/sync/v1/vaults/${vault}/${path}`, {
    headers: {Authorization:`Bearer ${devices.get(vault).token}`}
  });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function sourceVault(data, openPaths = []) {
  const files = new Map(Object.entries(data).map(([path,content]) =>
    [path, {file:new TFile(path,Buffer.byteLength(content)),content}]));
  const open = new Set(openPaths);
  const editorTexts = new Map(openPaths.map(path => [path,data[path]]));
  return {
    getFiles:() => [...files.values()].map(entry => entry.file),
    getAbstractFileByPath:path => files.get(path)?.file || null,
    read:async file => files.get(file.path)?.content,
    readBinary:async file => {
      const buf = Buffer.from(files.get(file.path)?.content || "");
      return buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
    },
    adapter: { stat:async path => ({size:files.get(path)?.file.stat.size||0,mtime:1}) },
    opened: open,
    editorTexts,
    files,
    original: new Map([...files].map(([path,entry]) => [path,digest(entry.content)]))
  };
}

function connector(vault, local) {
  const plugin = new IgnisConnector();
  plugin.settings = {
    serverUrl:base,authMode:"device",vaultId:vault,
    deviceId:devices.get(vault).deviceId,scope:`${base}|${vault}`,
    contentScope:"all",deviceContentScope:"follow-server",
    serverMediaBypassExtensions:[],deviceMediaBypassExtensions:[],
    baselines:{},cursor:0,tombstoneProofs:{},pending:[],pendingWrites:[],
    yjsIds:{},syncIssues:[],undoReviews:[],migrations:{},archivedScopes:[],
    applyRemoteDeletes:false
  };
  plugin.token = devices.get(vault).token;
  plugin.rebuildFileScope();
  plugin.status = {setText:vi.fn()};
  plugin.app = {vault:local,workspace:{
    getLeavesOfType:() => [...local.opened].map(path => ({view:{file:{path},
      editor:{getValue:() => local.editorTexts.get(path)}}})),
    getActiveFile:() => null
  }};
  plugin.live = {
    isManaged:path => local.opened.has(path),blockingPaths:() => [],
    disconnected:vi.fn(),connected:vi.fn(),
    rejoinPath:vi.fn(),
    saveState:() => ({online:true,active:local.opened.size,
      awaitingServer:0,reconnecting:local.opened.size,blocked:0})
  };
  plugin.saveData = vi.fn(async snapshot => {
    writeFileSync(join(root,`connector-${vault}-settings.json`),JSON.stringify(snapshot));
  });
  plugin.schedule = vi.fn();
  return plugin;
}

beforeAll(async () => {
  Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
  globalThis.fetch=nodeFetch;
  globalThis.ResizeObserver ||= class {
    observe() {} unobserve() {} disconnect() {}
  };
  mkdirSync(root,{recursive:true});
  for (const vault of vaults) mkdirSync(join(rootVault,vault),{recursive:true});
  mkdirSync(dataRoot,{recursive:true});
  adminToken = randomBytes(48).toString("base64url");
  const logFd = openSync(join(root,"server-log.txt"),"a",0o600);
  server = spawn(process.execPath,[resolve("apps/ignis-server/server/index.js")],{
    cwd:process.cwd(),
    env:{...process.env,PORT:String(port),IGNIS_BIND_HOST:"127.0.0.1",
      VAULT_ROOT:rootVault,DATA_ROOT:dataRoot,AUTO_CREATE_DEFAULT:"false",
      IGNIS_SYNC_TOKEN:adminToken,
      WS_ORIGINS:base,
      OBSIDIAN_ASSETS_PATH:join(process.env.HOME,"Library/Application Support/Obsidian-WebUI/obsidian-app")},
    stdio:["ignore",logFd,logFd]
  });
  closeSync(logFd);
  let running = false;
  for (let i=0;i<120;i++) {
    if (server.exitCode !== null) break;
    try { const response=await fetch(`${base}/api/version`,{signal:AbortSignal.timeout(300)});
      if (response.ok) {running=true;break;} } catch { /* startup */ }
    await sleep(150);
  }
  if (!running) throw Error("Isolated fresh-server startup failed");
  for (const vault of vaults) {
    const initial = await fetch(`${base}/api/sync/v1/vaults/${vault}/manifest`,{
      headers:{Authorization:`Bearer ${adminToken}`}});
    expect(initial.status).toBe(401); // Bootstrap token is NOT a device token.
    const response = await fetch(`${base}/api/sync/v1/admin/vaults/${vault}/devices`,{
      method:"POST",headers:{Authorization:`Bearer ${adminToken}`,
        "Content-Type":"application/json"},body:JSON.stringify({label:"Empty-authority test"})
    });
    expect(response.status).toBe(201);
    devices.set(vault,await response.json());
    const manifest=await api(vault,"manifest");
    expect(manifest.files).toEqual([]);
    expect(manifest.vaultSeq).toBe(0);
  }
},30000);

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => server.once("exit",resolve)),
    sleep(20000).then(() => { throw Error("QA server did not exit gracefully"); })
  ]);
},25000);

describe.sequential("only Connector has the correct data; Ignis server starts empty",() => {
  it("does not claim empty local folders were replicated, while keeping excluded Obsidian configuration out of the count",async()=>{
    const local=sourceVault({});
    local.getAllLoadedFiles=()=>[
      {path:"KeepThisStructure",children:[]},
      {path:".obsidian",children:[]},
      {path:"Nonempty",children:[{path:"Nonempty/note.md"}]}
    ];
    const p=connector("FoldersOnlyVault",local);
    await p.syncNow();
    expect((await api("FoldersOnlyVault","manifest")).files).toHaveLength(0);
    expect(p.getSharingDetails().emptyFolders).toBe(1);
    expect(p.status.setText.mock.lastCall[0])
      .toContain("1 empty folder remains local (not shared)");
  });
  it("uploads all closed originals, including nested, Japanese and zero-byte notes; verifies journal and idempotence",async () => {
    const contents = {
      "Notes/日本語.md":"接続開始前から存在する唯一の正本。\n漢字と絵文字🌱。\n",
      "Notes/Sub/long.md":"# Stable original\n\nThis note existed before the server.\n",
      "Empty.md":"",
      "README.md":"# Connector sole authority\n",
      "Media/device-payload.bin":"BINARY_PAYLOAD_UNDER_4_MiB"
    };
    const local=sourceVault(contents);
    const p=connector("BlankVault",local);
    await p.syncNow();
    await p.syncNow();
    const manifest=await api("BlankVault","manifest");
    expect(manifest.files.map(f=>f.path).sort()).toEqual(Object.keys(contents).sort());
    for (const [path,body] of Object.entries(contents)) {
      const remote=manifest.files.find(f=>f.path===path);
      expect(remote.hash).toBe(digest(body));
      expect(p.settings.baselines[path].fileId).toBe(remote.fileId);
      expect(local.original.get(path)).toBe(digest(body));
      expect(await (await fetch(`${base}/api/fs/readFile?`+new URLSearchParams({vault:"BlankVault",path}))).text()).toBe(body);
    }
    expect(p.settings.pendingWrites).toEqual([]);
    expect(p.settings.pending).toEqual([]);
    expect(p.settings.syncIssues).toEqual([]);
    expect(p.status.setText).toHaveBeenLastCalledWith("Ignis: Synced · server acknowledged");
    // Web uses a separately cached metadata tree. The uploaded source must
    // become discoverable there, not merely in the Sync journal.
    const webTree=await until(async()=>{
      const response=await nodeFetch(`${base}/api/fs/tree?vault=BlankVault`);
      if(!response.ok)return null;
      const data=await response.json();
      const text=JSON.stringify(data);
      return text.includes("日本語.md") && text.includes("device-payload.bin")?data:null;
    });
    expect(JSON.stringify(webTree)).toContain("long.md");
    const beforeSeq=manifest.vaultSeq;
    await p.syncNow();
    expect((await api("BlankVault","manifest")).vaultSeq).toBe(beforeSeq);
    expect(p.settings.pendingWrites).toEqual([]);
    writeFileSync(join(root,"closed-files-verdict.json"),JSON.stringify({
      pass:true,webTreeVisible:true,paths:manifest.files.map(f=>f.path),
      seq:beforeSeq,hashes:manifest.files.map(f=>f.hash)
    },null,2));
  });

  it("rejects a stale journal CAS before committing the queued operation, while preserving opId receipt compatibility",async()=>{
    const vault="BlankVault";
    const before=await api(vault,"manifest");
    const body={type:"create",opId:"journal-cas-verify-op-20261110",
      path:"CAS-Gate.md",content:"A protected, durable original.\n"};
    const post=async lineage=>{
      const reply=await nodeFetch(`${base}/api/sync/v1/vaults/${vault}/operations`,{
        method:"POST",headers:{Authorization:"Bearer "+devices.get(vault).token,
          "Content-Type":"application/json",
          ...(lineage?{"X-Ignis-Journal-Lineage":lineage}:{})},
        body:JSON.stringify(body)
      });
      return {status:reply.status,json:await reply.json()};
    };
    const wrong=await post("00000000-0000-4000-8000-000000000099");
    expect(wrong.status).toBe(409);
    expect(wrong.json.code).toBe("JOURNAL_LINEAGE_MISMATCH");
    expect((await api(vault,"manifest")).files.some(f=>f.path===body.path)).toBe(false);
    const allowed=await post(before.journalLineage);
    expect(allowed.status).toBe(200);
    expect(allowed.json.path).toBe(body.path);
    // The lineage precondition is outside the canonical operation body. An
    // existing old-format receipt can be read back with the same opId and
    // payload without generating a different request hash.
    const replay=await post(undefined);
    expect(replay).toEqual(allowed);
    const after=await api(vault,"manifest");
    expect(after.files.find(f=>f.path===body.path).hash).toBe(digest(body.content));
    expect(after.vaultSeq).toBe(before.vaultSeq+1);
  });

  it("uploads a verified open native original, then retries the Yjs JOIN for that file generation",async () => {
    const contents={"OpenWhileConnecting.md":"# My only source, already open in Obsidian\n"};
    const local=sourceVault(contents,["OpenWhileConnecting.md"]);
    const p=connector("OpenedOnlyVault",local);
    await p.syncNow();
    await p.syncNow();
    const manifest=await api("OpenedOnlyVault","manifest");
    const status=p.status.setText.mock.lastCall?.[0]||"";
    writeFileSync(join(root,"open-file-verdict.json"),JSON.stringify({
      serverFiles:manifest.files.map(f=>f.path),status,
      pending:p.settings.pendingWrites.length,issues:p.settings.syncIssues,
      sourceSHA:digest(contents["OpenWhileConnecting.md"])
    },null,2));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].hash).toBe(digest(contents["OpenWhileConnecting.md"]));
    expect(p.live.rejoinPath).toHaveBeenCalledWith("OpenWhileConnecting.md");
    expect(status).not.toContain("Synced · server acknowledged");
    expect(local.original.get("OpenWhileConnecting.md"))
      .toBe(digest(contents["OpenWhileConnecting.md"]));
  });

  it("does not publish the stale disk bytes of an unsaved open editor",async () => {
    const path="DraftWhileConnecting.md";
    const saved="Earlier filesystem state.\n";
    const draft="Earlier filesystem state.\nNew uncommitted thought.\n";
    const local=sourceVault({[path]:saved},[path]);
    local.editorTexts.set(path,draft);
    const p=connector("UnsavedDraftVault",local);
    await p.syncNow();
    const before=await api("UnsavedDraftVault","manifest");
    expect(before.files).toHaveLength(0);
    expect(p.settings.syncIssues).toEqual([{
      path,reason:"Open editor has uncommitted or unverified text; local original retained"
    }]);
    expect(p.status.setText.mock.lastCall[0]).toContain("needs review");
    expect(local.files.get(path).content).toBe(saved);
    // Obsidian saves the editor buffer, after which that exact source may be
    // seeded without discarding either the previous on-disk or live state.
    local.files.get(path).content=draft;
    local.files.get(path).file.stat.size=Buffer.byteLength(draft);
    await p.syncNow();
    await p.syncNow();
    const after=await api("UnsavedDraftVault","manifest");
    expect(after.files).toHaveLength(1);
    expect(after.files[0].hash).toBe(digest(draft));
    expect(p.settings.pendingWrites).toHaveLength(0);
  });

  it("recovers an actual CM6/Yjs JOIN rejected by the initially empty server",async () => {
    const {NativeYjs} = await vi.importActual("./live.ts");
    const path="NativeOnly.md";
    const initial="# Native Connector is the first source\n";
    const appended="First shared Yjs edit after seeding.\n";
    const local=sourceVault({[path]:initial},[path]);
    const p=connector("NativeLiveVault",local);
    const ids={};
    const notifications=[];
    const sentTypes=[];
    const wireTypes=[];
    let ws;
    let received=Promise.resolve();
    let readyCallback;
    const authenticated=new Promise(resolve=>{readyCallback=resolve});
    const native=new NativeYjs({
      vaultId:()=>"NativeLiveVault",origin:()=>base,
      pathForView:()=>path,knownId:()=>ids[path]||null,
      fileBaseline:()=>p.settings.baselines[path]||null,
      rememberId:async (_path,id)=>{ids[path]=id;p.settings.yjsIds[path]=id;},
      send:message=>{sentTypes.push(message.type);if(ws?.readyState===WebSocket.OPEN)
        ws.send(JSON.stringify(message));},
      notify:(_path,status)=>notifications.push(status)
    });
    const container=document.createElement("div");
    document.body.appendChild(container);
    const editor=new EditorView({parent:container,
      state:EditorState.create({doc:initial,extensions:native.extension()})});
    p.live=native;
    p.app.workspace.getLeavesOfType=()=>[{
      view:{file:{path},editor:{getValue:()=>editor.state.doc.toString()}}
    }];
    try {
      ws=new WebSocket(`ws://127.0.0.1:${port}/ws?vault=NativeLiveVault`,{
        headers:{Origin:base}
      });
      ws.on("message",raw=>{
        const msg=JSON.parse(raw.toString());
        wireTypes.push({channel:msg.channel,type:msg.type,error:msg.error||null});
        if(msg.channel==="sync"&&msg.type==="ready")readyCallback();
        if(msg.channel==="collab")received=received.then(()=>native.handle(msg));
      });
      await new Promise((resolve,reject)=>{
        ws.once("open",resolve);ws.once("error",reject);
      });
      ws.send(JSON.stringify({channel:"sync",type:"auth",
        token:devices.get("NativeLiveVault").token}));
      await authenticated;
      native.connected();
      // The server has no file and therefore cannot JOIN this editor yet.
      await until(()=>notifications.some(status=>status.includes("Note not found")),2500)
        .catch(()=>{throw Error("Initial JOIN diagnostic: "+JSON.stringify({
          sentTypes,wireTypes,notifications,rooms:[...native.rooms.keys()],
          online:native.online
        }));});
      expect(native.rooms.get(path)?.joined).not.toBe(true);
      expect((await api("NativeLiveVault","manifest")).files).toHaveLength(0);
      await p.syncNow();
      await until(()=>native.rooms.get(path)?.joined===true);
      expect(editor.state.doc.toString()).toBe(initial);
      expect(p.settings.yjsIds[path]).toMatch(/^[a-f0-9-]{36}$/);
      const before=await api("NativeLiveVault","manifest");
      expect(before.files[0].hash).toBe(digest(initial));
      editor.dispatch({changes:{from:editor.state.doc.length,insert:appended}});
      await until(async()=>{
        const served=await nodeFetch(`${base}/api/fs/readFile?`+
          new URLSearchParams({vault:"NativeLiveVault",path}));
        return await served.text()===initial+appended;
      });
      // Filesystem projection and SQLite journal may be observed on different
      // ticks; only an agreed manifest SHA proves the save is fully indexed.
      const after=await until(async()=>{
        const manifest=await api("NativeLiveVault","manifest");
        return manifest.files[0]?.hash===digest(initial+appended)?manifest:null;
      });
      expect(after.files[0].hash).toBe(digest(initial+appended));
      const room=native.rooms.get(path);
      await until(()=>room.savedSeq>=room.sentSeq);
      writeFileSync(join(root,"real-cm6-join-verdict.json"),JSON.stringify({
        pass:true,initiallyRejected:true,joined:room.joined,
        serverHash:after.files[0].hash,canonicalBytes:initial.length+appended.length,
        savedSeq:room.savedSeq,sentSeq:room.sentSeq,documentId:room.documentId
      },null,2));
    } finally {
      editor.destroy();
      await native.dispose();
      ws?.close();
      container.remove();
    }
  },20000);

  it("retains prior tracked originals when the same server identity has lost its history",async () => {
    const path="LongTermOriginal.md", source="Previously committed local original.\n";
    const local=sourceVault({[path]:source});
    const p=connector("StaleHistoryVault",local);
    p.settings.cursor=8;
    p.settings.baselines[path]={fileId:"previous-file",generationId:"previous-generation",
      hash:digest(source),revision:1};
    p.settings.yjsIds[path]="previous-generation";
    await p.syncNow();
    expect((await api("StaleHistoryVault","manifest")).files).toHaveLength(0);
    expect(p.settings.syncIssues).toEqual([{
      path,reason:"Server journal identity requires review; local original retained"
    }]);
    expect(p.status.setText.mock.lastCall[0]).toContain("Server history is behind");
    expect(p.settings.cursor).toBe(8);
    expect(local.files.get(path).content).toBe(source);
    expect(p.settings.baselines[path].hash).toBe(digest(source));
    // Rollback detection must run before old queued writes or renames can be
    // replayed to the new journal, including with remote delete opt-in.
    const queued=connector("StaleHistoryVault",local);
    queued.settings.cursor=8;
    queued.settings.baselines[path]={...p.settings.baselines[path]};
    queued.settings.applyRemoteDeletes=true;
    queued.settings.pendingWrites=[{
      opId:"old-generation-queued-create",type:"create",path:"Unsent.md",
      content:"old queued content",localHash:digest("old queued content")
    }];
    queued.replayWrites=vi.fn(async()=>{throw Error("Old write replay must not run");});
    queued.replayPending=vi.fn(async()=>{throw Error("Old rename replay must not run");});
    await queued.syncNow();
    expect(queued.replayWrites).not.toHaveBeenCalled();
    expect(queued.replayPending).not.toHaveBeenCalled();
    expect(queued.settings.pendingWrites).toHaveLength(1);
    expect((await api("StaleHistoryVault","manifest")).files).toHaveLength(0);
    // An ACKed local generation can exist while the last manifest cursor is
    // still zero. The empty new server must not be accepted as a fresh peer.
    const zeroCursor=connector("StaleHistoryVault",local);
    zeroCursor.settings.baselines[path]={...p.settings.baselines[path]};
    await zeroCursor.syncNow();
    expect(zeroCursor.status.setText.mock.lastCall[0]).toContain("cannot be verified");
    writeFileSync(join(root,"lost-server-history-verdict.json"),JSON.stringify({
      localKept:true,automaticReseed:false,queuedWriteRetained:true,
      cursorZeroWithBaselineProtected:true,needsReview:true,sourceSHA:digest(source)
    },null,2));
  });

  it("checks the old journal frontier before replay and recovers after verification",async()=>{
    const local=sourceVault({"Original.md":"Only the native client knew this.\n"});
    const p=connector("CheckpointVault",local);
    await p.syncNow();
    // First pass deliberately holds the pre-create frontier and reports
    // "Confirming recent server writes". The next manifest acknowledges it.
    await p.syncNow();
    const trusted=await api("CheckpointVault","manifest");
    expect(trusted.vaultSeq).toBe(1);
    expect(p.settings.journalProof).toBe(trusted.headProof);
    expect(p.settings.journalLineage).toBe(trusted.journalLineage);
    // A second author advances the actual server journal. The first device
    // must verify its prior operation at seq=1, not compare the latest head.
    const added=await nodeFetch(`${base}/api/sync/v1/vaults/CheckpointVault/operations`,{
      method:"POST",headers:{Authorization:`Bearer ${devices.get("CheckpointVault").token}`,
        "Content-Type":"application/json"},body:JSON.stringify({
          type:"create",opId:"other-author-first-123",path:"Other.md",
          content:"Another desktop has an independent note.\n"
        })
    });
    expect(added.ok).toBe(true);
    const ahead=await api("CheckpointVault","manifest");
    expect(ahead.vaultSeq).toBe(2);
    expect(await p.verifyJournal(ahead,1)).toBe(true);
    expect((await api("CheckpointVault","checkpoint?seq=1")).proof)
      .toBe(trusted.headProof);
    const conditional={type:"create",opId:"checkpoint-guard-12345678",
      path:"OnlyAfterProof.md",content:"A mutation requiring the exact history.\n"};
    const conditionalHeaders={Authorization:`Bearer ${devices.get("CheckpointVault").token}`,
      "Content-Type":"application/json",
      "X-Ignis-Journal-Lineage":trusted.journalLineage,
      "X-Ignis-Journal-Cursor":"1",
      "X-Ignis-Journal-Proof":"f".repeat(64)};
    const rejected=await nodeFetch(`${base}/api/sync/v1/vaults/CheckpointVault/operations`,{
      method:"POST",headers:conditionalHeaders,body:JSON.stringify(conditional)
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("JOURNAL_CHECKPOINT_MISMATCH");
    expect((await api("CheckpointVault","manifest")).files.some(f=>
      f.path===conditional.path)).toBe(false);
    // An identical immutable operation ID is still usable with the correct
    // checkpoint: the rejected attempt did not commit an operation receipt.
    const accepted=await nodeFetch(`${base}/api/sync/v1/vaults/CheckpointVault/operations`,{
      method:"POST",headers:{...conditionalHeaders,
        "X-Ignis-Journal-Proof":trusted.headProof},
      body:JSON.stringify(conditional)
    });
    expect(accepted.ok).toBe(true);
    expect((await api("CheckpointVault","manifest")).files.some(f=>
      f.path===conditional.path)).toBe(true);
    // Simulate a journal fork by presenting a different already-pinned
    // checkpoint while retaining the same server epoch and sequence.
    const pending={opId:"held-operation-123",path:"Queued.md",type:"create",
      content:"Do not ship to the fork",localHash:digest("Do not ship to the fork")};
    p.settings.pendingWrites.push(pending);
    p.settings.journalProof="f".repeat(64);
    p.replayWrites=vi.fn(async()=>{throw Error("Queued replay must not run");});
    await p.syncNow();
    expect(p.replayWrites).not.toHaveBeenCalled();
    expect(p.settings.pendingWrites).toEqual([pending]);
    expect(p.journalRecoveryInfo()?.explanation).toMatch(/different operations/);
    expect(p.status.setText.mock.lastCall[0]).toContain("Server history diverged");
    p.settings.journalProof=trusted.headProof;
    p.connectSocket=vi.fn();
    expect((await p.recheckJournal()).ok).toBe(true);
    expect(p.journalRecoveryInfo()).toBeNull();
    expect(p.settings.pendingWrites).toEqual([pending]);
    writeFileSync(join(root,"checkpoint-ux-verdict.json"),JSON.stringify({
      pass:true,otherAuthorAdvanced:true,checkpointProved:true,
      serverCasRejectedDivergence:true,originalOpIdReusable:true,
      forkBlocked:true,queuePreserved:true,recheckRecovered:true
    },null,2));
  });
});
