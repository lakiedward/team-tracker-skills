#!/usr/bin/env node
// Read the presentation project's actual theme and asset references. Never changes the source repo.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inventoryFile, isMainModule } from './asset-inventory.mjs';
import { findChrome, captureSlide } from './render-slides.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function contained(root, path) {
  const base = realpathSync(root);
  const file = realpathSync(resolve(base, path));
  const rel = relative(base, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`asset outside source root: ${path}`);
  return file;
}
export function cssToken(css, name) {
  const value = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim();
  if (!value) throw new Error(`missing project token --${name}`);
  return value;
}
export function projectAssets(project, language = 'en') {
  const variants = (field, fallback) => project[field]
    ? (project[field][language] ?? (() => { throw new Error(`missing ${language} ${field}`); })())
    : (project[fallback] || []);
  const phone = variants('mockupsByLang', 'mockups');
  const desktop = [...variants('desktopMockupsByLang', 'desktopMockups'), ...(project.desktopTour || [])];
  return [...new Map([
    ...phone.map(path => [path, { path, language:project.mockupsByLang ? language : 'original', kind: 'phone', crop: project.screenCrop || null, frame: 'none' }]),
    ...desktop.map(path => [path, { path, language:project.desktopMockupsByLang?.[language]?.includes(path) ? language : 'original', kind: 'desktop', crop: null, frame: 'none' }]),
    ...[project.videoPoster, project.siteVideoPoster].filter(Boolean).map(path => [path, { path, language:'original', kind: 'poster', crop: null, frame: 'none' }]),
  ]).values()];
}

