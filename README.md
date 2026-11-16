# DegreePath — Final Web Programming Project

**A full-stack personal academic planner** using Node.js, Express, MySQL, HTML, CSS and JavaScript. Built for the CSC 4370/6370 final project.

## What this version does

- **12 distinct pages:** Login, Register, Dashboard, My Courses, Semester Planner, Requirements, Profile, GSU CSC Course Catalog, Handbook Manager, Class Calendar, Program & Track Comparison, and Degree Check.
- **Secure account sessions:** register, log in, display username, log out. The login cookie is a browser-session cookie (no explicit persistent expiry).
- **Protected data and pages:** unauthorized requests for personal pages redirect to login; unauthorized JSON API calls return **401**. Personal records are always filtered by the session's `user_id`.
- **CRUD:** add, list/read, edit, and delete courses; also CRUD personal requirements. Profile and degree preferences can be updated.
- **Catalog:** **109** GSU CSC course codes and titles supplied by the student, imported into MySQL automatically. Credits, prerequisites, professors and section offerings are **not fabricated**; these fields are blank unless confirmed.
- **Planner:** classes per semester, status (Planned/In progress/Completed), grade, credits, personal requirements and progress totals.
- **Degree options:** university/program/degree level, course-only/project/thesis/research, graduation target, and primary handbook selection. CS master's track overview and advisory 6000/8000-level counts.
- **Handbook Manager:** multiple text-readable PDF uploads, extracted text review, selection as primary and deletion. Older stored PDF text from the existing project is imported when available.
- **Class Calendar:** manual meetings, day-of-week grid, collision warnings, optional professor/classroom, CSV schedule upload and PDF text extraction for manual review.
- **Data migration:** automatically detects and imports the earlier `student_planned_courses`, `student_degree_plans`, `handbook_documents`/`handbook_pages` records without dropping the originals. Missing legacy credits are imported as zero rather than guessed. Migration is tracked to avoid repeat imports.

> DegreePath is an **advisory student planning tool**, not an official degree audit. A course appearing in the university catalog does not mean it is offered this semester, fits a student's degree, satisfies a prerequisite, or has a particular professor. Automatic prerequisite checking and precise official degree approval require additional verified university data.

## Install in the EXISTING GitHub Codespace

**Do not delete your MySQL container, data volume, users table, or repository.** Back up the previous code first:

```bash
cd /workspaces/DegreePath-Academic-Planner
mkdir -p /tmp/degreepath-code-backup
cp -a backend /tmp/degreepath-code-backup/backend-before-final
```

Upload `DegreePath-Final.zip` using Codespaces Explorer > right-click workspace root > Upload, or drag the ZIP into the Explorer. Open a terminal in the repo root:

```bash
cd /workspaces/DegreePath-Academic-Planner
unzip -o DegreePath-Final.zip
cd backend
npm install
```

