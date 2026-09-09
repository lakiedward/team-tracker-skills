import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { publishGeneration, restoreContext, recoverGeneration } from './generation-io.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'marketing-io-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const contextDir=join(root,'context'),renderDir=join(root,'render');mkdirSync(join(contextDir,'assets'),{recursive:true});mkdirSync(join(contextDir,'sources'),{recursive:true});mkdirSync(renderDir);
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(1080,16);png.writeUInt32BE(1350,20);
 writeFileSync(join(contextDir,'assets','screen.png'),png);writeFileSync(join(contextDir,'sources','theme.css'),'--ink: #fff;');
 const source_manifest={schema_version:1,project_slug:'demo',assets:[{path:'screen.png',sha256:sha(png),width:1080,height:1350}],theme_sources:[{path:'theme.css',sha256:sha('--ink: #fff;')}],background:{time:0}};
 const context={project:{slug:'demo'},source_manifest};writeFileSync(join(contextDir,'context.json'),JSON.stringify(context));
 const post={post_id:7,caption:'A useful product.',hashtags:['studio'],visual_direction:{schema_version:1,theme:{},composition:{}},source_manifest,slides:[{order_index:0,layout:'cover',headline:'First'},{order_index:1,layout:'statement',headline:'Second',asset:'screen.png',source_asset:{width:1080,height:1350,sha256:sha(png)}},{order_index:2,layout:'cta',headline:'Talk to us'}]};
 const postFile=join(root,'post.json');
 const save=()=>{writeFileSync(postFile,JSON.stringify(post));writeFileSync(join(renderDir,'reviewed-post.json'),JSON.stringify(post));writeFileSync(join(renderDir,'reviewed-render.json'),JSON.stringify({schema_version:1,post_sha256:sha(JSON.stringify(post)),slides:post.slides.map(s=>({order_index:s.order_index,sha256:sha(png)}))}));};
 for(let n=1;n<=3;n++)writeFileSync(join(renderDir,`slide-0${n}.png`),png);save();
 return {root,contextDir,renderDir,postFile,post,png,save,options:{postFile,contextDir,renderDir,projectId:11,expectedVersion:0,key:'test-key'}};
}
function network({finishLost=false,finishPending=false,patchError=false,startLost=false,wrongProject=false}={}){
 const objects=new Map(),calls=[];let snapshot,status='generating',fails=0,finishes=0;
 const fetchImpl=async(url,options={})=>{
  calls.push({url,options});
  if(url.includes('/storage/v1/object/')){
   if(options.method==='POST'){assert.equal(options.headers['x-upsert'],'false');if(objects.has(url))return new Response('{"error":"Duplicate"}',{status:400});objects.set(url,Buffer.from(options.body));return json({});}
   return objects.has(url)?new Response(objects.get(url)):new Response('',{status:404});
  }
  if(url.includes('/rpc/tt_start_')){snapshot=JSON.parse(options.body).p_snapshot;if(startLost)throw new Error('network lost at start');return json(1);}
  if(url.includes('/rpc/tt_finish_')){finishes++;if(!finishPending)status='generated';if(finishLost||finishPending)throw new Error('network lost at finish');return json(null);}
  if(url.includes('/rpc/tt_fail_')){fails++;status='failed';return json(null);}
  if(url.includes('/tt_marketing_post_versions?'))return json([{status}]);
  if(url.includes('/tt_marketing_posts?'))return json([{project_id:wrongProject?12:11,portfolio_project:'demo',version:0}]);
  if(url.includes('/tt_marketing_slides?'))return patchError?new Response('',{status:500}):json([{id:1}]);
  throw new Error(`Unexpected URL ${url}`);
 };
 return {fetchImpl,objects,calls,get snapshot(){return snapshot;},get status(){return status;},get fails(){return fails;},get finishes(){return finishes;}};
}

test('publication saves immutable source context and restores the exact bytes',async t=>{
 const f=fixture(t),net=network();const result=await publishGeneration(f.options,net);
 assert.equal(result.status,'generated');assert.equal(result.slides,3);assert.equal(net.snapshot.brief[1].source_asset.sha256,sha(f.png));
 const firstRpc=net.calls.findIndex(c=>c.url.includes('/rpc/'));
 assert.ok(net.calls.slice(0,firstRpc).some(c=>c.url.includes('/contexts/')),'source uploads precede generation');
 const out=join(f.root,'restored');await restoreContext({manifest:net.snapshot.source_manifest,out,key:'test-key'},net);
 assert.deepEqual(readFileSync(join(out,'assets','screen.png')),f.png);
 assert.equal(JSON.parse(readFileSync(join(out,'context.json'))).project.slug,'demo');
 await assert.rejects(restoreContext({manifest:net.snapshot.source_manifest,out,key:'test-key'},net),/EEXIST/,'restore never overwrites existing files');
});

