// DegreePath companion pages. Plain JavaScript; requests use the logged-in session.
'use strict';
const $=s=>document.querySelector(s);
const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=document.body.dataset.page;
const message=(text,error=false)=>{const n=$('#feedback');if(n){n.textContent=text;n.className=error?'error-note':'notice';}else alert(text);};
async function api(url,options={}){
 const init={credentials:'same-origin',...options};
 if(options.body&&!(options.body instanceof FormData))init.headers={'Content-Type':'application/json',...(options.headers||{})};
 const response=await fetch(url,init);
 if(response.status===401){window.location.replace('/login.html');throw Error('Please log in.');}
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(result.error||'Request failed.');return result;
}
async function who(){
 const user=await api('/api/me');
 const name=$('#sidebarName');if(name)name.textContent=user.first_name||user.username;
 const top=$('#topName');if(top)top.textContent=user.username;
 document.querySelectorAll('.avatar').forEach(a=>a.textContent=(user.first_name||user.username||'U')[0].toUpperCase());
 document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===page));
 $('#mobileToggle')?.addEventListener('click',()=>$('.sidebar')?.classList.toggle('open'));
}
function tr(text,tag='div'){const el=document.createElement(tag);el.textContent=text;return el;}
function rowButton(label,callback){const b=tr(label,'button');b.className='btn btn-small';b.type='button';b.onclick=callback;return b;}

async function catalog(){
 const input=$('#catalogSearch'),select=$('#levelFilter'),target=$('#catalogRows');
 async function load(){
  const params=new URLSearchParams({q:input.value,level:select.value});
  const data=await api('/api/catalog?'+params);
  $('#count').textContent=data.count+' courses';target.replaceChildren();
  for(const c of data.courses){
   const r=document.createElement('tr');
   for(const value of [c.course_code,c.course_title,c.credits||'Not verified',c.verification_status==='title_only'?'Course title list':'Verified details'])r.appendChild(tr(value,'td'));
   const action=document.createElement('td');const link=tr('Add to My Courses','a');
   link.className='btn btn-small';link.href='/courses.html?code='+encodeURIComponent(c.course_code)+'&title='+encodeURIComponent(c.course_title);action.appendChild(link);r.appendChild(action);target.appendChild(r);
  }
  if(!data.courses.length)target.appendChild(tr('No matching courses.','tr'));
 }
 input.addEventListener('input',()=>load().catch(e=>message(e.message,true)));
 select.addEventListener('change',()=>load().catch(e=>message(e.message,true)));
 await load();
}