This archive contains a **backend/** folder and this README. It overwrites **code files**, not your existing MySQL database. Don't delete the old Git history.

### Database / server startup

```bash
docker start degreepath-mysql
cd /workspaces/DegreePath-Academic-Planner/backend
read -s -p 'MySQL application password: ' DB_PASSWORD; echo
export DB_PASSWORD
export SESSION_SECRET="$(openssl rand -hex 32)"
npm run check
node server.js
```

Use your actual `degreepath_app` password; never commit it. Server port is 3000; open the Codespaces forwarded port. **The first run creates the additional tables and imports the 109-course catalog**. It also attempts to import older plan/handbook records if present. Existing database rows remain.

If the database user cannot create the additional tables, give it CREATE permission using your existing MySQL administrative account; do not delete or recreate the database.

### Pages

- `/login.html` (public)
- `/register.html` (public)
- `/dashboard.html` (protected)
- `/courses.html` (protected; full CRUD)
- `/planner.html` (protected; courses organized by semester)
- `/requirements.html` (protected; full CRUD)
- `/profile.html` (protected)
- `/catalog.html` (protected; 109 CSC courses)
- `/handbooks.html` (protected; PDF uploads)
- `/schedule.html` (protected; weekly class calendar)
- `/compare.html` (protected; program / degree track preferences)
- `/audit.html` (protected; advisory degree progress)

## Video demo walkthrough — professor's exact required proof

1. Open `/login.html`, then `/register.html`; explain the public pages.
2. Log in with your real account; show your **username** at the top/sidebar.
3. Open `/courses.html`; **Create** a course, e.g. `CSC 6370`, Web Programming, 3 credits, Fall 2026.
4. **Read:** show the course listed and persisted after page refresh.
5. **Update:** Edit course, change semester or status; save and refresh.
6. **Delete:** Remove the course; confirm it disappears, including after refresh.
7. Show other pages: Semester Planner, Requirements, CSC Catalog (109 entries), Handbook Manager, Calendar, Degree Check, Profile.
8. Click **Log out**. Visit `/courses.html` directly: it should redirect to login.
9. Use Chrome Developer Tools > Console on a logged-out site. Enter this API test (it must return **401**):

   ```js
   fetch('/api/courses', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'CSC 6370',title:'Not allowed',credits:3,semester:'Fall 2026',status:'planned'})}).then(r=>console.log('POST status:',r.status))
   ```

10. Repeat with `PUT /api/courses/1` and `DELETE /api/courses/1` while logged out; each should return **401**. Because you are logged out, these will not modify anything.
11. Explain the database (MySQL), CSS styles, JavaScript, account-specific records, session/logout and protected pages.

The browser-session cookie is designed to end when the browser session closes; browsers with session restore may restore cookies. Logout actively destroys the session and is the most reliable demo.

## Code structure

- `backend/server.js`: existing account system + authenticated course/requirements CRUD and profile
- `backend/extras.js`: catalog, handbook, schedule, program preferences and degree checks
- `backend/gsu_cs_catalog.csv`: all 109 catalog courses
- `backend/public/app.js`: dashboard, course editor, semester planner, requirements editor
- `backend/public/extras-client.js`: catalog, handbook, schedule, comparison, degree check
- `backend/public/style.css`: shared styling
- `backend/sql/01_degreepath_features.sql`: reference migration, but **tables are auto-created** at server startup

### Limitations and data provenance

- Course credits, descriptions, prerequisites and professor listings are not included in the supplied 109-title list. They are intentionally not invented. Instructors and days entered on the calendar are student-provided, not live Georgia State scheduling data.
- Graduate CS track rules are **advisory** and apply only to GSU Master's Computer Science. Foundation course credit, repeat policies, advisor approvals and exceptions are not automatically audited.
- PDF schedule uploads extract readable text to review; they do not automatically infer meeting times from arbitrary layouts. CSV upload uses explicit columns.
- The local class-demo session store is Express MemoryStore; production deployment would require a persistent session store, HTTPS and additional security hardening.
- Initial database creation and CRUD operations require a running MySQL service; JavaScript syntax checks alone do not establish successful DB integration.


## Automatic degree rule detection (handbook-driven update)
When a user uploads the GSU Computer Science Graduate Handbook, DegreePath recognizes it and displays the M.S. course-only/project/thesis constraints without asking for a manual required-credit total. The M.S. total is **not stated in this handbook text**, and DegreePath explicitly marks it as not verified rather than defaulting to 36. For the Ph.D., the handbook identifies 72 credits (48 courses + 24 dissertation). Selecting a personal pathway and providing a class schedule/transcript remain necessary because a handbook does not contain individual student information. Degree checks are advisory and need advisor verification.


## Auto-detect degree requirements from an uploaded handbook

Open **Handbooks**, upload a text-based academic handbook PDF, and select **Primary handbook**. The upload updates the recognized program and degree rules used by Dashboard, Profile, Requirements, and Degree Check. A secondary handbook is saved for comparison. Existing handbooks may be chosen as primary using **Use as primary**. Refresh the dashboard after changing sources.

For the recognized GSU CS graduate handbook, the app loads the documented track limits (Course-only / Project / Thesis), minimum B grade, and special-course requirements. The published **31 semester hour minimum for CS bachelors holders / 56 for applicants without CS backgrounds** is separately sourced from https://www.gsu.edu/program/computer-science-ms/ (not from the PDF). PhD handbook credits: 72 total, 48 coursework and 24 dissertation. Students still need to choose their track and provide their actual course history, since a handbook cannot know those facts. Unrecognized PDFs show candidate credit statements for review rather than applying guessed requirements. PDF must contain selectable text.

This is an **advisory** tool: a handbook does not verify completed student coursework or university-approved exceptions. A foundation-course code may overlap with regular course codes; the app flags those for advisor review instead of blindly counting them.

## November 16 fixes — calendar uploads, compare paths, and degree check

This package fixes three companion-page issues in the previous release:

- **Class Calendar**: the missing upload and manual meeting forms are now displayed. Upload PNG/JPG/WEBP screenshots or selectable-text PDFs. Image uploads use `tesseract.js` OCR (the English language model may need to download on first use). The app proposes meeting records, asks the student to confirm day/time, then saves them to MySQL. Explicit-column CSV schedules import directly. Extraction depends on the upload's layout and image quality; the app does not invent missing instructor names or meeting times.
- **Compare Paths**: compare your saved track to an alternative (course-only, project, or thesis) using your recorded completed courses, course levels, and special-course requirements. This is an advisory comparison, not a confirmed university transfer/degree equivalency. A comparison does not change your track unless you save preferences.
- **Degree Check**: missing HTML element repaired (`auditRules`), and grade/foundation filtering improved. B-minus is not counted as meeting the handbook's minimum B requirement.

**Installation**: Back up the existing repository first. Unzip over the existing project root; do not delete MySQL or its Docker volume. From `backend`, run `npm install` (needed to get OCR dependency), `npm run check`, and `node server.js` with `DB_PASSWORD` and `SESSION_SECRET` environment variables already set. The course catalog CSV is still included.

**Demo checklist**: Log in; create, read, edit and delete a course; log out and show unauthenticated endpoints return HTTP 401; upload a handbook; compare tracks; upload a schedule and review imported meetings; verify calendar displays and warnings; confirm the degree-check rules. We haven't tested this code against your existing database; runtime compatibility remains to be verified in Codespaces.
