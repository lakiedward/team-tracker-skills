#!/usr/bin/env node
// Persist a visually reviewed local generation, including the source snapshot needed for regeneration.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, lstatSync } from 'node:fs';
import { resolve, extname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SUPABASE_URL, DEFAULT_BUCKET, objectPath } from './upload-slides.mjs';
import { isMainModule } from './asset-inventory.mjs';
import { contained } from './project-context.mjs';
import { validatePost } from './validate-post.mjs';
import { pngSize } from './render-slides.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = path => ({'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.json':'application/json','.html':'text/html','.css':'text/css','.js':'text/javascript'}[extname(path)] || 'application/octet-stream');
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
function headers(key) { if(!key)throw new Error('SUPABASE_SERVICE_ROLE_KEY lipsește; nu scriu nimic.');return {apikey:key,Authorization:`Bearer ${key}`}; }
async function checked(response,label){if(!response.ok)throw Object.assign(new Error(`${label}: HTTP ${response.status}`),{httpStatus:response.status});return response;}
async function rpc(name,body,key,fetchImpl){const response=await fetchImpl(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers:{...headers(key),'Content-Type':'application/json'},body:JSON.stringify(body)});await checked(response,name);const text=await response.text();return text?JSON.parse(text):null;}
async function upload(path,bytes,key,fetchImpl){
 const url=`${SUPABASE_URL}/storage/v1/object/${DEFAULT_BUCKET}/${encodePath(path)}`;
 const result=await fetchImpl(url,{method:'POST',headers:{...headers(key),'Content-Type':mime(path),'x-upsert':'false'},body:bytes});
 if(!result.ok){const body=await result.text();if(result.status!==409&&!(result.status===400&&/Duplicate|already exists/i.test(body)))await checked(result,'upload');}
 const response=await checked(await fetchImpl(url,{headers:headers(key)}),'verify upload');
 if(sha(Buffer.from(await response.arrayBuffer()))!==sha(bytes))throw new Error('uploaded object hash mismatch');
}
function files(root,prefix=''){return readdirSync(resolve(root,prefix),{withFileTypes:true}).flatMap(item=>{const path=[prefix,item.name].filter(Boolean).join('/');if(item.isSymbolicLink())throw new Error('snapshot symlink is not allowed');if(item.isDirectory())return files(root,path);if(!item.isFile())throw new Error('snapshot requires regular files');return [path];}).sort();}
function safeRelative(path){
 if(typeof path!=='string'||/[\\:\0]/.test(path)||isAbsolute(path)||path.split('/').some(part=>part==='..'||part==='.'||part===''))throw new Error('invalid snapshot file path');
 if(path!=='context.json'&&!path.startsWith('assets/')&&!path.startsWith('sources/'))throw new Error('unsupported snapshot file path');return path;
}
function verifySources(post,context,root){
 const manifest=post.source_manifest;
 if(!manifest||manifest.project_slug!==context.project?.slug)throw new Error('source manifest belongs to a different project');
 const {snapshot:ignored,...source}=manifest;
 if(!isDeepStrictEqual(source,context.source_manifest))throw new Error('source manifest differs from extracted context');
 const verify=(path,digest)=>{safeRelative(path);if(!/^[a-f0-9]{64}$/.test(digest||'')||sha(readFileSync(contained(root,path)))!==digest)throw new Error(`source asset hash mismatch: ${path}`);};
 if(!Array.isArray(manifest.assets)||!Array.isArray(manifest.theme_sources))throw new Error('source assets and theme sources required');
 for(const asset of manifest.assets)verify(`assets/${asset.path}`,asset.sha256);
 for(const file of manifest.theme_sources)verify(`sources/${file.path}`,file.sha256);
 if(manifest.background?.sha256)verify('assets/background.png',manifest.background.sha256);
 for(const slide of post.slides)if(slide.asset){const asset=manifest.assets.find(item=>item.path===slide.asset);if(!asset)throw new Error('slide asset is not from project manifest');if(slide.source_asset?.sha256&&slide.source_asset.sha256!==asset.sha256)throw new Error('slide source hash differs from project asset');}
}
async function revision(postId,version,key,fetchImpl){const response=await checked(await fetchImpl(`${SUPABASE_URL}/rest/v1/tt_marketing_post_versions?post_id=eq.${postId}&version=eq.${version}&select=status`,{headers:headers(key)}),'read revision');const rows=await response.json();return rows.length===1?rows[0]:null;}
export async function recoverGeneration({postId,version,key=process.env.SUPABASE_SERVICE_ROLE_KEY},{fetchImpl=fetch}={}){
 headers(key);if(!Number.isSafeInteger(postId)||postId<=0||!Number.isSafeInteger(version)||version<=0)throw new Error('positive post and version required');
 const existing=await revision(postId,version,key,fetchImpl);
 if(existing?.status==='generated')return {post_id:postId,version,status:'generated',recovered:true};
 if(existing?.status!=='generating')throw new Error('revision is not active; inspect its saved status');
 try{await rpc('tt_finish_marketing_post_version',{p_post_id:postId,p_version:version},key,fetchImpl);}
 catch(error){try{if((await revision(postId,version,key,fetchImpl))?.status==='generated')return {post_id:postId,version,status:'generated',recovered:true};}catch{error.uncertain=true;}error.uncertain ||= !error.httpStatus;throw error;}
 return {post_id:postId,version,status:'generated'};
}

