import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KiloAdapter } from "../server/kilo-adapter.ts";
import { Store } from "../server/store.ts";
import { openDb } from "../server/db.ts";
import type { Config } from "../server/config.ts";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "am-kilo-")), path = join(dir, "kilo.db");
  const source = new DatabaseSync(path);
  source.exec(`CREATE TABLE session(id TEXT,parent_id TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`);
  const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: dir, billingMode: "subscription", defaultModel: "sonnet", allowedRoots: [dir], staleAfterMs: 60000,
    readTranscriptUsage: true, pricing: { asOf: null, note: "", models: {} }, kilo: { databasePath: path } };
  const db = openDb(dir), store = new Store(db, { startedAt: Date.now(), version: "test", billingMode: "subscription", managedSessionsEnabled: true, hooksEventsReceived: 0, lastHookEventAt: null, staleAfterMs: 60000, aiSummaries: false });
  const adapter = new KiloAdapter(store, cfg), now = Date.now();
  const session = (id = "root", parent: string | null = null, directory = dir) => source.prepare("INSERT INTO session VALUES(?,?,?,?,?,NULL)").run(id, parent, directory, now-1000, now);
  const message = (data: object, ts = now, sid = "root") => source.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(`m${ts}${sid}`, sid, ts, ts, JSON.stringify(data));
  return { source, store, adapter, cfg, db, now, session, message, close() { source.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("Kilo observes model and state, children, replay and privacy without changing source", () => {
 const x=setup();try {
 x.session();x.session("worker","root");x.session("outside",null,join(x.cfg.dataDir,"..","outside"));
 x.message({role:"assistant",modelID:"kilo-model",time:{completed:x.now},finish:"stop",text:"PRIVATE TEXT",reasoning:"PRIVATE REASONING"});
 x.message({role:"assistant",modelID:"worker-model",time:{}},x.now,"worker");
 x.source.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p",`m${x.now}root`,x.now,x.now,JSON.stringify({type:"tool",tool:"bash",state:{status:"completed",input:"PRIVATE INPUT",output:"PRIVATE OUTPUT"}}));
 const before=x.source.prepare("SELECT total_changes() n").get();x.adapter.poll();
 assert.equal(x.store.server.kilo?.status,"watching");assert.equal(x.store.sessions.size,1);
 assert.equal(x.store.sessions.get("kl_root")?.runtimeState,"idle");assert.equal(x.store.sessions.get("kl_root")?.model,"kilo-model");
 assert.ok(Object.values(x.store.sessions.get("kl_root")!.capabilities).every(v=>!v));
 assert.equal(x.store.agents.get("kl_root/worker")?.parentAgentId,"kl_root/lead");assert.equal(x.store.agents.get("kl_root/worker")?.status,"working");
 const count=x.store.eventsForAgent("kl_root/lead").length;x.adapter.poll();assert.equal(x.store.eventsForAgent("kl_root/lead").length,count);
 assert.deepEqual(x.source.prepare("SELECT total_changes() n").get(),before);
 const stored=JSON.stringify(x.db.prepare("SELECT data FROM entities").all())+JSON.stringify(x.store.eventsForAgent("kl_root/lead"));assert.ok(!stored.includes("PRIVATE"));
 } finally{x.close();}
});
test("Kilo transitions running to idle, failed, archived and stale unknown",()=>{
 const x=setup();try{
 x.session();x.message({role:"assistant",time:{}});x.adapter.poll();assert.equal(x.store.sessions.get("kl_root")?.runtimeState,"running");
 x.message({role:"assistant",time:{completed:x.now+1},finish:"stop"},x.now+1);x.adapter.poll();assert.equal(x.store.sessions.get("kl_root")?.runtimeState,"idle");
 x.message({role:"assistant",error:{name:"failure"}},x.now+2);x.adapter.poll();assert.equal(x.store.sessions.get("kl_root")?.runtimeState,"failed");
 x.source.prepare("UPDATE session SET time_archived=?").run(x.now+3);x.adapter.poll();assert.equal(x.store.sessions.get("kl_root")?.runtimeState,"ended");
 x.source.exec("UPDATE session SET time_archived=NULL");x.message({role:"assistant",time:{}},x.now+4);x.cfg.staleAfterMs=-100;x.adapter.poll();assert.equal(x.store.sessions.get("kl_root")?.runtimeState,"interrupted");
 }finally{x.close();}
});
test("Kilo missing, malformed schema, malformed JSON and disabled report safely",()=>{
 const x=setup();try{
 x.cfg.kilo!.databasePath=join(x.cfg.dataDir,"missing");const missing=new KiloAdapter(x.store,x.cfg);missing.poll();assert.equal(x.store.server.kilo?.status,"unavailable");
 x.cfg.kilo!.enabled=false;missing.start();assert.equal(x.store.server.kilo?.status,"disabled");x.cfg.kilo!.enabled=true;
 x.session();x.message({role:"assistant"});x.source.exec("UPDATE message SET data='bad'");x.adapter.poll();assert.equal(x.store.server.kilo?.status,"unavailable");assert.ok(!JSON.stringify(x.store.server).includes("bad"));
 x.source.exec("DROP TABLE message");x.adapter.poll();assert.equal(x.store.server.kilo?.status,"unavailable");
 }finally{x.close();}
});