async function handbooks(){
 async function load(){
  const data=await api('/api/handbooks');const target=$('#handbookList');target.replaceChildren();
  $('#handbookCount').textContent=data.documents.length+' documents';
  for(const d of data.documents){
   const item=document.createElement('div');item.className='semester-course';
   const info=document.createElement('div');info.appendChild(tr(d.filename,'strong'));
   info.appendChild(tr('Pages: '+d.page_count+' · Uploaded '+new Date(d.uploaded_at).toLocaleDateString(),'small'));
   const actions=document.createElement('div');
   actions.appendChild(rowButton('Use as primary',async()=>{try{await api('/api/handbooks/'+d.id+'/primary',{method:'PUT'});message('Primary handbook updated. Your Dashboard and degree check now use this source.');await load();}catch(e){message(e.message,true);}}));
   actions.appendChild(rowButton('View text',async()=>{
    try{const full=await api('/api/handbooks/'+d.id);$('#handbookText').textContent=full.extracted_text;}catch(e){message(e.message,true);}
   }));
   const del=rowButton('Delete',async()=>{if(!confirm('Delete this uploaded handbook?'))return;try{await api('/api/handbooks/'+d.id,{method:'DELETE'});await load();message('Handbook deleted.');}catch(e){message(e.message,true);}});
   del.classList.add('btn-danger');actions.appendChild(del);item.append(info,actions);target.appendChild(item);
  }
  if(!data.documents.length)target.appendChild(tr('No handbooks uploaded yet.'));
 }
 $('#handbookUpload').addEventListener('submit',async e=>{
  e.preventDefault();const file=$('#handbookFile').files[0];if(!file)return;
  const form=new FormData();form.append('handbook',file);form.append('role',$('#handbookRole')?.value||'primary');
  try{const result=await api('/api/handbooks',{method:'POST',body:form});$('#handbookInfo').textContent=result.message;await load();await showHandbookRules();}catch(error){message(error.message,true);}
 });await load();await showHandbookRules();
}
async function showHandbookRules(){
 const box=$('#autoHandbookSummary');if(!box)return;box.replaceChildren();
 const d=await api('/api/degree-rules');
 const add=(name,value)=>{const row=tr('', 'p');row.append(tr(name+': ','strong'),tr(value));box.appendChild(row);};
 if(!d.source){add('Current status','Upload a handbook to identify university and program requirements.');return;}
 add('Primary/selected source',d.source);add('Recognition',d.detected?'GSU Computer Science Graduate Handbook recognized':'Unrecognized structure; manual verification required');
 if(d.university)add('University',d.university);if(d.program)add('Program',d.program);
 if(d.targetCredits!=null)add('Published minimum credits',d.targetCredits+' (GSU M.S.: CS bachelor holders only; non-CS background 56)');
 if(d.trackRules)add('Selected degree pathway',d.track+': '+d.trackRules.description);
 if(d.requirements?.minimumGrade)add('Minimum qualifying course grade',d.requirements.minimumGrade);
 if(d.possibleTotals?.length)add('Possible credit totals in document',d.possibleTotals.map(x=>x.credits).join(', ')+' (unverified; verify with program catalog)');
 for(const source of d.sourceLinks||[]){if(source.url){const link=tr(source.label,'a');link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';box.appendChild(link);}}
 const link=tr('Open updated dashboard →','a');link.href='/dashboard.html';link.className='btn btn-primary';box.appendChild(link);
}

const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
let meetings=[];
async function schedule(){
 const upload=$('#scheduleUpload'), manual=$('#meetingForm'), term=$('#scheduleTerm');
 let found=[];
 async function load(){
  meetings=(await api('/api/schedule')).meetings;
  const previous=term.value, terms=[...new Set(meetings.map(x=>x.term))].sort();
  term.replaceChildren();(terms.length?terms:['No schedule yet']).forEach(v=>term.append(new Option(v,v)));
  if(terms.includes(previous))term.value=previous;
  draw();
 }
 function draw(){
  const items=meetings.filter(m=>m.term===term.value);
  const grid=$('#weekGrid'), list=$('#meetingList'),warnings=$('#conflictList');
  grid.replaceChildren();list.replaceChildren();warnings.replaceChildren();
  const minutes=v=>Number(v.slice(0,2))*60+Number(v.slice(3));
  for(const day of DAYS){
   const col=tr('','div');col.className='week-col';col.append(tr(day,'strong'));
   const todays=items.filter(m=>m.day_name===day).sort((a,b)=>minutes(a.start_time)-minutes(b.start_time));
   todays.forEach((m,i)=>{
    for(const n of todays.slice(i+1))if(minutes(m.start_time)<minutes(n.end_time)&&minutes(n.start_time)<minutes(m.end_time)){
     const warn=tr(day+': '+m.course_code+' overlaps '+n.course_code);warn.className='warning';warnings.append(warn);
    }
    const block=tr('','div');block.className='class-block';
    block.append(tr(m.course_code,'strong'),tr(m.start_time+'–'+m.end_time,'span'),tr(m.room||'Room not supplied','span'),tr(m.instructor||'Instructor not supplied','span'));
    col.append(block);
   });grid.append(col);
  }
  items.forEach(m=>{
   const row=tr('','div');row.className='semester-course';
   row.append(tr(`${m.course_code} · ${m.day_name} · ${m.start_time}–${m.end_time} · ${m.room||'Room TBD'}`));
   const del=rowButton('Remove',async()=>{try{await api('/api/schedule/'+m.id,{method:'DELETE'});await load();}catch(e){message(e.message,true);}});
   del.classList.add('btn-danger');row.append(del);list.append(row);
  });
  if(!items.length)list.append(tr('No meetings for this semester yet. Upload a schedule or add one manually.'));
 }
 term.addEventListener('change',draw);
 manual.addEventListener('submit',async e=>{e.preventDefault();
  try{await api('/api/schedule',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(manual)))});manual.reset();await load();message('Class saved.');}
  catch(err){message(err.message,true);}
 });
 function review(rows,source){
  found=rows;const box=$('#scheduleReview'),target=$('#reviewRows');
  box.hidden=false;target.replaceChildren();$('#scheduleExtract').textContent=source||'';
  rows.forEach((m,i)=>{
   const part=tr('','div');part.className='review-row';part.append(tr('Class '+(i+1),'strong'));
   const g=tr('','div');g.className='form-grid';
   for(const [key,label] of [['course_code','Course code'],['title','Title'],['term','Semester'],['days','Days'],['start_time','Start HH:MM'],['end_time','End HH:MM'],['instructor','Instructor'],['room','Room']]){
    const f=tr('','div');f.className='field';const input=document.createElement('input');
    input.value=m[key]||'';input.dataset.row=i;input.dataset.field=key;
    f.append(tr(label,'label'),input);g.append(f);
   }part.append(g);target.append(part);
  });
  if(!rows.length)target.append(tr('No complete meeting times were detected. Use the extracted text below to enter your classes manually.'));
  $('#confirmImport').disabled=!rows.length;
 }
 upload.addEventListener('submit',async e=>{e.preventDefault();const file=$('#scheduleFile').files[0];if(!file)return;
  const f=new FormData();f.append('file',file);f.append('term',$('#importTerm').value.trim());
  const csv=file.name.toLowerCase().endsWith('.csv');
  $('#importStatus').textContent='Reading schedule...';
  try{const d=await api(csv?'/api/schedule/import-csv':'/api/schedule/preview',{method:'POST',body:f});
   $('#importStatus').textContent=d.message||'Review your detected classes.';
   if(csv)await load();else review(d.candidates||[],d.text);
  }catch(err){$('#importStatus').textContent=err.message;message(err.message,true);}
 });
 $('#confirmImport').addEventListener('click',async()=>{
  const data=found.map(x=>({...x}));
  document.querySelectorAll('#reviewRows input').forEach(el=>data[+el.dataset.row][el.dataset.field]=el.value.trim());
  try{const r=await api('/api/schedule/import-reviewed',{method:'POST',body:JSON.stringify({meetings:data})});
   $('#scheduleReview').hidden=true;message(r.message);await load();}
  catch(err){message(err.message,true);}
 });
 await load();
}
const TRACKS={
 'Course-only':{max6:4,min8:5,other:'CSC 8901, 1 credit'},
 'Project':{max6:3,min8:4,other:'CSC 8930, 4 credits'},
 'Thesis':{max6:2,min8:4,other:'CSC 8999, 6 credits'}
};
async function compare(){
 const form=$('#preferencesForm');
 const [documents,pref,courses,ruleData]=await Promise.all([api('/api/handbooks'),api('/api/preferences'),api('/api/courses'),api('/api/degree-rules')]);
 documents.documents.forEach(d=>$('#primaryHandbook').append(new Option(d.filename,d.id)));
 for(const [key,val] of Object.entries(pref))if(form.elements[key])form.elements[key].value=val??'';
 const selector=$('#compareTarget');
 const current=pref.track in TRACKS?pref.track:'Course-only';
 selector.value=current==='Course-only'?'Project':'Course-only';
 const clean=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
 const complete=courses.filter(c=>c.status==='completed'&&(!c.grade||['A','A+','A-','B','B+'].includes(c.grade.toUpperCase())));
 const eligible=complete.filter(c=>!['CSC6210','CSC6320','CSC6330','CSC6340','CSC6510','CSC6350','CSC6520','CSC7301','CSC7510','CSC7302','CSC7520','CSC7320','CSC7220'].includes(clean(c.code)));
 const num=c=>Number((c.code.match(/\d{4}/)||[])[0]||0);
 const count6=eligible.filter(c=>num(c)>=6000&&num(c)<7000).length;
 const count8=eligible.filter(c=>num(c)>=8000&&num(c)<9000&& !['CSC8901','CSC8930','CSC8999'].includes(clean(c.code))).length;
 const completedCredits=eligible.reduce((n,c)=>n+Number(c.credits||0),0);
 const ruleFor=name=>({name,max6:TRACKS[name].max6,min8:TRACKS[name].min8,special:{'Course-only':['CSC 8901',1],'Project':['CSC 8930',4],'Thesis':['CSC 8999',6]}[name]});
 const specialDone=(r)=>eligible.filter(c=>clean(c.code)===clean(r.special[0])).reduce((n,c)=>n+Number(c.credits||0),0);
 function makeCard(name,box){
  const r=ruleFor(name),special=specialDone(r),missing8=Math.max(0,r.min8-count8),moreSpecial=Math.max(0,r.special[1]-special);
  box.replaceChildren();box.append(tr(name+' track','h3'));
  for(const [label,value] of [
    ['6000-level limit',count6+' completed / max '+r.max6+(count6>r.max6?' — review needed':' — within limit')],
    ['8000-level requirement',count8+' completed / min '+r.min8+(missing8?' — '+missing8+' more course(s)':' — met')],
    ['Special course',r.special[0]+': '+special+' / '+r.special[1]+' credit(s)'+(moreSpecial?' — '+moreSpecial+' more credit(s)':' — met')],
    ['Completed eligible credits',completedCredits+'; published M.S. minimum 31 if applicable']
  ]){const p=tr('','p');p.append(tr(label+': ','strong'),tr(value));box.append(p);}
  if(ruleData.detected===false){const warn=tr('Upload a recognized program handbook to validate these track rules before treating them as official.');warn.className='warning';box.append(warn);}
 }
 const from=$('#currentTrackDetail'),to=$('#alternativeTrackDetail');
 const notice=$('#pathDifference');
 function render(){
  const selected=selector.value,orig=ruleFor(current),other=ruleFor(selected);
  makeCard(current,from);makeCard(selected,to);
  notice.replaceChildren();notice.append(tr(`Switching from ${current} to ${selected}`,'h3'));
  const diffs=[
    `Maximum 6000-level courses: ${orig.max6} → ${other.max6}`,
    `Minimum 8000-level courses: ${orig.min8} → ${other.min8}`,
    `Special requirement: ${orig.special[0]} (${orig.special[1]} credits) → ${other.special[0]} (${other.special[1]} credits)`
  ];
  diffs.forEach(x=>notice.append(tr(x,'p')));
  const needed=Math.max(0,other.min8-count8),required=Math.max(0,other.special[1]-specialDone(other));
  const emphasis=tr(`Based on your saved completed courses: ${needed} additional 8000-level classroom course(s) and ${required} credits of ${other.special[0]} may still be needed. Your 6000-level course count ${count6>other.max6?'exceeds':'is within'} this track's limit.`,'p');emphasis.className='notice';notice.append(emphasis);
  if(selected!=='Course-only')notice.append(tr('Project and thesis tracks also require a faculty research advisor and appropriate approval.','p'));
  notice.append(tr('These checks are advisory. Course grades, eligible credit status, prerequisites, substitutions, concentration requirements and your catalog year must also be reviewed.','small'));
 }
 selector.addEventListener('change',render);render();
 form.addEventListener('submit',async e=>{e.preventDefault();
  try{await api('/api/preferences',{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
   message('Preferences saved. Existing courses preserved.');location.reload();}
  catch(error){message(error.message,true);}
 });
}
async function audit(){
 const d=await api('/api/audit');
 $('#auditDone').textContent=d.completedCredits;$('#auditLeft').textContent=d.remainingCredits==null?'Not verified':d.remainingCredits;
 $('#audit6').textContent=d.count6000;$('#audit8').textContent=d.count8000;
 const box=$('#auditRules');if(!box)return;box.replaceChildren();
 const info=d.rules;if(!info){box.appendChild(tr('Program-specific rules are not configured. Use your personal requirements checklist.'));return;}
 box.appendChild(tr(d.preferences.track+' option','h3'));
 for(const line of [
  `Maximum ${info.maximum6000} completed 6000-level courses (count shown: ${d.count6000})`,
  `Minimum ${info.minimum8000} completed 8000-level courses (count shown: ${d.count8000})`,
  `Special requirement: ${info.required}`,
  d.creditTarget==null?'Total credits not automatically verified for this program.':`Published minimum: ${d.creditTarget} credits. ${d.totalCreditQualification||'Confirm eligibility with an advisor.'}`
 ]){const p=tr(line,'p');box.append(p);}
 if(d.possibleFoundation?.length)box.append(tr('Foundation-coded courses in completed list require individual review: '+d.possibleFoundation.join(', '),'p'));
}
(async()=>{try{await who();if(page==='catalog')await catalog();if(page==='handbooks')await handbooks();
 if(page==='schedule')await schedule();if(page==='compare')await compare();if(page==='audit')await audit();
 }catch(e){console.error(e);message(e.message,true);}})();
