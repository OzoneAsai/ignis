import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  encodeCursorSelections as webEncode,
  resolveCursorSelections as webResolve
} from "./collab-cursor-protocol.js";
import {
  encodeSelections as nativeEncode,
  resolveSelections as nativeResolve,
  sanitizeCursorMessage,
  sanitizePeers
} from "../../../apps/obsidian-ignis-connector/src/presence.ts";

function twoSites(content) {
  const webDoc = new Y.Doc();
  const webText = webDoc.getText("content");
  webText.insert(0, content);
  const nativeDoc = new Y.Doc();
  Y.applyUpdate(nativeDoc, Y.encodeStateAsUpdate(webDoc));
  return { webDoc, webText, nativeDoc,
    nativeText: nativeDoc.getText("content") };
}

describe("Web ⇄ Obsidian shared cursor integration contract", () => {
  it("keeps a native line-end caret anchored left when Web adds a newline at the same offset", () => {
    const {webDoc,webText,nativeDoc,nativeText} = twoSites(
      "# FAQ\nQ: 変換と編集の位置？\nA: 応答です。\n");
    const qEnd = webText.toString().indexOf("\n", webText.toString().indexOf("Q: "));
    const packet = nativeEncode(nativeText, [{anchor:qEnd,head:qEnd}],0);
    expect(webResolve(webText,packet)[0]).toEqual({anchor:qEnd,head:qEnd});

    webText.insert(qEnd, "\n");
    Y.applyUpdate(nativeDoc, Y.encodeStateAsUpdate(webDoc));
    expect(nativeText.toString()).toBe(webText.toString());
    expect(webResolve(webText,packet)[0]).toEqual({anchor:qEnd,head:qEnd});
    expect(nativeResolve(nativeText,packet)[0]).toEqual({anchor:qEnd,head:qEnd});
  });

  it("preserves Web selection direction, main index and multirange across a native insertion", () => {
    const {webDoc,webText,nativeDoc,nativeText}=twoSites(
      "Q: first\nA: second\n");
    const packet = webEncode(webText,[
      {anchor:9,head:3},{anchor:14,head:16}
    ],1);
    expect(packet.mainIndex).toBe(1);
    expect(nativeResolve(nativeText,packet)).toEqual([
      {anchor:9,head:3},{anchor:14,head:16}
    ]);
    nativeText.insert(0, "Intro\n");
    Y.applyUpdate(webDoc, Y.encodeStateAsUpdate(nativeDoc));
    expect(webResolve(webText,packet)).toEqual([
      {anchor:15,head:9},{anchor:20,head:22}
    ]);
    expect(nativeResolve(nativeText,packet)).toEqual([
      {anchor:15,head:9},{anchor:20,head:22}
    ]);
  });

  it("keeps existing cursor awareness when a server presence refresh changes only a name", () => {
    const {webText,nativeText}=twoSites("QA shared cursor");
    const packet=webEncode(webText,[{anchor:4,head:4}]);
    const people=[{id:"web-peer",name:"Web old name",color:"#59baf2",...packet}];
    const before=sanitizePeers(people,null);
    const after=sanitizePeers([{...people[0],name:"Web new name"}],null);
    expect(nativeResolve(nativeText,before[0])).toEqual([{anchor:4,head:4}]);
    expect(nativeResolve(nativeText,after[0])).toEqual([{anchor:4,head:4}]);
    expect(after[0].name).toBe("Web new name");
    expect(sanitizeCursorMessage(people[0]).mainIndex).toBe(0);
  });

  it("never resolves a cursor from an old document generation in new same-text history", () => {
    const oldDoc = new Y.Doc();
    const oldText = oldDoc.getText("content");
    oldText.insert(0,"Recreated name, independent history");
    const oldCursor=webEncode(oldText,[{anchor:9,head:9}]);
    const newDoc=new Y.Doc();
    const newText=newDoc.getText("content");
    newText.insert(0,oldText.toString());
    expect(nativeResolve(newText,oldCursor)).toEqual([null]);
    expect(webResolve(newText,oldCursor)).toEqual([null]);
  });
});
