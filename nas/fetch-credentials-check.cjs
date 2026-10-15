const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/web/app.html','utf8');
const code=source.slice(source.indexOf('const siteFetch ='),source.indexOf("window.addEventListener('pageshow'"));
(async()=>{
 let calls=[],redirects=0;
 const context={Request,URL,location:{href:'https://site.test/ui?compat=1',origin:'https://site.test'},requireSiteLogin(){redirects++;},window:{fetch:async(input,options)=>{calls.push(options);return {status:options?.credentials==='same-origin'?200:401};}}};
 vm.runInNewContext(code,context);
 await context.window.fetch('/watch-profiles');assert.equal(calls[0].credentials,'same-origin');assert.equal(redirects,0);
 await context.window.fetch('/filters',{signal:'fixture',headers:{test:'value'}});assert.equal(calls[1].signal,'fixture');assert.equal(calls[1].credentials,'same-origin');
 await context.window.fetch('https://external.test/media',{credentials:'omit'});assert.equal(calls[2].credentials,'omit');assert.equal(redirects,0);
 await context.window.fetch('/watch-state',{credentials:'omit'});assert.equal(redirects,1,'real auth failure still redirects');
 console.log('PASS: old fetch default-omit restored to same-origin; options and explicit omit retained; real 401 still denied');
})().catch(e=>{console.error(e);process.exitCode=1;});
