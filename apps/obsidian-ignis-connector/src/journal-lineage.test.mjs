import { describe, it, expect } from "vitest";
import { assessJournalTrust, journalProofMatches,
  journalHoldMessage, journalHoldExplanation } from "./journal-lineage.ts";

const A="00000000-0000-4000-8000-000000000011";
const B="00000000-0000-4000-8000-000000000022";
const base={ pinnedLineage:A,remoteLineage:A,cursor:12,remoteSeq:12,
  tracked:[{path:"Note.md",fileId:"f1",generationId:"g1"}],
  liveGenerations:[],remoteFiles:[{path:"Note.md",fileId:"f1",generationId:"g1"}] };

describe("one journal ancestry model across live and REST connections",()=>{
  it("trusts a stable lineage across reconnect even after unrelated concurrent files change",()=>{
    expect(assessJournalTrust({...base,remoteSeq:26,remoteFiles:[]}))
      .toEqual({state:"trusted",lineage:A,newlyPinned:false});
  });
  it("refuses a different history even with identical URL, sequence, file path and bytes",()=>{
    expect(assessJournalTrust({...base,remoteLineage:B}))
      .toEqual({state:"hold",reason:"changed"});
  });
  it("rejects restoring an older backup of the same lineage until its journal catches up",()=>{
    expect(assessJournalTrust({...base,remoteSeq:11}))
      .toEqual({state:"hold",reason:"behind"});
  });
  it("pins a fresh never-synced Vault, including a locally queued first operation",()=>{
    expect(assessJournalTrust({...base,pinnedLineage:"",cursor:0,tracked:[],
      remoteSeq:0,remoteFiles:[]}))
      .toEqual({state:"trusted",lineage:A,newlyPinned:true});
  });
  it("requires real file or Yjs generation identity when upgrading an existing Connector",()=>{
    expect(assessJournalTrust({...base,pinnedLineage:""}))
      .toEqual({state:"trusted",lineage:A,newlyPinned:true});
    expect(assessJournalTrust({...base,pinnedLineage:"",remoteSeq:50,
      remoteFiles:[{path:"Note.md",fileId:"other",generationId:"other"}]}))
      .toEqual({state:"hold",reason:"legacy-unproven"});
    expect(assessJournalTrust({...base,pinnedLineage:"",tracked:[],cursor:2,
      liveGenerations:["g1"]}))
      .toEqual({state:"trusted",lineage:A,newlyPinned:true});
  });
  it("does not mistake a new journal with higher sequence for the original history",()=>{
    expect(assessJournalTrust({...base,remoteLineage:B,remoteSeq:200}))
      .toEqual({state:"hold",reason:"changed"});
  });
  it("verifies a historical operation proof after same-epoch rollback and catch-up",()=>{
    const first="a".repeat(64);
    expect(journalProofMatches(first,first)).toBe(true);
    expect(journalProofMatches(first,"b".repeat(64))).toBe(false);
    expect(journalProofMatches(first,null)).toBe(false);
    expect(journalProofMatches("not-a-checkpoint",first)).toBe(false);
    expect(journalHoldMessage("diverged")).toMatch(/paused/);
    expect(journalHoldExplanation("diverged")).toMatch(/different operations/);
  });
  it("uses descriptive, actionable states for missing server support and legacy uncertainty",()=>{
    expect(assessJournalTrust({...base,remoteLineage:undefined}))
      .toEqual({state:"hold",reason:"unsupported"});
    for (const reason of ["changed","behind","unsupported","legacy-unproven"]){
      expect(journalHoldMessage(reason)).toMatch(/local notes retained|local notes retained/i);
      expect(journalHoldExplanation(reason)).toMatch(/server|Vault/i);
    }
  });
});
