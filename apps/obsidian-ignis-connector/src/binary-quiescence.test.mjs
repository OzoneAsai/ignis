import { describe, expect, it } from "vitest";
import { readQuiescentBinary } from "./binary-quiescence.ts";

describe("binary snapshot quiescence before durable staging",()=>{
  const maxBytes=4*1024*1024;
  it("accepts a complete stable file and returns exact bytes",async()=>{
    const b=Uint8Array.from([0,255,42,1]);
    const out=await readQuiescentBinary({
      stat:async()=>({size:4,mtime:100}),
      read:async()=>b.slice(),wait:async()=>{},maxBytes
    });
    expect(out).toEqual(b);
  });
  it("does not stage a transient prefix while Finder copies a media file",async()=>{
    let data=Uint8Array.from([1,2,3]),mtime=100;
    const out=await readQuiescentBinary({
      stat:async()=>({size:data.length,mtime}),
      read:async()=>data.slice(),
      wait:async()=>{data=Uint8Array.from([1,2,3,4,5]);mtime++},
      maxBytes
    });
    expect(out).toBeNull();
  });
  it("rejects a file that changed after its first stat, even if equal-sized",async()=>{
    let data=Uint8Array.from([1,2,3]);
    const out=await readQuiescentBinary({
      stat:async()=>({size:data.length,mtime:100}),
      read:async()=>{const b=data.slice();data=Uint8Array.from([4,5,6]);return b},
      wait:async()=>{},maxBytes
    });
    expect(out).toBeNull();
  });
  it("refuses files above the transport limit before reading them",async()=>{
    let called=false;
    const out=await readQuiescentBinary({
      stat:async()=>({size:maxBytes+1,mtime:100}),
      read:async()=>{called=true;return new Uint8Array()},
      wait:async()=>{},maxBytes
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });
});
