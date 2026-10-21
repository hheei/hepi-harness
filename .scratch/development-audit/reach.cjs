const fs=require('fs'),path=require('path');
const root=process.cwd();
const exts=['.ts','.tsx','.mjs','.js'];
function resolve(spec, from){
  let base;
  if(spec.startsWith('@/')) base=path.join(root, spec.slice(2));
  else if(spec.startsWith('.')) base=path.resolve(path.dirname(from), spec);
  else return null;
  for(const e of exts){ if(fs.existsSync(base+e)) return base+e; }
  for(const e of exts){ if(fs.existsSync(path.join(base,'index'+e))) return path.join(base,'index'+e); }
  return null;
}
const queue=[];
function walk(dir){ for(const f of fs.readdirSync(dir,{withFileTypes:true})){ const p=path.join(dir,f.name); if(f.isDirectory()){ if(f.name==='node_modules'||f.name==='vendor'||f.name==='.next') continue; walk(p);} else if(/\.tsx?$/.test(f.name)) queue.push(p); } }
walk(path.join(root,'app'));
const reached=new Set(); const parents=new Map();
while(queue.length){
  const f=queue.pop();
  const key=path.relative(root,f); if(reached.has(key)) continue; reached.add(key);
  const src=fs.readFileSync(f,'utf8');
  const specs=[...src.matchAll(/(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)].map(m=>m[1]||m[2]);
  for(const s of specs){ const r=resolve(s,f); if(r){ const rk=path.relative(root,r); if(!parents.has(rk)) parents.set(rk,key); if(!reached.has(rk)) queue.push(r); } }
}
const targets=['lib/model-runtime.ts','lib/model-catalog-refresh.ts','lib/builtin-extensions.ts','lib/mcp-host.ts','lib/mcp-test.ts','lib/mcp-sign-in.ts','lib/mcp-config-read.ts','lib/mcp-entry-request.ts','lib/codemode-settings.ts','lib/gfm-autolink-email-loader.cjs','lib/web-auth-proxy.ts'];
console.log('reachable count', reached.size);
for(const t of targets) console.log(t, reached.has(t)?('REACHED via '+(parents.get(t)||'app')):'not reached');
console.log('reached lib files:', [...reached].filter(x=>x.startsWith('lib/')).sort().join('\n'));