export function snapshotBrief(post) { return post.slides.slice().sort((a,b)=>a.order_index-b.order_index).map(slide => ({...slide,n:slide.order_index+1})); }

export async function publishGeneration({postFile,contextDir,renderDir,projectId,expectedVersion,key=process.env.SUPABASE_SERVICE_ROLE_KEY},{fetchImpl=fetch}={}) {
 headers(key);
 const post=JSON.parse(readFileSync(postFile,'utf8'));
 const context=JSON.parse(readFileSync(contained(contextDir,'context.json'),'utf8'));
 const validation=validatePost(post,{assetsDir:resolve(contextDir,'assets')});
 if(!validation.ok)throw new Error(validation.errors.join('\n'));
 if(!Number.isSafeInteger(post.post_id)||post.post_id<=0||!Number.isSafeInteger(projectId)||projectId<=0||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new Error('positive project/post and nonnegative expected-version required');
 if(!post.visual_direction||!post.source_manifest)throw new Error('resolved visual_direction and source_manifest required');
 if(snapshotBrief(post).some((slide,index)=>slide.n!==index+1))throw new Error('slide orders must be contiguous from zero');
 verifySources(post,context,contextDir);
 const renderedPost=JSON.parse(readFileSync(contained(renderDir,'reviewed-post.json'),'utf8'));
 if(!isDeepStrictEqual(renderedPost,post))throw new Error('post changed since rendering; render and visually review again');
 const render=JSON.parse(readFileSync(contained(renderDir,'reviewed-render.json'),'utf8'));
 if(render.schema_version!==1||render.post_sha256!==sha(JSON.stringify(post))||!Array.isArray(render.slides)||render.slides.length!==post.slides.length)throw new Error('missing or mismatched full reviewed-render marker');
 const pngs=post.slides.map(slide=>{
   const path=contained(renderDir,`slide-${String(slide.order_index+1).padStart(2,'0')}.png`),bytes=readFileSync(path),size=pngSize(bytes);
   if(size.width!==1080||size.height!==1350)throw new Error('incorrect output dimensions');
   const markers=render.slides.filter(item=>item.order_index===slide.order_index);
   if(markers.length!==1||markers[0].sha256!==sha(bytes))throw new Error('rendered image changed since review');
   return {order:slide.order_index,bytes};
 });
 // The reviewed recipe must be the one rendered, not an edited post.json after preview.
 const snapshotFiles=files(contextDir).filter(path=>path==='context.json'||path.startsWith('assets/')||path.startsWith('sources/'));
 const entries=snapshotFiles.map(path=>({path:safeRelative(path),bytes:readFileSync(contained(contextDir,path))}));
 const records=entries.map(({path,bytes})=>({path,sha256:sha(bytes)}));
 const snapshotId=sha(JSON.stringify(records));
 const prefix=`${projectId}/contexts/${snapshotId}`;
 const identityResponse=await checked(await fetchImpl(`${SUPABASE_URL}/rest/v1/tt_marketing_posts?id=eq.${post.post_id}&select=project_id,portfolio_project,version`,{headers:headers(key)}),'read post identity');
 const identities=await identityResponse.json();const identity=identities[0];
 if(identities.length!==1||identity.project_id!==projectId||identity.portfolio_project!==context.project.slug||identity.version!==expectedVersion)throw new Error('post project or expected version does not match the source context');
 for(const item of entries)await upload(`${prefix}/${item.path}`,item.bytes,key,fetchImpl);
 const sourceManifest={...post.source_manifest,snapshot:{prefix,files:records}};
 let version;let finishing=false;
 try {
   version=await rpc('tt_start_marketing_post_version',{p_post_id:post.post_id,p_expected_version:expectedVersion,p_snapshot:{brief:snapshotBrief(post),caption:post.caption,hashtags:post.hashtags,visual_direction:post.visual_direction,source_manifest:sourceManifest,renderer_version:'marketing-generate/1.36.0'}},key,fetchImpl);
   if(!Number.isSafeInteger(version)||version<=expectedVersion)throw Object.assign(new Error('uncertain start response; inspect revision before retrying'),{uncertain:true});
   for(const png of pngs){
     const path=objectPath(projectId,post.post_id,version,png.order);await upload(path,png.bytes,key,fetchImpl);
     const url=`${SUPABASE_URL}/rest/v1/tt_marketing_slides?post_id=eq.${post.post_id}&version=eq.${version}&order_index=eq.${png.order}`;
     const response=await checked(await fetchImpl(url,{method:'PATCH',headers:{...headers(key),'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({image_path:path,rendered_at:new Date().toISOString()})}),'record slide');
     const rows=await response.json();if(rows.length!==1)throw new Error('slide update did not affect exactly one row');
   }
   finishing=true;const result=await recoverGeneration({postId:post.post_id,version,key},{fetchImpl});
   return {...result,slides:pngs.length};
 }catch(error){
   if(version===undefined||error.uncertain||(finishing&&!error.httpStatus))throw new Error(`${error.message}; state may be committed: inspect post ${post.post_id}${version?` version ${version}; retry recover --post ${post.post_id} --version ${version}`:' before retrying start'}`);
   if(version!==undefined)try{await rpc('tt_fail_marketing_post_version',{p_post_id:post.post_id,p_version:version,p_error:String(error.message).slice(0,1000)},key,fetchImpl);}catch(recovery){throw new Error(`${error.message}; recovery failed: ${recovery.message}; retry recovery for version ${version}`);}
   throw error;
 }
}

export async function restoreContext({manifest,out,key=process.env.SUPABASE_SERVICE_ROLE_KEY},{fetchImpl=fetch}={}) {
 headers(key);const snapshot=manifest.snapshot;if(!snapshot?.prefix||!Array.isArray(snapshot.files))throw new Error('legacy version has no source snapshot');
 if(!/^\d+\/contexts\/[a-f0-9]{64}$/.test(snapshot.prefix))throw new Error('invalid snapshot prefix');
 const names=new Set();
 for(const file of snapshot.files){safeRelative(file.path);if(!/^[a-f0-9]{64}$/.test(file.sha256||'')||names.has(file.path))throw new Error('invalid or duplicate snapshot entry');names.add(file.path);}
 if(!names.has('context.json')||!snapshot.prefix.endsWith(`/${sha(JSON.stringify(snapshot.files))}`))throw new Error('snapshot manifest hash mismatch');
 mkdirSync(out,{recursive:true});
 if(lstatSync(out).isSymbolicLink())throw new Error('restore destination is a symlink');
 for(const file of snapshot.files){
   if(typeof file.path!=='string'||file.path.includes('\\')||isAbsolute(file.path)||file.path.split('/').some(part=>part==='..'||part===''))throw new Error('invalid snapshot file path');
   const response=await checked(await fetchImpl(`${SUPABASE_URL}/storage/v1/object/${DEFAULT_BUCKET}/${encodePath(`${snapshot.prefix}/${file.path}`)}`,{headers:headers(key)}),'restore');
   const bytes=Buffer.from(await response.arrayBuffer());if(sha(bytes)!==file.sha256)throw new Error(`snapshot hash mismatch: ${file.path}`);
   let parent=resolve(out);
   for(const part of file.path.split('/').slice(0,-1)){
     parent=resolve(parent,part);try{mkdirSync(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
     const info=lstatSync(parent);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('restore parent is not a regular directory');contained(out,parent);
   }
   writeFileSync(resolve(out,file.path),bytes,{flag:'wx'});
 }
 return {out,files:snapshot.files.length};
}

if(isMainModule(import.meta.url)){
 const args={};const argv=process.argv.slice(2);const mode=argv.shift();
 for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||!argv[i+1])throw new Error('expected --name value');args[argv[i].slice(2)]=argv[i+1];}
 try {
   if(mode==='publish')console.log(JSON.stringify(await publishGeneration({postFile:args.post,contextDir:args.context,renderDir:args.dir,projectId:Number(args.project),expectedVersion:Number(args['expected-version'])}),null,2));
   else if(mode==='restore')console.log(JSON.stringify(await restoreContext({manifest:JSON.parse(readFileSync(args.manifest,'utf8')),out:args.out}),null,2));
   else if(mode==='recover')console.log(JSON.stringify(await recoverGeneration({postId:Number(args.post),version:Number(args.version)}),null,2));
   else throw new Error('Use publish --post post.json --context snapshot --dir render --project ID --expected-version N; restore --manifest source-manifest.json --out snapshot; recover --post ID --version N');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
