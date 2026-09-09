import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVisualDirection, reviseSlides } from './visual-contract.mjs';
const defaults={theme:{background:'#000000',accent:'#ffffff'},composition:{align:'left'}};
test('specific preferences win without losing project defaults',()=>{
 const result=resolveVisualDirection(defaults,{overrides:{theme:{accent:'#123456'}}},{overrides:{composition:{align:'center'}}},{overrides:{theme:{accent:'#abcdef'}}});
 assert.deepEqual(result,{theme:{background:'#000000',accent:'#abcdef'},composition:{align:'center'}}); assert.equal(defaults.theme.accent,'#ffffff');
});
test('reset restores project identity and discards previous request',()=>{
 const result=resolveVisualDirection(defaults,{request:'red',overrides:{theme:{accent:'#ff0000'}}},{mode:'project_default'});assert.deepEqual(result,defaults);
});
test('targeted background revision preserves copy, source and other slides',()=>{
 const old=[{order_index:0,headline:'Hello',asset:'one.png',design:{align:'left'}},{order_index:1,headline:'Bye',asset:'two.png'}];
 const next=reviseSlides(old,[{order_index:0,design:{theme:{background:'#123456'}}}]);
 assert.deepEqual(next[1],old[1]);assert.equal(next[0].headline,'Hello');assert.equal(next[0].asset,'one.png');assert.equal(next[0].design.align,'left');assert.equal(old[0].design.theme,undefined);
});
test('explicit null clears a selected asset or crop; omissions stay unchanged',()=>{
 const before=[{order_index:0,asset:'one.png',source_asset:{width:10,height:10,crop:{x0:0,y0:0,x1:1,y1:1}},headline:'Keep'}];
 const cleared=reviseSlides(before,[{order_index:0,asset:null,source_asset:null}]);assert.equal(cleared[0].asset,null);assert.equal(cleared[0].source_asset,null);assert.equal(cleared[0].headline,'Keep');
 assert.equal(reviseSlides(before,[{order_index:0,source_asset:{crop:null}}])[0].source_asset.crop,null);
});
