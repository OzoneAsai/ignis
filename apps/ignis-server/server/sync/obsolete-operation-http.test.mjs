import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createRequire } from "node:module";

const require=createRequire(import.meta.url);
const { VaultSyncStore }=require("./store.js");
const { createSyncRouter }=require("./http.js");
const ADMIN="a".repeat(48);
const handles=[];

async function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ignis-obsolete-op-"));
  const vault=path.join(root,"vault");
  fs.mkdirSync(vault);
  const createStore=()=>new VaultSyncStore({
    dataRoot:root,getVaultPath:(id)=>id==="qa"?vault:null,
    collaboration:{
      isCollaborative:()=>false,
      getActive:()=>null,
      checkLivePath:()=>{},
      renameNote:async(_id,_a,_b,f)=>f(),
      deleteNote:async(_id,_p,f)=>f()
    },writeCoalescer:{flushPending:async()=>{}}
  });
  const store=createStore();
  const {token}=store.enrollDevice("qa","real-device");
  const app=express();
  app.use(express.json({limit:"8mb"}));
  app.use("/api/sync/v1",createSyncRouter({store,token:ADMIN}));
  const http=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>http.once("listening",resolve));
  const base="http://127.0.0.1:"+http.address().port+
    "/api/sync/v1/vaults/qa";
  const call=async(endpoint,body)=>fetch(base+endpoint,{
    method:"POST",headers:{"Content-Type":"application/json",
      Authorization:"Bearer "+token},body:JSON.stringify(body||{})
  });
  handles.push({store,http,root});
  return {store,root,vault,call,createStore};
}
afterEach(async()=>{
  for(const {store,http,root} of handles.splice(0)) {
    await new Promise(resolve=>http.close(resolve));
    store.close();
    fs.rmSync(root,{force:true,recursive:true});
  }
});

describe("durable abandonment of superseded snapshots",()=>{
  it("records a negative receipt; a late immutable POST cannot create stale bytes",async()=>{
    const {store,call,vault}=await fixture();
    const opId="obsolete-file-write-0001";
    const endpoint="/operations/"+opId+"/abandon";
    const first=await call(endpoint);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({status:"abandoned",opId});
    const second=await call(endpoint);
    expect(await second.json()).toEqual({status:"abandoned",opId});
    const late=await call("/operations",{
      opId,type:"create",path:"partial.mp4",
      contentBase64:Buffer.from("partial media bytes").toString("base64")
    });
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("OPERATION_ABANDONED");
    expect(store.operationReceipt("qa",opId)).toBeNull();
    expect(fs.existsSync(path.join(vault,"partial.mp4"))).toBe(false);
  });

  it("if the POST already committed, abandonment returns the original receipt",async()=>{
    const {store,call,vault}=await fixture();
    const opId="already-committed-op-1234";
    const payload={opId,type:"create",path:"good.pdf",
      contentBase64:Buffer.from("full media").toString("base64")};
    const write=await call("/operations",payload);
    expect(write.status).toBe(200);
    const receipt=await write.json();
    const abandon=await call("/operations/"+opId+"/abandon");
    expect(await abandon.json()).toEqual({status:"committed",receipt});
    expect(fs.readFileSync(path.join(vault,"good.pdf"),"utf8"))
      .toBe("full media");
    const replay=await call("/operations",payload);
    expect(await replay.json()).toEqual(receipt);
    expect(store.changes("qa",0).changes).toHaveLength(1);
  });

  it("serializes an incoming POST against abandonment regardless of ordering",async()=>{
    const {store,call,vault}=await fixture();
    for(let i=0;i<5;i++) {
      const opId="race-obsolete-"+String(i).padStart(10,"0");
      const request={opId,type:"create",path:"race-"+i+".png",
        contentBase64:Buffer.from("bytes-"+i).toString("base64")};
      const [write,abort]=await Promise.all([
        call("/operations",request),
        call("/operations/"+opId+"/abandon")
      ]);
      const decision=await abort.json();
      expect([200,409]).toContain(write.status);
      if(write.status===200) {
        expect(decision.status).toBe("committed");
        expect(store.operationReceipt("qa",opId)).not.toBeNull();
      } else {
        expect(decision.status).toBe("abandoned");
        expect(fs.existsSync(path.join(vault,request.path))).toBe(false);
      }
    }
  });
});
