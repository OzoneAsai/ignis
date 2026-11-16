import {describe,expect,it} from "vitest";
import * as Y from "yjs";
import {hasMissingYjsAncestors,causalRepairDelay} from "./causal-history.js";

describe("shared Yjs causal ancestry status",()=>{
  it("detects a syntactically valid update whose causal ancestor is missing",()=>{
    const server=new Y.Doc(),local=new Y.Doc();
    const fragments=[];
    server.getText("content").insert(0,"baseline");
    Y.applyUpdate(local,Y.encodeStateAsUpdate(server));
    server.on("update",frame=>fragments.push(frame));
    server.getText("content").insert(8," first");
    server.getText("content").insert(14," second");
    Y.applyUpdate(local,fragments[1]);
    expect(hasMissingYjsAncestors(local)).toBe(true);
    expect(local.getText("content").toString()).toBe("baseline");
    Y.applyUpdate(local,Y.encodeStateAsUpdate(server));
    expect(hasMissingYjsAncestors(local)).toBe(false);
    expect(local.getText("content").toString()).toBe(server.getText("content").toString());
    server.destroy();local.destroy();
  });
  it("backs off under a finite upper bound rather than endlessly respawning",()=>{
    expect([0,1,2,3,4].map(causalRepairDelay)).toEqual([240,480,960,1920,2400]);
  });
});
