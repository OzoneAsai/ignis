import { describe, it, expect } from "vitest";
import { classifySyncSocketClose } from "./connection-close.ts";

describe("WebSocket denials retain their actual cause",()=>{
  it("does not call origin-policy or Vault mismatch a revoked device",()=>{
    expect(classifySyncSocketClose(4003,"Origin not allowed"))
      .toEqual({terminal:true,status:"Obsidian app origin not allowed by server"});
    expect(classifySyncSocketClose(4003,"Tailnet identity not authorized"))
      .toEqual({terminal:true,status:"Tailnet identity not authorized for this Vault"});
    expect(classifySyncSocketClose(4003,"Sync authorization failed"))
      .toEqual({terminal:true,status:"Device token rejected or revoked"});
    expect(classifySyncSocketClose(4001,"Invalid or missing vault ID"))
      .toEqual({terminal:true,status:"Vault is not available on this server"});
    expect(classifySyncSocketClose(4003,"unknown"))
      .toEqual({terminal:true,status:"Realtime connection denied by server"});
  });
  it("allows reconnect after recoverable transport or Vault restart",()=>{
    expect(classifySyncSocketClose(4002,"Vault changed"))
      .toEqual({terminal:false,status:"Vault changed · reconnecting"});
    expect(classifySyncSocketClose(1006,""))
      .toEqual({terminal:false,status:"Offline · local Vault retained"});
  });
});
