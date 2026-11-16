// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian",()=>({
  Plugin:class {},PluginSettingTab:class {},Modal:class {},
  Setting:class {},Notice:class {},editorInfoField:null,
  requestUrl:vi.fn(),
  TFile:class TFile{constructor(path){this.path=path;this.stat={size:999,mtime:1}}}
}));
vi.mock("./live",()=>({NativeYjs:class {}}));
import Connector from "./main.ts";
import {TFile} from "obsidian";
const staleId="00000000-0000-4000-8000-123456789012";
function fixture(){
  const c=new Connector();
  const file=new TFile("Media/partial.mp4");
  const payload={opId:staleId,type:"create",path:file.path,
    contentBase64:Buffer.from("partial").toString("base64"),
    localHash:"a".repeat(64)};
  c.settings={
    vaultId:"QA",scope:"https://example.invalid|QA",pendingWrites:[payload],
    pending:[],baselines:{}
  };
  c.app={vault:{getAbstractFileByPath:p=>p===file.path?file:null}};
  c.canShare=()=>true;
  c.deviceRequest=vi.fn(async()=>({status:404}));
  c.api=vi.fn(async()=>({status:"abandoned",opId:staleId}));
  c.localHash=vi.fn(async()=>"b".repeat(64));
  c.persistSettings=vi.fn(async()=>{});
  c.sendOperation=vi.fn(async()=>{throw Error("Must never send partial bytes")});
  c.observeOperationReceipt=vi.fn();
  c.saveBase=vi.fn();
  return {c,file,payload};
}
describe("safe restart after a partial OS file copy",()=>{
  it("drops an obsolete staged payload only after durable server abandonment",async()=>{
    const {c}=fixture();
    await c.replayWrites();
    expect(c.settings.pendingWrites).toHaveLength(0);
    expect(c.queued).toBe(true);
    expect(c.persistSettings).toHaveBeenCalled();
    expect(c.sendOperation).not.toHaveBeenCalled();
  });
  it("does not discard the payload if the server cannot prove abandonment",async()=>{
    const {c}=fixture();
    c.api.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(c.replayWrites()).rejects.toThrow("Unavailable");
    expect(c.settings.pendingWrites).toHaveLength(1);
    expect(c.persistSettings).not.toHaveBeenCalled();
  });
  it("uses a committed receipt rather than abandoning a completed write",async()=>{
    const {c,payload}=fixture();
    c.api.mockResolvedValueOnce({status:"committed",receipt:{
      opId:payload.opId,type:"create",path:payload.path,
      fileId:"file",generationId:"generation",hash:payload.localHash,seq:1
    }});
    await c.replayWrites();
    expect(c.settings.pendingWrites).toHaveLength(0);
    expect(c.saveBase).toHaveBeenCalledOnce();
    expect(c.sendOperation).not.toHaveBeenCalled();
  });
});
