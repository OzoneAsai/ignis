import { describe, expect, it, vi } from "vitest";
import { persistScopedDeviceCredential } from "./credential-persistence.ts";

describe("device credential persistence is distinct from session authentication",()=>{
  const id="ignis-connector-vault-demo-scope";
  const token="ignis_dev_"+"x".repeat(43);
  it("rejects an iOS Keychain -34018 write without pretending a token is durable",async()=>{
    const secrets={existing:"untouched"};
    const backend={save:vi.fn(async()=>{throw Error("OSStatus -34018")}),
      load:vi.fn(async()=>({}))};
    const setSecret=vi.fn();
    expect(await persistScopedDeviceCredential({adapter:backend,secrets,setSecret},id,token))
      .toBe("session-only");
    expect(setSecret).not.toHaveBeenCalled();
    expect(backend.load).not.toHaveBeenCalled();
    expect(secrets).toEqual({existing:"untouched"});
  });
  it("confirms real native write/readback and preserves existing secrets",async()=>{
    const saved={existing:"another vault"};
    const store={secrets:{existing:"another vault"},setSecret:vi.fn((k,v)=>{
      store.secrets[k]=v;
    }),adapter:{save:vi.fn(async object=>{Object.assign(saved,object)}),
      load:vi.fn(async()=>({...saved}))}};
    expect(await persistScopedDeviceCredential(store,id,token)).toBe("verified");
    expect(saved.existing).toBe("another vault");
    expect(saved[id]).toBe(token);
    expect(store.setSecret).toHaveBeenCalledWith(id,token);
  });
  it("treats a backend acknowledging the wrong bytes as session-only",async()=>{
    const setSecret=vi.fn();
    expect(await persistScopedDeviceCredential({
      secrets:{},setSecret,adapter:{save:vi.fn(async()=>{}),
        load:vi.fn(async()=>({[id]:"incorrect"}))}
    },id,token)).toBe("session-only");
    expect(setSecret).not.toHaveBeenCalled();
  });
  it("does not claim durability from a memory-only or opaque setter",async()=>{
    expect(await persistScopedDeviceCredential(null,id,token)).toBe("session-only");
    expect(await persistScopedDeviceCredential({
      setSecret:vi.fn(()=>{})
    },id,token)).toBe("unverified");
  });
});