export function backgroundHtml({ vertex, fragment, colors, grain = 0.6, time = 0, mouse = [0.5, 0.5] }) {
  const data = JSON.stringify({ vertex, fragment, colors, grain, time, mouse }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}html,body,canvas{width:1080px;height:1350px;overflow:hidden}canvas{display:block}</style></head><body><canvas width="1080" height="1350"></canvas><script>
  try {
    const d=${data}, c=document.querySelector('canvas'), gl=c.getContext('webgl2',{preserveDrawingBuffer:true});
    if(!gl) throw new Error('WebGL2 unavailable: cannot reproduce project background');
    function compile(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
    const p=gl.createProgram();gl.attachShader(p,compile(gl.VERTEX_SHADER,d.vertex));gl.attachShader(p,compile(gl.FRAGMENT_SHADER,d.fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));gl.useProgram(p);
    const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(p,'a_position');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);gl.viewport(0,0,1080,1350);
    const u=n=>gl.getUniformLocation(p,n);gl.uniform1f(u('u_time'),d.time);gl.uniform2f(u('u_resolution'),1080,1350);gl.uniform2f(u('u_mouse'),...d.mouse);gl.uniform1f(u('u_grain'),d.grain);d.colors.forEach((v,i)=>gl.uniform3f(u('u_c'+i),...v));gl.drawArrays(gl.TRIANGLES,0,6);gl.finish();document.documentElement.dataset.renderReady='true';
  } catch(e){window.__renderError=e.message;document.body.textContent=e.message;} </script></body></html>`;
}

function git(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim(); }
  catch { return null; }
}

export async function extractContext({ repo, project: slug, out, language = 'en', chrome, renderBackground = true }) {
  repo = realpathSync(repo); out = resolve(out);
  // Export is a self-contained snapshot, never a directory in the source tree.
  const outRel = relative(repo, out);
  if (!outRel || (!outRel.startsWith(`..${sep}`) && !isAbsolute(outRel))) throw new Error('--out must be outside the source repository');
  if (existsSync(out) && readdirSync(out).length) throw new Error('--out must be a new or empty snapshot directory');
  mkdirSync(out,{recursive:true});
  const realOutRel = relative(repo,realpathSync(out));
  if (!realOutRel || (!realOutRel.startsWith(`..${sep}`) && !isAbsolute(realOutRel))) throw new Error('--out resolves inside source repository');
  const source = path => contained(repo, path);
  const projectFile = source('src/data/projects.js');
  const { PROJECTS, MOOD_BY_CATEGORY } = await import(pathToFileURL(projectFile).href + `?v=${hash(readFileSync(projectFile))}`);
  const project = PROJECTS.find(item => item.id === slug);
  if (!project) throw new Error(`unknown portfolio project: ${slug}`);
  const paletteFile = source('src/data/moodPalettes.js');
  const { MOOD_PALETTES } = await import(pathToFileURL(paletteFile).href + `?v=${hash(readFileSync(paletteFile))}`);
  const mood = MOOD_BY_CATEGORY[project.category];
  if (!MOOD_PALETTES[mood]) throw new Error(`missing presentation palette for ${slug}`);
  const css = readFileSync(source('src/styles/tokens.css'), 'utf8');
  const family = name => cssToken(css, name).split(',')[0].replace(/['"]/g, '').trim();
  const assetsDir = resolve(out, 'assets'); mkdirSync(assetsDir, { recursive:true });
  const assets = projectAssets(project, language).map(asset => {
    const src = contained(source('public'), asset.path);
    const metadata = inventoryFile(source('public'), asset.path);
    if (!metadata.width || !metadata.height) throw new Error(`cannot determine source resolution: ${asset.path}`);
    const dest = resolve(assetsDir, asset.path); mkdirSync(dirname(dest), {recursive:true}); copyFileSync(src, dest);
    return { ...asset, width:metadata.width, height:metadata.height, bytes:metadata.bytes, sha256:hash(readFileSync(src)) };
  });
  const shaderPath = source('src/lib/auroraShader.glsl.js');
  const { VERT_SRC, FRAG_SRC } = await import(pathToFileURL(shaderPath).href + `?v=${hash(readFileSync(shaderPath))}`);
  const background = { type:'project_shader', mood, colors:MOOD_PALETTES[mood], grain:0.6, time:0, mouse:[0.5,0.5], width:1080, height:1350 };
  const bgHtmlPath = resolve(out, 'background.html');
  writeFileSync(bgHtmlPath, backgroundHtml({vertex:VERT_SRC, fragment:FRAG_SRC, ...background}));
  if (renderBackground) await captureSlide({chrome:findChrome({explicit:chrome}),htmlPath:bgHtmlPath,pngPath:resolve(assetsDir,'background.png'),label:`${slug} background`});
  const theme = {
    name:`${project.name} · tema paginii`, background:cssToken(css,'bg'), text:cssToken(css,'ink'), muted:cssToken(css,'ink-dim'), accent:cssToken(css,'accent'),
    fonts:{display:family('display'),body:family('body'),serif:family('serif'),mono:family('mono')},
    ...(renderBackground ? {background_asset:'background.png'} : {}),
  };
  const sourcePaths = ['src/data/projects.js','src/data/moodPalettes.js','src/styles/tokens.css','src/chrome/Background.jsx','src/chrome/background.css','src/chrome/BackgroundShader.jsx','src/lib/auroraShader.glsl.js','src/shared/MockupReel.jsx','src/shared/mockups.css','src/App.jsx'];
  const themeSources = sourcePaths.map(path => {
    const bytes=readFileSync(source(path));
    const dest=resolve(out,'sources',path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,bytes);
    return {path,sha256:hash(bytes)};
  });
  const context = {
    schema_version:1, project:{slug,name:project.name,language},
    visual_direction:{schema_version:1,summary:`Tema ${project.name}, compoziție aerisită și mockupuri originale.`,rationale:'Identitatea vizuală este preluată din pagina proiectului.',theme,composition:{}},
    source_manifest:{schema_version:1,repo:git(repo,['config','--get','remote.origin.url']),revision:git(repo,['rev-parse','HEAD']),dirty:Boolean(git(repo,['status','--porcelain'])),project_slug:slug,presentation_route:`/${project.name.toLowerCase().trim().replace(/\s+/g,'-')}`,extracted_at:new Date().toISOString(),theme_sources:themeSources,background,assets},
  };
  if (renderBackground) context.source_manifest.background.sha256=hash(readFileSync(resolve(assetsDir,'background.png')));
  writeFileSync(resolve(out,'context.json'),JSON.stringify(context,null,2)+'\n');
  return context;
}

if (isMainModule(import.meta.url)) {
  const args={}; const argv=process.argv.slice(2);
  for(let i=0;i<argv.length;i+=2){const key=argv[i]?.slice(2);if(!['repo','project','out','language','chrome'].includes(key)||!argv[i+1])throw new Error('Usage: project-context.mjs --repo <presentation-repo> --project <slug> --out <snapshot-dir> [--language en] [--chrome <exe>]');args[key]=argv[i+1];}
  if(!args.repo||!args.project||!args.out)throw new Error('--repo, --project and --out are required');
  try {const result=await extractContext(args);console.log(JSON.stringify({context:resolve(args.out,'context.json'),assets:result.source_manifest.assets.length,theme:result.visual_direction.theme.name},null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
