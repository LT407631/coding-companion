const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const text=fs.readFileSync(__dirname+'/web/assets/settings.js','utf8'),nodes=new Map();
let live=true,reply={authenticated:true,auth_type:'shared_password',expires_at:2000000000};
const ctx={$:s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);},window:{CodingProfiles:true},CodingProfiles:{ready:async()=>{},name:()=>'<家庭用户>'},settingsLive:()=>live,Date,fetch:async()=>({ok:true,json:async()=>reply})};
vm.runInNewContext(text.slice(text.indexOf('async function loadSiteSession')),ctx);
(async()=>{
 await ctx.loadSiteSession({exit:{signal:{}}});assert.match(nodes.get('#site-session-status').textContent,/已登录/);assert.equal(nodes.get('#site-session-user').textContent,'当前家庭用户：<家庭用户>');assert.match(nodes.get('#site-session-expiry').textContent,/有效至/);
 ctx.fetch=async()=>{throw Error('network');};await ctx.loadSiteSession({exit:{signal:{}}});assert.match(nodes.get('#site-session-status').textContent,/无法核验/);
 nodes.get('#site-session-status').textContent='left';live=false;await ctx.loadSiteSession({exit:{signal:{}}});assert.equal(nodes.get('#site-session-status').textContent,'left');
 const panel=text.slice(text.indexOf('id="site-session-panel"'),text.indexOf('id="site-password-panel"'));assert.match(panel,/onclick="logoutSite\(\)"/);assert.equal((text.match(/onclick="logoutSite\(\)"/g)||[]).length,1);
 console.log('PASS: verified session/user/expiry, network failure, stale page and visible logout outside hidden password form');
})().catch(e=>{console.error(e);process.exitCode=1;});
