const os=require('os'),path=require('path'),fs=require('fs');
const {spawn}=require('child_process');const pptr=require('puppeteer-core');
const ROOT=path.join(__dirname,'..');const OUT=process.env.SHOT_DIR;
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'ramp-'));const PORT=47361;const B=`http://127.0.0.1:${PORT}`;
const srv=spawn('node',[path.join(ROOT,'server.js')],{cwd:ROOT,env:{...process.env,SPICE_DATA_DIR:TMP,PORT:String(PORT),NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
let T='';
const api=async(m,u,b)=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(T?{Authorization:'Bearer '+T}:{})},body:b?JSON.stringify(b):undefined});return{status:r.status,d:await r.json().catch(()=>null)}};
const CF=`
 function _lum(rgb){const c=rgb.map(v=>{v=v/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return .2126*c[0]+.7152*c[1]+.0722*c[2]}
 function _p(s){const m=String(s).match(/\\d+(\\.\\d+)?/g)||[];return[+m[0]||0,+m[1]||0,+m[2]||0]}
 function _bg(el){let e=el;while(e){const b=getComputedStyle(e).backgroundColor;const m=String(b).match(/\\d+(\\.\\d+)?/g);if(m&&(m.length<4||parseFloat(m[3])>0)&&b!=='transparent')return _p(b);e=e.parentElement}return[255,255,255]}
 function K(el){const a=_lum(_p(getComputedStyle(el).color)),b=_lum(_bg(el));const hi=Math.max(a,b),lo=Math.min(a,b);return (hi+.05)/(lo+.05)}
`;
(async()=>{
 for(let i=0;i<160;i++){try{const r=await fetch(B+'/api/health');if(r.status<500)break}catch(e){}await new Promise(r=>setTimeout(r,250))}
 T=(await api('POST','/api/login',{username:'admin',password:'admin123'})).d.token;
 await api('PUT','/api/company-settings',{settings:{br1:'CUMBUM'}});
 await api('POST','/api/users',{username:'d1',password:'pw1234',role:'admin'});
 const ep=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium'].find(p=>fs.existsSync(p));
 const br=await pptr.launch({executablePath:ep,args:['--no-sandbox'],headless:true});
 const p=await br.newPage();await p.setViewport({width:1440,height:900});
 await p.goto(B+'/',{waitUntil:'domcontentloaded'});
 await p.evaluate(()=>localStorage.clear());
 await p.goto(B+'/',{waitUntil:'domcontentloaded'});
 await p.waitForSelector('#inp-u');
 await p.evaluate(()=>{document.getElementById('inp-u').value='d1';document.getElementById('inp-p').value='pw1234';login()});
 await p.waitForFunction(()=>document.getElementById('app')?.style.display==='block',{timeout:20000});
 await p.evaluate(()=>go('users'));
 await new Promise(r=>setTimeout(r,2000));
 // Sweep every visible text node on the page and find the worst contrast.
 const res=await p.evaluate(`(()=>{${CF}
   let worst=null,worstK=99,fails=0,checked=0;
   document.querySelectorAll('body *').forEach(e=>{
     if(!e.offsetParent&&getComputedStyle(e).position!=='fixed')return;
     const t=[...e.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim().length>1);
     if(!t.length)return;
     const cs=getComputedStyle(e);
     const size=parseFloat(cs.fontSize), weight=parseInt(cs.fontWeight)||400;
     // WCAG "large text" gets a 3:1 allowance
     const large = size>=24 || (size>=18.66 && weight>=700);
     const need = large?3:4.5;
     const k=K(e); checked++;
     if(k<need){fails++; if(k<worstK){worstK=k;worst=(e.tagName+' "'+t[0].textContent.trim().slice(0,32)+'" '+size+'px '+cs.color)}}
   });
   return {checked,fails,worst,worstK:worstK===99?null:+worstK.toFixed(2)};
 })()`);
 console.log('DESKTOP users screen:',JSON.stringify(res));
 await p.screenshot({path:path.join(OUT,'desktop-darker.png')});
 await br.close();srv.kill('SIGKILL');fs.rmSync(TMP,{recursive:true,force:true});
})().catch(e=>{console.error('ERR',e.message);srv.kill('SIGKILL')});
