import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require=createRequire(import.meta.url);
const {VaultSyncStore}=require("./store");

function sandbox() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ignis-checkpoint-"));
  const vault=path.join(dir,"vault");
  fs.mkdirSync(vault);
  const options={dataRoot:dir,getVaultPath:id=>id==="vault"?vault:null,
    collaboration:{getActive:()=>null,peekDocumentId:()=>null,
      isCollaborative:()=>false,checkLivePath:()=>{},
      renameNote:async(_id,_from,_to,fn)=>fn(),
      deleteNote:async(_id,_rel,fn)=>fn()},
    writeCoalescer:{flushPending:async()=>{}}};
  const stores=[];
  const open=()=>{const store=new VaultSyncStore(options);stores.push(store);return store;};
  const close=store=>{store.close();stores.splice(stores.indexOf(store),1);};
  const finish=()=>{for(const store of stores.reverse())store.close();
    fs.rmSync(dir,{recursive:true,force:true});};
  return {open,close,vault,finish};
}

describe("one durable Sync journal checkpoint after restoration",()=>{
  it("has an indexed, restart-stable genesis and per-event proof",async()=>{
    const s=sandbox();
    try {
      const first=s.open();
      const empty=first.journalCheckpoint("vault",0);
      expect(empty.proof).toMatch(/^[a-f0-9]{64}$/);
      expect((await first.scan("vault")).headProof).toBe(empty.proof);
      fs.writeFileSync(path.join(s.vault,"A.md"),"only Connector A had this file");
      const a=await first.scan("vault");
      expect(a.vaultSeq).toBe(1);
      expect(a.headProof).toBe(first.journalCheckpoint("vault",1).proof);
      const witnessA=a.headProof;
      fs.writeFileSync(path.join(s.vault,"B.md"),"another author later");
      const b=await first.scan("vault");
      expect(b.vaultSeq).toBe(2);
      expect(b.headProof).not.toBe(witnessA);
      expect(first.journalCheckpoint("vault",1).proof).toBe(witnessA);
      expect(first.journalCheckpoint("vault",9).proof).toBeNull();
      s.close(first);
      const newer=s.open();
      expect(newer.journalCheckpoint("vault",0)).toEqual(empty);
      expect(newer.journalCheckpoint("vault",1).proof).toBe(witnessA);
      expect(newer.journalCheckpoint("vault",2).proof).toBe(b.headProof);
    } finally {s.finish();}
  });

  it("detects a fork that reuses the same lineage and sequence",async()=>{
    const s=sandbox();
    try {
      const store=s.open();
      fs.writeFileSync(path.join(s.vault,"note.md"),"first operation");
      await store.scan("vault");
      const baseline=store.journalCheckpoint("vault",1);
      // A different operation at the same sequence models a restored old
      // SQLite snapshot followed by new writes under the old epoch UUID.
      store.db.prepare("UPDATE changes SET op_id=? WHERE vault_id=? AND seq=?")
        .run("other-operation", "vault", 1);
      const fork=store.journalCheckpoint("vault",1);
      expect(fork.journalLineage).toBe(baseline.journalLineage);
      expect(fork.seq).toBe(baseline.seq);
      expect(fork.proof).not.toBe(baseline.proof);
    } finally {s.finish();}
  });
});
