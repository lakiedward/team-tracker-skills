import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectAssets, cssToken, backgroundHtml, extractContext, hash } from './project-context.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
test('project references, not folder names, determine asset membership and language',()=>{
 const assets=projectAssets({mockupsByLang:{en:['phones/padel.webp'],ro:['phones/padel-ro.webp']},desktopTour:['tour/high.webp'],screenCrop:{x0:0.1,y0:0.1,x1:0.9,y1:0.9}},'en');
 assert.equal(assets.length,2);assert.equal(assets[0].path,'phones/padel.webp');assert.equal(assets[0].crop.x0,0.1);assert.equal(assets[1].kind,'desktop');
 assert.throws(()=>projectAssets({mockupsByLang:{ro:['ro.webp']}},'en'),/missing/);
 assert.equal(projectAssets({mockups:['original.webp']},'en')[0].language,'original');
});
test('extracts an isolated reproducible snapshot without altering presentation sources',async()=>{
 const root=mkdtempSync(join(tmpdir(),'marketing-context-')),repo=join(root,'repo'),out=join(root,'snapshot');
 const put=(path,text)=>{const target=join(repo,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text);};
 try{
  put('package.json','{"type":"module"}');
  put('src/data/projects.js',`export const PROJECTS=[{id:'padel',name:'Padel Team',category:'Sports',mockups:['phones/padel.png']}];export const MOOD_BY_CATEGORY={Sports:'court'};`);
  put('src/data/moodPalettes.js','export const MOOD_PALETTES={court:[[0,1,0],[0,0,1],[1,0,0]]};');
  put('src/styles/tokens.css',':root{--bg:#000000;--ink:#ffffff;--ink-dim:rgba(255,255,255,.6);--accent:#aabbcc;--display:"Arial";--body:"Arial";--serif:"Georgia";--mono:"Consolas";}');
  put('src/lib/auroraShader.glsl.js','export const VERT_SRC="vertex";export const FRAG_SRC="fragment";');
  for(const path of ['src/chrome/Background.jsx','src/chrome/background.css','src/chrome/BackgroundShader.jsx','src/shared/MockupReel.jsx','src/shared/mockups.css','src/App.jsx'])put(path,'// source');
  const png=Buffer.alloc(24);png.writeUInt32BE(0x89504e47);png.write('IHDR',12);png.writeUInt32BE(800,16);png.writeUInt32BE(1200,20);put('public/phones/padel.png',png);
  const result=await extractContext({repo,project:'padel',out,renderBackground:false});
  assert.equal(result.source_manifest.presentation_route,'/padel-team');assert.equal(result.source_manifest.assets[0].sha256,hash(png));assert.deepEqual(readFileSync(join(out,'assets/phones/padel.png')),png);assert.deepEqual(readFileSync(join(repo,'public/phones/padel.png')),png);
  assert.equal(result.visual_direction.theme.accent,'#aabbcc');assert.equal(result.source_manifest.assets[0].language,'original');
  await assert.rejects(extractContext({repo,project:'padel',out,renderBackground:false}),/new or empty/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('reads project tokens with explicit failure for absent theme',()=>{
 assert.equal(cssToken(':root{--ink: #123456; --ink-dim: rgba(1,2,3,.5);}','ink'),'#123456');assert.throws(()=>cssToken('','bg'),/missing/);
});
test('background embeds source shader and fixed parameters without script injection',()=>{
 const html=backgroundHtml({vertex:'original vertex',fragment:'original fragment </script>',colors:[[1,0,0],[0,1,0],[0,0,1]],time:3});
 assert.match(html,/original vertex/);assert.match(html,/"time":3/);assert.equal((html.match(/<\/script>/g)||[]).length,1);assert.match(html,/__renderError/);
});