test('wrong project, modified source, incomplete marker and stale image fail before network',async t=>{
 for(const kind of ['project','source','marker','image']){
  const f=fixture(t),net=network();
  if(kind==='project'){f.post.source_manifest.project_slug='other';f.save();}
  if(kind==='source')writeFileSync(join(f.contextDir,'assets','screen.png'),'changed');
  if(kind==='marker')rmSync(join(f.renderDir,'reviewed-render.json'));
  if(kind==='image')writeFileSync(join(f.renderDir,'slide-01.png'),Buffer.concat([f.png,Buffer.from('modified')]));
  await assert.rejects(publishGeneration(f.options,net));assert.equal(net.calls.length,0,kind);
 }
});

test('duplicate content-addressed upload verifies bytes without overwriting',async t=>{
 const f=fixture(t),net=network();await publishGeneration(f.options,net);
 await publishGeneration(f.options,net);assert.equal(net.fails,0);
 const sourceUrl=[...net.objects.keys()].find(url=>url.includes('/contexts/')&&url.endsWith('/screen.png'));
 net.objects.set(sourceUrl,Buffer.from('different'));
 await assert.rejects(publishGeneration(f.options,net),/hash mismatch/);
});

test('lost successful finish is recovered without marking completed work failed',async t=>{
 const f=fixture(t),net=network({finishLost:true});const result=await publishGeneration(f.options,net);
 assert.equal(result.recovered,true);assert.equal(net.status,'generated');assert.equal(net.fails,0);
 await recoverGeneration({postId:7,version:1,key:'test-key'},net);assert.equal(net.finishes,1,'recovery is idempotent');
});

test('uncertain start and uncertain uncommitted finish never trigger destructive failure recovery',async t=>{
 for(const config of [{startLost:true},{finishPending:true}]){
  const f=fixture(t),net=network(config);await assert.rejects(publishGeneration(f.options,net),/state may be committed/);assert.equal(net.fails,0);
 }
});

test('known slide recording failure invokes failure RPC for its exact version',async t=>{
 const f=fixture(t),net=network({patchError:true});await assert.rejects(publishGeneration(f.options,net),/HTTP 500/);
 assert.equal(net.fails,1);const fail=net.calls.find(c=>c.url.includes('/rpc/tt_fail_'));assert.equal(JSON.parse(fail.options.body).p_version,1);
});

test('restore rejects traversal, corrupt manifest and symlink directories',async t=>{
 const f=fixture(t),net=network();await publishGeneration(f.options,net);const manifest=net.snapshot.source_manifest;
 for(const path of ['../escape','assets/../escape','assets/C:escape','assets\\escape']){
  const copy=structuredClone(manifest);copy.snapshot.files[0].path=path;
  await assert.rejects(restoreContext({manifest:copy,out:join(f.root,'bad'),key:'test-key'},net),/invalid snapshot file path/);
 }
 const corrupt=structuredClone(manifest);corrupt.snapshot.files[0].sha256='0'.repeat(64);
 await assert.rejects(restoreContext({manifest:corrupt,out:join(f.root,'bad'),key:'test-key'},net),/manifest hash mismatch/);
 const out=join(f.root,'linked'),outside=join(f.root,'outside');mkdirSync(out);mkdirSync(outside);symlinkSync(outside,join(out,'assets'),'junction');
 await assert.rejects(restoreContext({manifest,out,key:'test-key'},net),/regular directory/);
 assert.equal(existsSync(join(outside,'screen.png')),false);
});

test('source symlinks are refused before uploads',async t=>{
 const f=fixture(t),net=network();const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.contextDir,'sources','linked'),'junction');
 await assert.rejects(publishGeneration(f.options,net),/symlink/);assert.equal(net.calls.length,0);
});

test('database project identity mismatch prevents all storage writes',async t=>{
 const f=fixture(t),net=network({wrongProject:true});await assert.rejects(publishGeneration(f.options,net),/post project/);
 assert.equal(net.calls.length,1);assert.equal(net.objects.size,0);
});
