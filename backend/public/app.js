// DegreePath client: session-authenticated API calls, rendering, and CRUD forms.
'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n || 0).toLocaleString(undefined,{maximumFractionDigits:1});
const statusText = { planned:'Planned', in_progress:'In progress', completed:'Completed' };
let courses = [], requirements = [], settings = {target_credits:null,degree_name:'Program not identified'}, me = null;
let filter = 'all', search = '';
let editing = null;
const page = document.body.dataset.page;

async function api(url, opts = {}) {
  const res = await fetch(url, { credentials:'same-origin', headers:{ 'Content-Type':'application/json', ...(opts.headers||{}) }, ...opts });
  if (res.status === 401) { location.href='/login.html'; throw new Error('Session expired.'); }
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function toast(message, error=false) {
  const box = $('#feedback'); if (!box) return alert(message);
  box.className = error ? 'error-note' : 'notice'; box.textContent = message; box.classList.remove('hide');
  setTimeout(()=>box.classList.add('hide'),4200);
}
function icon(name) { return ({book:'▤',check:'✓',clock:'◷',target:'◎'})[name] || '•'; }
function badge(s) {return `<span class="pill ${esc(s)}">${statusText[s]||esc(s)}</span>`;}
function completed() {return courses.filter(c=>c.status==='completed').reduce((a,c)=>a+Number(c.credits),0);}
function inProgress() {return courses.filter(c=>c.status==='in_progress').reduce((a,c)=>a+Number(c.credits),0);}
function planned() {return courses.filter(c=>c.status==='planned').reduce((a,c)=>a+Number(c.credits),0);}
function percentage() {return settings.target_credits==null?0:Math.min(100, Math.round(100*completed()/Math.max(1,settings.target_credits)));}
function $text(sel, value){const el=$(sel);if(el)el.textContent=value;}
function setHTML(sel, html){const el=$(sel);if(el)el.innerHTML=html;}
function navInit() {
  document.querySelectorAll('[data-nav]').forEach(a=>{ if(a.dataset.nav===page) a.classList.add('active'); });
  const toggle = $('#mobileToggle'); if(toggle) toggle.addEventListener('click',()=>$('.sidebar').classList.toggle('open'));
}
async function loadAll() {
  [me,settings,courses,requirements] = await Promise.all([api('/api/me'),api('/api/settings'),api('/api/courses'),api('/api/requirements')]);
  $text('#sidebarName',me.first_name||me.username); $text('#topName',me.username);
  const initial=(me.first_name || me.username || 'U').slice(0,1).toUpperCase();
  document.querySelectorAll('.avatar').forEach(a=>a.textContent=initial);
  $text('#degreeLabel',settings.degree_name);
  render();
}
function render(){
  if(page==='dashboard') renderDashboard();
  if(page==='courses') renderCourses();
  if(page==='planner') renderPlanner();
  if(page==='requirements') renderRequirements();
  if(page==='profile') renderProfile();
}
function renderDashboard(){
  $text('#welcomeName',(me.first_name||me.username).split(' ')[0]);
  $text('#metricCompleted',fmt(completed()));$text('#metricCurrent',fmt(inProgress()));$text('#metricPlanned',fmt(planned()));$text('#metricRemaining',settings.target_credits==null?'Not specified':fmt(Math.max(0,Number(settings.target_credits)-completed())));
  $text('#percentage',settings.target_credits==null?'—':percentage()+'%');$text('#progressFraction',settings.target_credits==null?`${fmt(completed())} credits marked completed · degree total not specified in handbook`:`${fmt(completed())} of ${fmt(settings.target_credits)} credits completed`);
  $('#progressRing').style.setProperty('--pct',percentage()+'%');
  $text('#legendCompleted',fmt(completed())+' cr');$text('#legendCurrent',fmt(inProgress())+' cr');$text('#legendPlanned',fmt(planned())+' cr');
  const total=Math.max(1,settings.target_credits||1);
  $('#stacked').innerHTML=settings.target_credits==null?'':`<span style="width:${Math.min(100,completed()/total*100)}%"></span><span style="width:${Math.min(100,Math.max(0,total-completed())/total*100,inProgress()/total*100)}%"></span><span style="width:${Math.min(100,Math.max(0,total-completed()-inProgress())/total*100,planned()/total*100)}%"></span>`;
  const current=courses.filter(c=>c.status==='in_progress').slice(0,5);
  setHTML('#currentCourses',current.length?current.map(c=>`<tr><td><strong>${esc(c.code)}</strong><br><span class="muted">${esc(c.title)}</span></td><td>${esc(c.semester)}</td><td>${fmt(c.credits)}</td><td>${badge(c.status)}</td></tr>`).join(''):`<tr><td colspan="4" class="empty">No courses in progress yet. Add your first course to get started.</td></tr>`);
  const recent=[...courses].sort((a,b)=>b.id-a.id).slice(0,4);
  setHTML('#recentCourses',recent.length?recent.map(c=>`<div class="semester-course"><div><strong>${esc(c.code)}</strong><small>${esc(c.title)}</small></div>${badge(c.status)}</div>`).join(''):'<div class="empty">Your recent courses will appear here.</div>');
}
function courseRows(data) {return data.map(c=>`<tr><td><strong>${esc(c.code)}</strong><br><span class="muted">${esc(c.title)}</span></td><td>${esc(c.semester)}</td><td>${fmt(c.credits)}</td><td>${badge(c.status)}</td><td>${esc(c.grade||'—')}</td><td><button class="btn btn-small" data-edit-course="${c.id}">Edit</button> <button class="btn btn-small btn-danger" data-delete-course="${c.id}">Delete</button></td></tr>`).join('');}
function renderCourses(){
 const data=courses.filter(c=>(filter==='all'||filter===c.status)&&`${c.code} ${c.title} ${c.semester}`.toLowerCase().includes(search));
 $text('#courseCount',`${data.length} course${data.length===1?'':'s'}`);
 setHTML('#courseRows',data.length?courseRows(data):'<tr><td colspan="6" class="empty">No matching courses. Add one using the button above.</td></tr>');
 document.querySelectorAll('.chip').forEach(ch=>ch.classList.toggle('active',ch.dataset.filter===filter));
}
function renderPlanner(){
 const grouped = {}; courses.forEach(c=>(grouped[c.semester]??=[]).push(c));
 const terms=Object.keys(grouped).sort((a,b)=>{const key=t=>{const m=t.match(/(Spring|Summer|Fall|Winter)\s+(\d{4})/i);return m?Number(m[2])*4+({winter:0,spring:1,summer:2,fall:3}[m[1].toLowerCase()]):99999;};return key(a)-key(b)||a.localeCompare(b)});
 setHTML('#semesterGrid',terms.length?terms.map(term=>`<section class="semester-card"><div class="semester-header"><h3>${esc(term)}</h3><span class="pill">${fmt(grouped[term].reduce((s,c)=>s+Number(c.credits),0))} credits</span></div>${grouped[term].map(c=>`<div class="semester-course"><div><strong>${esc(c.code)}</strong><small>${esc(c.title)} · ${fmt(c.credits)} credits</small></div>${badge(c.status)}</div>`).join('')}</section>`).join(''):'<div class="panel empty">No semesters yet. Add a course and assign it to a semester.</div>');
}
async function renderRequirements(){
 const target=$('#requirementRows');if(!target)return;
 const addButton=document.querySelector('[data-open="requirement"]');
 try {
   const d=await api('/api/degree-rules');
   if(d.detected){
     if(addButton)addButton.hidden=true;
     $text('#reqCount','Automatically read from '+d.source);
     $text('#degreeTarget',d.targetCredits==null?'Not verified':d.targetCredits+' published minimum credits');
     target.replaceChildren();
     const add=(title,body)=>{const wrap=document.createElement('div');wrap.className='requirement-item';
       const strong=document.createElement('strong');strong.textContent=title;
       const p=document.createElement('p');p.className='subtext';p.textContent=body;
       wrap.append(strong,p);target.appendChild(wrap);};
     add('Source',d.source);
     if(d.degree_level==='Masters'){
       add('Selected track',d.track);
       if(d.trackRules){add('6000-level maximum',d.trackRules.max6000+' courses');
         add('8000-level minimum',d.trackRules.min8000+' courses');
         add('Special requirement',d.trackRules.specialCode+' · '+d.trackRules.specialCredits+' credits');}
       add('Minimum course grade','B for courses counting toward CS graduate degrees');
       add('Published M.S. minimum','31 credits for CS bachelor holders; 56 hours for applicants without a CS bachelor (official GSU program page).');
     }else if(d.degree_level==='PhD'){
       add('Doctoral credits','72 total: 48 course credits and 24 dissertation credits');
     }
     add('Foundation courses','Background requirements do not automatically count toward the degree.');
   if(d.sourceLinks?.length){for(const source of d.sourceLinks){if(source.url){const a=document.createElement('a');a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='View official credit source';target.appendChild(a);}}}
     return;
   }
 }catch(err){console.error(err);}
 // For non-recognized handbooks only, retain editable personal requirement checklists.
 if(addButton)addButton.hidden=false;
 $text('#reqCount',`${requirements.length} requirement${requirements.length===1?'':'s'}`);
 setHTML('#requirementRows',requirements.length?requirements.map(r=>`<div class="requirement-item"><div class="requirement-head"><div><strong>${esc(r.name)}</strong><div class="subtext">${esc(r.notes||'Personal requirement')}</div></div><div style="text-align:right"><strong>${fmt(r.required_credits)} credits</strong><div style="margin-top:9px"><button class="btn btn-small" data-edit-req="${r.id}">Edit</button> <button class="btn btn-small btn-danger" data-delete-req="${r.id}">Delete</button></div></div></div></div>`).join(''):'<div class="empty">Upload your program handbook to identify requirements automatically, or add a personal note for an unrecognized program.</div>');
 $text('#degreeTarget',settings.target_credits==null?'Not verified':`${fmt(settings.target_credits)} credits`);
}
async function renderProfile(){
 $text('#profileUsername',me.username); $text('#profileEmail',me.email);
 if($('#first_name')){$('#first_name').value=me.first_name||'';$('#last_name').value=me.last_name||'';}
 const target=$('#automaticDegree');if(!target)return;
 try{
   const d=await api('/api/degree-rules');target.replaceChildren();
   const add=(label,value)=>{const line=document.createElement('p');
     const strong=document.createElement('strong');strong.textContent=label+': ';
     line.append(strong,document.createTextNode(value));target.appendChild(line);};
   if(!d.detected){
     add('No recognized program handbook','Upload your official handbook in Handbooks.');
     const link=document.createElement('a');link.href='/handbooks.html';link.textContent='Upload a handbook';target.appendChild(link);return;
   }
   add('University',d.university);add('Program',d.program);
   add('Handbook source',d.source);add('Degree level',d.degree_level);
   add('Selected pathway',d.track);
   if(d.degree_level==='Masters'){
     add('Published M.S. minimum',d.targetCredits+' credits (CS bachelor holders); 56 hours without a CS bachelor. Source: official GSU program page.');
     if(d.trackRules){add('6000-level courses','Maximum '+d.trackRules.max6000);
       add('8000-level courses','Minimum '+d.trackRules.min8000);
       add('Required special course',d.trackRules.specialCode+' ('+d.trackRules.specialCredits+' credits)');}
     add('Grade threshold','B for courses counting toward the graduate degree');
   }else if(d.degree_level==='PhD')add('Doctoral total','72 credits (48 course + 24 dissertation)');
   add('Foundation courses','Background requirements; not automatically degree-applicable.');
   const link=document.createElement('a');link.href='/compare.html';link.textContent='Change pathway (only if your personal choice changes)';target.appendChild(link);
 }catch(err){target.textContent=err.message;}
}
function openModal(which,id=null){
 editing=id;
 const isCourse=which==='course';
 $('#modalTitle').textContent=(id?'Edit ':'Add ')+(isCourse?'course':'requirement');
 $('#courseForm').classList.toggle('hide',!isCourse); $('#requirementForm').classList.toggle('hide',isCourse);
 if(isCourse){
  const form=$('#courseForm');form.reset();
  if(id){const c=courses.find(x=>x.id===id);if(c)Object.keys(c).forEach(k=>{if(form.elements[k])form.elements[k].value=c[k]??'';});}
 }else{
  const form=$('#requirementForm');form.reset();
  if(id){const r=requirements.find(x=>x.id===id);if(r)Object.keys(r).forEach(k=>{if(form.elements[k])form.elements[k].value=r[k]??'';});}
 }
 $('#modal').classList.remove('hide');$('#modal').dataset.type=which;
}
function closeModal(){$('#modal').classList.add('hide');}
async function saveForm(event,which){
 event.preventDefault();const form=event.target;const data=Object.fromEntries(new FormData(form));
 const endpoint=which==='course'?'courses':'requirements';const url=`/api/${endpoint}${editing?'/'+editing:''}`;
 try{await api(url,{method:editing?'PUT':'POST',body:JSON.stringify(data)});closeModal(); await loadAll();toast(`${which==='course'?'Course':'Requirement'} saved.`);}catch(err){toast(err.message,true);}
}
async function removeItem(which,id){
 if(!confirm(`Delete this ${which}? This cannot be undone.`))return;
 try{await api(`/api/${which==='course'?'courses':'requirements'}/${id}`,{method:'DELETE'});await loadAll();toast('Deleted successfully.');}catch(err){toast(err.message,true);}
}
function initInteractions(){
 document.addEventListener('click',async e=>{
  const btn=e.target.closest('button'); if(!btn)return;
  if(btn.dataset.open)openModal(btn.dataset.open);
  if(btn.dataset.editCourse)openModal('course',Number(btn.dataset.editCourse));
  if(btn.dataset.editReq)openModal('requirement',Number(btn.dataset.editReq));
  if(btn.dataset.deleteCourse)await removeItem('course',btn.dataset.deleteCourse);
  if(btn.dataset.deleteReq)await removeItem('requirement',btn.dataset.deleteReq);
  if(btn.dataset.closeModal!==undefined)closeModal();
  if(btn.dataset.filter){filter=btn.dataset.filter;renderCourses();}
 });
 const modal=$('#modal');if(modal)modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal)closeModal();});
 $('#courseForm')?.addEventListener('submit',e=>saveForm(e,'course'));
 $('#requirementForm')?.addEventListener('submit',e=>saveForm(e,'requirement'));
 $('#search')?.addEventListener('input',e=>{search=e.target.value.toLowerCase();renderCourses();});
 $('#profileForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/me',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});await loadAll();toast('Profile updated.')}catch(err){toast(err.message,true)}});
 $('#settingsForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/settings',{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});await loadAll();toast('Degree settings saved.')}catch(err){toast(err.message,true)}});
}
navInit();initInteractions();if(page==='courses'){const q=new URLSearchParams(location.search);if(q.has('code')){openModal('course');$('#code').value=q.get('code')||'';$('#title').value=q.get('title')||'';}}loadAll().catch(err=>{console.error(err);toast(err.message,true);});
