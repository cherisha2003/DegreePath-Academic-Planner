// DegreePath extras: catalog, handbooks, class calendar, preferences and degree checks.
// All personal endpoints are protected by server-side login sessions.
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { parse } = require('csv-parse/sync');
const {parseClassSchedule} = require('./schedule-parser');
const { recognizeHandbook, analyzeHandbook, FOUNDATION_CODES } = require('./handbook-rules');

function setupExtras(app, db, auth, fail) {
  const fileUpload = multer({storage:multer.memoryStorage(), limits:{fileSize:12*1024*1024}});
  const id = req => req.session.user.user_id;
  const str = (v,n=150)=>String(v??'').trim().slice(0,n);
  const safe = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(err=>{
    console.error('DegreePath API failure:', req.method, req.path, err);
    if (res.headersSent) return next(err);
    return fail(res,500,'Database operation failed. Check the Codespaces terminal for details.');
  });
  // Earlier calendar releases called the primary key meeting_id rather than id.
  // Keep compatibility with both schemas without deleting any stored meetings.
  let meetingPrimaryKey = 'id';

  async function initializeExtras() {
    // Non-destructive initialization; existing account and course tables are preserved.
    await db.query(`CREATE TABLE IF NOT EXISTS degree_settings (
      user_id INT PRIMARY KEY, degree_name VARCHAR(140) NOT NULL, target_credits INT NOT NULL DEFAULT 36,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE)`);
    await db.query(`CREATE TABLE IF NOT EXISTS courses (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, code VARCHAR(24) NOT NULL,
      title VARCHAR(140) NOT NULL, credits DECIMAL(4,1) NOT NULL,
      semester VARCHAR(70) NOT NULL, status ENUM('planned','in_progress','completed') NOT NULL DEFAULT 'planned',
      grade VARCHAR(8) NOT NULL DEFAULT '', category VARCHAR(80) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_courses_owner (user_id), FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE)`);
    await db.query(`CREATE TABLE IF NOT EXISTS requirements (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
      name VARCHAR(100) NOT NULL, required_credits DECIMAL(5,1) NOT NULL,
      notes VARCHAR(500) NOT NULL DEFAULT '', INDEX idx_reqs_owner (user_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE)`);
    await db.query(`CREATE TABLE IF NOT EXISTS gsu_catalog_courses (
      course_code VARCHAR(30) PRIMARY KEY, course_title VARCHAR(255) NOT NULL,
      credits VARCHAR(40) NULL, description TEXT NULL, prerequisites TEXT NULL,
      catalog_year VARCHAR(40) NULL, source VARCHAR(255) NULL,
      verification_status VARCHAR(40) NOT NULL DEFAULT 'title_only')`);
    await db.query(`CREATE TABLE IF NOT EXISTS degree_preferences (
      user_id INT PRIMARY KEY, university VARCHAR(120) NOT NULL DEFAULT 'Georgia State University',
      program VARCHAR(120) NOT NULL DEFAULT 'Computer Science',
      degree_level VARCHAR(30) NOT NULL DEFAULT 'Masters', track VARCHAR(30) NOT NULL DEFAULT 'Course-only',
      graduation_term VARCHAR(50) NOT NULL DEFAULT '', primary_handbook_id INT NULL)`);
    await db.query(`CREATE TABLE IF NOT EXISTS uploaded_handbooks (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, filename VARCHAR(255) NOT NULL,
      extracted_text MEDIUMTEXT NOT NULL, page_count INT NOT NULL DEFAULT 0,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_handbook_owner (user_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS class_meetings (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, course_code VARCHAR(30) NOT NULL,
      title VARCHAR(160) NOT NULL DEFAULT '', term VARCHAR(50) NOT NULL,
      day_name VARCHAR(3) NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL,
      instructor VARCHAR(120) NOT NULL DEFAULT '', room VARCHAR(120) NOT NULL DEFAULT '',
      crn VARCHAR(30) NOT NULL DEFAULT '', credits DECIMAL(4,1) NULL,
      INDEX idx_meeting_owner (user_id, term))`);
    const [meetingColumns] = await db.query('SHOW COLUMNS FROM class_meetings');
    const meetingColumnNames = new Set(meetingColumns.map(col => col.Field));
    if (!meetingColumnNames.has('id') && meetingColumnNames.has('meeting_id')) {
      meetingPrimaryKey = 'meeting_id';
    } else if (!meetingColumnNames.has('id')) {
      throw new Error('class_meetings has no recognized primary key (id or meeting_id).');
    }
    await db.query(`CREATE TABLE IF NOT EXISTS uploaded_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, filename VARCHAR(255) NOT NULL,
      extracted_text MEDIUMTEXT NOT NULL, uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    // Import older DegreePath records into the new CRUD interface when present.
    // Keep the original tables intact and remember each imported legacy record.
    await db.query(`CREATE TABLE IF NOT EXISTS degreepath_legacy_imports (
      record_kind VARCHAR(30) NOT NULL, legacy_id INT NOT NULL,
      imported_id INT NOT NULL, PRIMARY KEY (record_kind,legacy_id))`);
    const [tables]=await db.query("SHOW TABLES");
    const present=new Set(tables.map(row=>String(Object.values(row)[0])));
    if(present.has('student_planned_courses')){
      const [legacy]=await db.query(`SELECT id,user_id,course_code,course_title,credits,semester,status
        FROM student_planned_courses ORDER BY id`);
      for(const c of legacy){
        const [prior]=await db.execute(`SELECT imported_id FROM degreepath_legacy_imports
         WHERE record_kind='course' AND legacy_id=?`,[c.id]);
        if(prior.length)continue;
        const status=({'Planned':'planned','In Progress':'in_progress','Completed':'completed'})[c.status]||'planned';
        const [result]=await db.execute(`INSERT INTO courses
         (user_id,code,title,credits,semester,status,grade,category)
         VALUES(?,?,?,?,?,?,?,?)`,[c.user_id,c.course_code,c.course_title||'',c.credits??0,
         c.semester||'Unassigned',status,'','Imported from prior planner']);
        await db.execute('INSERT INTO degreepath_legacy_imports VALUES(?,?,?)',['course',c.id,result.insertId]);
      }
    }
    if(present.has('handbook_documents')&&present.has('handbook_pages')){
      const [legacy]=await db.query(`SELECT document_id,user_id,filename,total_pages FROM handbook_documents`);
      for(const d of legacy){
        const [prior]=await db.execute(`SELECT imported_id FROM degreepath_legacy_imports
         WHERE record_kind='handbook' AND legacy_id=?`,[d.document_id]);
        if(prior.length)continue;
        const [pages]=await db.execute(`SELECT extracted_text FROM handbook_pages
          WHERE document_id=? ORDER BY page_number`,[d.document_id]);
        const body=pages.map(p=>p.extracted_text).join('\n\n').slice(0,2000000);
        const [r]=await db.execute(`INSERT INTO uploaded_handbooks
         (user_id,filename,extracted_text,page_count) VALUES (?,?,?,?)`,
         [d.user_id,d.filename,body,d.total_pages]);
        await db.execute('INSERT INTO degreepath_legacy_imports VALUES(?,?,?)',['handbook',d.document_id,r.insertId]);
      }
    }
    if(present.has('student_degree_plans')){
      const [legacy]=await db.query(`SELECT user_id,program_name,degree_level,degree_track,
        graduation_term,primary_document_id FROM student_degree_plans`);
      for(const d of legacy){
        const [prior]=await db.execute('SELECT user_id FROM degree_preferences WHERE user_id=?',[d.user_id]);
        if(prior.length)continue;
        const [oldDoc]=await db.execute(`SELECT imported_id FROM degreepath_legacy_imports
         WHERE record_kind='handbook' AND legacy_id=?`,[d.primary_document_id]);
        const level= /master/i.test(d.degree_level)?'Masters':/phd|doctor/i.test(d.degree_level)?'PhD':'Bachelors';
        const raw=String(d.degree_track||'');
        const track=/project/i.test(raw)?'Project':/thesis/i.test(raw)?'Thesis':'Course-only';
        await db.execute(`INSERT INTO degree_preferences
        (user_id,university,program,degree_level,track,graduation_term,primary_handbook_id)
        VALUES(?,?,?,?,?,?,?)`,[d.user_id,'Georgia State University',d.program_name,level,track,
        d.graduation_term,oldDoc[0]?.imported_id??null]);
      }
    }

    // Seed only verified-by-user course codes/titles. Never guess credit hours or professors.
    const csv=fs.readFileSync(path.join(__dirname,'gsu_cs_catalog.csv'),'utf8');
    const rows=parse(csv,{columns:true,bom:true,skip_empty_lines:true});
    for (const c of rows) {
      await db.execute(`INSERT INTO gsu_catalog_courses
       (course_code,course_title,credits,description,prerequisites,catalog_year,source,verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE course_title=VALUES(course_title)`,[
       c.course_code,c.course_title,c.credits||null,c.description||null,c.prerequisites||null,
       c.catalog_year||null,c.source||'Student supplied GSU catalog',c.verification_status||'title_only']);
    }
  }

  app.get('/api/catalog', auth, safe(async(req,res)=>{
    const q=str(req.query.q,100); const level=str(req.query.level,1);
    let sql=`SELECT course_code,course_title,credits,description,prerequisites,source,verification_status FROM gsu_catalog_courses WHERE 1=1`;
    let args=[];
    if(q){sql+=` AND (course_code LIKE ? OR course_title LIKE ?)`;args.push('%'+q+'%','%'+q+'%');}
    if(/^[6789]$/.test(level)){sql+=` AND SUBSTRING_INDEX(course_code,' ',-1) LIKE ?`;args.push(level+'%');}
    sql+=' ORDER BY course_code';
    const [rows]=await db.execute(sql,args);res.json({courses:rows,count:rows.length});
  }));

  app.get('/api/preferences',auth,safe(async(req,res)=>{
    const [rows]=await db.execute('SELECT * FROM degree_preferences WHERE user_id=?',[id(req)]);
    res.json(rows[0]||{university:'Georgia State University',program:'Computer Science',degree_level:'Masters',track:'Course-only',graduation_term:'',primary_handbook_id:null});
  }));
  app.put('/api/preferences',auth,safe(async(req,res)=>{
    const d=req.body;
    const university=str(d.university,120),program=str(d.program,120),level=str(d.degree_level,30),track=str(d.track,30),term=str(d.graduation_term,50);
    if(!university||!program||!['Bachelors','Masters','PhD'].includes(level)||!['Course-only','Project','Thesis','Research'].includes(track))
       return fail(res,400,'Provide a university, program, level and track.');
    const doc=d.primary_handbook_id==null||d.primary_handbook_id===''?null:Number(d.primary_handbook_id);
    if(doc!==null){const [check]=await db.execute('SELECT id FROM uploaded_handbooks WHERE id=? AND user_id=?',[doc,id(req)]);if(!check.length)return fail(res,400,'Handbook does not belong to this account.');}
    await db.execute(`INSERT INTO degree_preferences
      (user_id,university,program,degree_level,track,graduation_term,primary_handbook_id)
      VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE university=VALUES(university),
      program=VALUES(program),degree_level=VALUES(degree_level),track=VALUES(track),
      graduation_term=VALUES(graduation_term),primary_handbook_id=VALUES(primary_handbook_id)`,
      [id(req),university,program,level,track,term,doc]);
    res.json({message:'Degree preferences saved.'});
  }));

  // Identify the uploaded program handbook and its actual documented requirements.
  app.get('/api/degree-rules',auth,safe(async(req,res)=>{
    const [prefs]=await db.execute('SELECT * FROM degree_preferences WHERE user_id=?',[id(req)]);
    const [docs]=await db.execute(`SELECT id,filename,extracted_text FROM uploaded_handbooks
       WHERE user_id=? ORDER BY id DESC`,[id(req)]);
    const pref=prefs[0]||null;
    const primary=docs.find(d=>d.id===pref?.primary_handbook_id);
    const selected=primary||docs.find(d=>recognizeHandbook(d.extracted_text))||docs[0];
    const analysis=selected?analyzeHandbook(selected.extracted_text):null;
    const detected=analysis?.recognized?analysis:null;
    res.json({detected:!!detected,source: selected?.filename||null,
      program:detected?.program||null,university:detected?.school||null,
      degree_level:pref?.degree_level||'Masters',track:pref?.track||'Course-only',
      requirements:analysis||null,
      trackRules:detected?.ms[pref?.track||'Course-only']||null,
      targetCredits:detected?(pref?.degree_level==='PhD'?72:31):null,
      creditConditions:detected?.msCreditsCondition||null,
      sourceLinks:analysis?.sources||[],
      possibleTotals:analysis?.possibleTotals||[],
      note:detected?'Track requirements from uploaded GSU handbook; M.S. credit minimum from official GSU program page. Track selection and student course history cannot be inferred from handbook alone.':(selected?'Handbook text analyzed; some fields require review because the format is not yet recognized.':'Upload the applicable program handbook to populate these fields.')});
  }));

  app.get('/api/handbooks',auth,safe(async(req,res)=>{
    const [rows]=await db.execute(`SELECT id,filename,page_count,uploaded_at,LEFT(extracted_text,1800) AS preview
      FROM uploaded_handbooks WHERE user_id=? ORDER BY id DESC`,[id(req)]);
    res.json({documents:rows});
  }));
  app.post('/api/handbooks',auth,fileUpload.single('handbook'),safe(async(req,res)=>{
    if(!req.file || req.file.buffer.subarray(0,5).toString()!=='%PDF-')return fail(res,400,'Choose a valid PDF handbook.');
    let pdf;try{pdf=await pdfParse(req.file.buffer);}catch{return fail(res,422,'Unable to read the PDF.');}
    const txt=str(pdf.text,2000000);
    if(!txt)return fail(res,422,'No selectable PDF text found; scanned PDFs require OCR.');
    const [result]=await db.execute('INSERT INTO uploaded_handbooks (user_id,filename,extracted_text,page_count) VALUES (?,?,?,?)',
      [id(req),str(req.file.originalname,255),txt,pdf.numpages||0]);
    const analysis=analyzeHandbook(txt);
    const detected=analysis?.recognized?analysis:null;
    const uploadAsPrimary=req.body.role!=='secondary';
    if(detected&&uploadAsPrimary){
      // On first recognized handbook only, establish the source and auto-detect the program.
      await db.execute(`INSERT INTO degree_preferences
        (user_id,university,program,degree_level,track,primary_handbook_id)
        VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
        primary_handbook_id=VALUES(primary_handbook_id), university=VALUES(university), program=VALUES(program)`,
        [id(req),detected.school,detected.program,'Masters','Course-only',result.insertId]);
    }
    res.status(201).json({id:result.insertId,detected:!!detected,
      message:detected?(uploadAsPrimary?'GSU CS handbook recognized and set as your primary source. Refresh Dashboard to see its degree rules.':'GSU CS handbook added as a secondary reference.'):'Handbook uploaded and analyzed. Review any unrecognized rules.'});
  }));
  app.put('/api/handbooks/:documentId/primary',auth,safe(async(req,res)=>{
    const [docs]=await db.execute('SELECT id,extracted_text FROM uploaded_handbooks WHERE id=? AND user_id=?',[req.params.documentId,id(req)]);
    if(!docs.length)return fail(res,404,'Handbook not found.');
    const recognized=recognizeHandbook(docs[0].extracted_text);
    const school=recognized?.school||'Georgia State University';
    const program=recognized?.program||'Computer Science';
    const [existing]=await db.execute('SELECT user_id FROM degree_preferences WHERE user_id=?',[id(req)]);
    if(existing.length){
      await db.execute(`UPDATE degree_preferences SET primary_handbook_id=?,
        university=IF(?, ?, university), program=IF(?, ?, program) WHERE user_id=?`,
        [docs[0].id,!!recognized,school,!!recognized,program,id(req)]);
    }else{
      await db.execute(`INSERT INTO degree_preferences (user_id,university,program,degree_level,track,primary_handbook_id)
        VALUES (?,?,?,?,?,?)`,[id(req),school,program,'Masters','Course-only',docs[0].id]);
    }
    res.json({message:'Primary handbook selected; requirements and dashboard updated.',detected:!!recognized});
  }));
  app.get('/api/handbooks/:documentId',auth,safe(async(req,res)=>{
    const [rows]=await db.execute('SELECT id,filename,extracted_text,page_count FROM uploaded_handbooks WHERE id=? AND user_id=?',[req.params.documentId,id(req)]);
    if(!rows.length)return fail(res,404,'Handbook not found.');res.json(rows[0]);
  }));
  app.delete('/api/handbooks/:documentId',auth,safe(async(req,res)=>{
    await db.execute('UPDATE degree_preferences SET primary_handbook_id=NULL WHERE user_id=? AND primary_handbook_id=?',[id(req),req.params.documentId]);
    const [r]=await db.execute('DELETE FROM uploaded_handbooks WHERE id=? AND user_id=?',[req.params.documentId,id(req)]);
    if(!r.affectedRows)return fail(res,404,'Handbook not found.');res.json({message:'Handbook deleted.'});
  }));

  const names={M:'Mon',T:'Tue',W:'Wed',R:'Thu',F:'Fri',MON:'Mon',TUE:'Tue',WED:'Wed',THU:'Thu',FRI:'Fri',SAT:'Sat',SUN:'Sun',MONDAY:'Mon',TUESDAY:'Tue',WEDNESDAY:'Wed',THURSDAY:'Thu',FRIDAY:'Fri',SATURDAY:'Sat',SUNDAY:'Sun'};
  function meeting(data){
    const code=str(data.course_code,30).toUpperCase(),title=str(data.title,160),term=str(data.term,50);
    const value=str(data.days,70).toUpperCase();
    const dayCodes=/^[MTWRF]+$/.test(value)?[...value]:value.split(/[\s,;/&-]+/);
    const days=[...new Set(dayCodes.map(d=>names[d]).filter(Boolean))];
    const start=str(data.start_time,5),end=str(data.end_time,5);
    const fmt=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
    const credits=(data.credits===''||data.credits==null)?null:Number(data.credits);
    if(!code||!term||!days.length||!fmt.test(start)||!fmt.test(end)||minutes(start)>=minutes(end)||
       (credits!==null&&(!Number.isFinite(credits)||credits<0||credits>12)))throw Error('Check course, term, days and 24-hour start/end times.');
    return {code,title,term,days,start,end,instructor:str(data.instructor,120),room:str(data.room,120),crn:str(data.crn,30),credits};
  }
  async function addMeeting(conn,user,m){
    for(const day of m.days){await conn.execute(`INSERT INTO class_meetings
      (user_id,course_code,title,term,day_name,start_time,end_time,instructor,room,crn,credits)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[user,m.code,m.title,m.term,day,m.start,m.end,m.instructor,m.room,m.crn,m.credits]);}
  }
  app.get('/api/schedule',auth,safe(async(req,res)=>{
    const [rows]=await db.execute(`SELECT ${meetingPrimaryKey} AS id,course_code,title,term,day_name,
    TIME_FORMAT(start_time,'%H:%i') AS start_time,TIME_FORMAT(end_time,'%H:%i') AS end_time,
    instructor,room,crn,credits FROM class_meetings WHERE user_id=? ORDER BY term,start_time`,[id(req)]);
    res.json({meetings:rows});
  }));
  app.post('/api/schedule',auth,safe(async(req,res)=>{
    let m;try{m=meeting(req.body);}catch(e){return fail(res,400,e.message);}
    const conn=await db.getConnection();try{await conn.beginTransaction();await addMeeting(conn,id(req),m);await conn.commit();}
    catch(e){await conn.rollback();throw e;}finally{conn.release();}res.status(201).json({message:'Class meeting saved.'});
  }));
  app.delete('/api/schedule/:id',auth,safe(async(req,res)=>{
    if(!/^\d+$/.test(req.params.id))return fail(res,400,'Invalid meeting ID.');
    const [r]=await db.execute(`DELETE FROM class_meetings WHERE ${meetingPrimaryKey}=? AND user_id=?`,[req.params.id,id(req)]);
    if(!r.affectedRows)return fail(res,404,'Meeting not found.');res.json({message:'Meeting removed.'});
  }));
  app.post('/api/schedule/import-csv',auth,fileUpload.single('file'),safe(async(req,res)=>{
    if(!req.file||!req.file.originalname.toLowerCase().endsWith('.csv'))return fail(res,400,'Choose a CSV schedule file.');
    let rows,items;try{rows=parse(req.file.buffer.toString('utf8'),{columns:true,bom:true,skip_empty_lines:true,trim:true});
      if(!rows.length||rows.length>100)return fail(res,400,'CSV must have 1–100 rows.');
      items=rows.map(meeting);}catch(e){return fail(res,400,'Invalid CSV: '+e.message);}
    const conn=await db.getConnection();try{await conn.beginTransaction();for(const m of items)await addMeeting(conn,id(req),m);await conn.commit();}
    catch(e){await conn.rollback();throw e;}finally{conn.release();}
    res.status(201).json({message:`Imported ${items.length} schedule rows.`});
  }));
  app.post('/api/schedule/import-pdf',auth,fileUpload.single('file'),safe(async(req,res)=>{
    if(!req.file||req.file.buffer.subarray(0,5).toString()!=='%PDF-')return fail(res,400,'Choose a PDF schedule.');
    let parsed;try{parsed=await pdfParse(req.file.buffer);}catch{return fail(res,422,'Could not read this PDF.');}
    const text=str(parsed.text,2000000);if(!text)return fail(res,422,'PDF has no readable text.');
    await db.execute('INSERT INTO uploaded_schedules (user_id,filename,extracted_text) VALUES (?,?,?)',[id(req),str(req.file.originalname,255),text]);
    res.status(201).json({message:'Schedule text extracted. Review and enter class meetings below.',text:text.slice(0,10000)});
  }));

  // Extract class meetings from screenshots and PDF exports. Review before database write.
  app.post('/api/schedule/preview',auth,fileUpload.single('file'),safe(async(req,res)=>{
    if(!req.file)return fail(res,400,'Choose a class schedule image or PDF.');
    const ext=String(req.file.originalname).toLowerCase();
    let extracted='';
    if(ext.endsWith('.pdf') && req.file.buffer.subarray(0,5).toString()==='%PDF-'){
      try{const pdf=await pdfParse(req.file.buffer);extracted=String(pdf.text||'');}
      catch{return fail(res,422,'Could not extract the schedule PDF.');}
    }else if(/\.(png|jpe?g|webp)$/.test(ext)&&/^image\/(png|jpeg|webp)$/.test(req.file.mimetype)){
      // OCR uses Tesseract.js. Its language data might download on first use.
      let worker;
      try{
        const {createWorker}=require('tesseract.js');
        worker=await createWorker('eng');
        const result=await worker.recognize(req.file.buffer);
        extracted=String(result.data.text||'');
      }catch(e){console.error('Schedule OCR error:',e);return fail(res,422,'Unable to read this screenshot. Try a clearer image or a text-based PDF.');}
      finally{if(worker)await worker.terminate().catch(()=>{});}
    }else return fail(res,400,'Use PNG, JPG, WEBP, or PDF for recognition, or CSV for direct import.');
    if(!extracted.trim())return fail(res,422,'No text could be read from the schedule.');
    const term=str(req.body.term,50)||'Unspecified term';
    const candidates=parseClassSchedule(extracted,term);
    // The registrar exports titles, section numbers and dates in different columns.
    // Use the imported catalog name instead of treating CRN/date text as a course title.
    if (candidates.length) {
      const codes=[...new Set(candidates.map(c=>c.course_code))];
      const placeholders=codes.map(()=>'?').join(',');
      const [known]=await db.query(`SELECT course_code,course_title FROM gsu_catalog_courses WHERE course_code IN (${placeholders})`,codes);
      const knownTitles=new Map(known.map(c=>[c.course_code,c.course_title]));
      for (const c of candidates) {
        if (knownTitles.has(c.course_code)) c.title=knownTitles.get(c.course_code);
      }
    }
    res.json({message:candidates.length?`Found ${candidates.length} possible class meeting(s). Review before saving.`:'No complete meeting records found; review the extracted text.',candidates,text:extracted.slice(0,18000)});
  }));
  app.post('/api/schedule/import-reviewed',auth,safe(async(req,res)=>{
    const rows=req.body.meetings;
    if(!Array.isArray(rows)||!rows.length||rows.length>80)return fail(res,400,'Provide 1–80 reviewed class meetings.');
    let items;
    try{items=rows.map(meeting);}catch(e){return fail(res,400,e.message);}
    const conn=await db.getConnection();
    try{await conn.beginTransaction();for(const m of items)await addMeeting(conn,id(req),m);await conn.commit();}
    catch(e){await conn.rollback();throw e;}finally{conn.release();}
    res.status(201).json({message:`Added ${items.length} class meeting(s) to the calendar.`});
  }));

  // Credit and level checks are advisory; courses mentioned as foundations may not count.
  app.get('/api/audit',auth,safe(async(req,res)=>{
    const [plans]=await db.execute('SELECT track,degree_level,program FROM degree_preferences WHERE user_id=?',[id(req)]);
    const [courses]=await db.execute('SELECT code,title,credits,semester,status FROM courses WHERE user_id=?',[id(req)]);
    const [setting]=await db.execute('SELECT target_credits FROM degree_settings WHERE user_id=?',[id(req)]);
    const pref=plans[0]||{track:'Course-only',degree_level:'Masters',program:'Computer Science'};
    const rules={
      'Course-only':{maximum6000:4,minimum8000:5,required:'CSC 8901 (1 credit)'},
      'Project':{maximum6000:3,minimum8000:4,required:'CSC 8930 (4 project credits)'},
      'Thesis':{maximum6000:2,minimum8000:4,required:'CSC 8999 (6 thesis credits)'}
    };
    const completed=courses.filter(c=>c.status==='completed' && (!c.grade || ['A','A+','A-','B','B+'].includes(String(c.grade).toUpperCase())));
    const foundation=new Set(FOUNDATION_CODES.map(x=>x.replace(/[^A-Z0-9]/g,'')));
    const eligible=completed.filter(c=>!foundation.has(String(c.code).toUpperCase().replace(/[^A-Z0-9]/g,'')));
    const total=eligible.reduce((v,c)=>v+Number(c.credits||0),0);
    const [docs]=await db.execute('SELECT extracted_text FROM uploaded_handbooks WHERE user_id=?',[id(req)]);
    const verified=docs.find(d=>recognizeHandbook(d.extracted_text));
    const handbookRules=verified?recognizeHandbook(verified.extracted_text):null;
    const target=handbookRules?(pref.degree_level==='PhD'?72:31):(setting[0]?.target_credits??null);
    const getLevel=c=>Number((c.code.match(/\b(\d{4})/)||[])[1]||0);
    const all6000=eligible.filter(c=>getLevel(c)>=6000&&getLevel(c)<7000).length;
    const all8000=eligible.filter(c=>getLevel(c)>=8000&&getLevel(c)<9000&&!['CSC8901','CSC8930','CSC8999'].includes(String(c.code).toUpperCase().replace(/[^A-Z0-9]/g,''))).length;
    const isCS=pref.degree_level==='Masters'&&/computer science/i.test(pref.program);
    const possiblyFoundation=completed.filter(c=>FOUNDATION_CODES.includes(String(c.code).toUpperCase().replace(/\s+/g,' ')));
    res.json({preferences:pref,creditTarget:target,completedCredits:total,remainingCredits:target===null?null:Math.max(0,target-total),
      possibleFoundation:possiblyFoundation.map(c=>c.code),
      totalCreditQualification:handbookRules&&pref.degree_level==='Masters'?'31-hour published minimum for CS bachelor holders; 56 hours for students without a CS bachelor; verify individual applicability.':null,
      count6000:all6000,count8000:all8000,rules:isCS&&handbookRules?rules[pref.track]||null:null,
      handbookRecognized:!!handbookRules,source:handbookRules?'GSU CS Graduate Handbook, section 3':null,
      note:'Advisory planning only. These numbers are based on self-entered statuses; foundation courses, unverified grades, repeats, waivers, and advisor-approved exceptions require review.'});
  }));
  return initializeExtras;
}
module.exports={setupExtras};
