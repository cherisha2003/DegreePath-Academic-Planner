
const express = require("express");

// Academic planning API, separate from login and PDF upload.
function createPlannerRouter(db) {
    const router = express.Router();

    const asyncRoute = fn => (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };

    const userId = req => req.session.user.user_id;

    // Normalize course codes for comparison.
    function normalizeCode(code) {
        return String(code || "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "");
    }

    // Extract possible courses from PDF page text.
    // These MUST be confirmed against the university catalog.
    function findCourseCandidates(pages) {
        const found = new Map();
        const pattern = /\b([A-Z]{2,6})\s*[- ]?\s*(\d{4}[A-Z]?)\b/g;

        for (const page of pages) {
            const lines = String(page.extracted_text || "").split("\n");

            for (const line of lines) {
                pattern.lastIndex = 0;
                let match;

                while ((match = pattern.exec(line)) !== null) {
                    const code = match[1] + " " + match[2];
                    const normalized = normalizeCode(code);

                    if (!found.has(normalized)) {
                        const description = line
                            .slice(match.index + match[0].length)
                            .replace(/^[\s:;,.–—-]+/, "")
                            .trim();

                        found.set(normalized, {
                            code,
                            title: description.slice(0, 120),
                            page: page.page_number,
                            normalized,
                            verified: false
                        });
                    }
                }
            }
        }

        return [...found.values()].slice(0, 250);
    }

    // Suggest a possible program from source text.
    // The student must confirm or correct this suggestion.
    function detectProgram(filename, pages) {
        const text = (
            filename + " " +
            pages.slice(0, 3)
                .map(p => p.extracted_text)
                .join(" ")
        ).toLowerCase();

        if (/computer science/.test(text)) {
            if (/\bph\.?\s*d\b|doctoral/.test(text)) {
                return "Computer Science";
            }
            return "Computer Science";
        }

        if (/\bnursing\b/.test(text)) {
            return "Nursing";
        }

        if (/information technology/.test(text)) {
            return "Information Technology";
        }

        return "";
    }

    // Find which degree-track names are mentioned in the PDF.
    function detectTracks(pages) {
        const text = pages.map(p => p.extracted_text)
            .join(" ").toLowerCase();

        const tracks = [];

        if (/course.only|coursework.only|non.thesis/.test(text)) {
            tracks.push("Course-only");
        }
        if (/\bproject\b/.test(text)) {
            tracks.push("Project");
        }
        if (/\bthesis\b/.test(text)) {
            tracks.push("Thesis");
        }

        return tracks;
    }

    async function getPages(documentId) {
        const [pages] = await db.execute(`
            SELECT page_number, extracted_text
            FROM handbook_pages
            WHERE document_id = ?
            ORDER BY page_number
        `, [documentId]);

        return pages;
    }

    // Create persistent tables without changing existing user data.
    async function initializePlannerTables() {
        await db.query(`
            CREATE TABLE IF NOT EXISTS student_degree_plans (
                user_id INT PRIMARY KEY,
                primary_document_id INT NOT NULL,
                program_name VARCHAR(120) NOT NULL,
                degree_level VARCHAR(30) NOT NULL,
                degree_track VARCHAR(60) NOT NULL,
                graduation_term VARCHAR(40) NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS student_planned_courses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                source_document_id INT NULL,
                course_code VARCHAR(30) NOT NULL,
                course_title VARCHAR(150) NOT NULL DEFAULT '',
                credits DECIMAL(4,1) NULL,
                semester VARCHAR(40) NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'Planned',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_student_courses (user_id)
            )
        `);
    }

    // Main endpoint: return the current student's planning state.
    router.get("/state", asyncRoute(async (req, res) => {
        const uid = userId(req);

        const [documents] = await db.execute(`
            SELECT document_id, filename, total_pages
            FROM handbook_documents
            WHERE user_id = ?
            ORDER BY uploaded_at DESC, document_id DESC
        `, [uid]);

        const [plans] = await db.execute(`
            SELECT * FROM student_degree_plans
            WHERE user_id = ?
        `, [uid]);

        const [courses] = await db.execute(`
            SELECT * FROM student_planned_courses
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
        `, [uid]);

        const plan = plans[0] || null;

        // Read the primary source document for program suggestions.
        const chosen = documents.find(d =>
            d.document_id === plan?.primary_document_id
        ) || documents[0];

        let candidates = [];
        let suggestedProgram = "";
        let suggestedTracks = [];

        if (chosen) {
            const pages = await getPages(chosen.document_id);
            candidates = findCourseCandidates(pages);
            suggestedProgram = detectProgram(chosen.filename, pages);
            suggestedTracks = detectTracks(pages);
        }

        // Compare matching course codes with secondary documents.
        const comparisons = [];

        if (chosen && plan) {
            const primaryCodes = new Set(
                candidates.map(c => c.normalized)
            );

            for (const doc of documents) {
                if (doc.document_id === plan.primary_document_id) {
                    continue;
                }

                const pages = await getPages(doc.document_id);
                const secondaryCourses = findCourseCandidates(pages);

                const common = secondaryCourses.filter(c =>
                    primaryCodes.has(c.normalized)
                );

                comparisons.push({
                    document_id: doc.document_id,
                    filename: doc.filename,
                    common_courses: common,
                    note: "Code matches only; degree applicability is unverified."
                });
            }
        }

        res.json({
            setup_complete: Boolean(
                plan && documents.some(d =>
                    d.document_id === plan.primary_document_id
                )
            ),
            plan,
            documents,
            courses,
            candidates,
            suggested_program: suggestedProgram,
            suggested_tracks: suggestedTracks,
            comparisons,
            selected_document_id: chosen?.document_id || null
        });
    }));

    // Save personalized onboarding answers.
    router.post("/setup", asyncRoute(async (req, res) => {
        const uid = userId(req);

        const documentId = Number(req.body.primary_document_id);
        const program = String(req.body.program_name || "").trim();
        const level = String(req.body.degree_level || "").trim();
        const track = String(req.body.degree_track || "").trim();
        const graduation = String(req.body.graduation_term || "").trim();

        if (!Number.isSafeInteger(documentId) || documentId <= 0 ||
            !program || program.length > 120 ||
            !["Associate", "Bachelor's", "Master's", "Doctoral"]
                .includes(level) ||
            !track || track.length > 60 ||
            !graduation || graduation.length > 40) {
            return res.status(400).json({
                error: "Please complete all degree setup questions."
            });
        }

        // Prevent selecting someone else's uploaded handbook.
        const [owned] = await db.execute(`
            SELECT document_id FROM handbook_documents
            WHERE document_id = ? AND user_id = ?
        `, [documentId, uid]);

        if (!owned.length) {
            return res.status(404).json({
                error: "The selected handbook was not found."
            });
        }

        await db.execute(`
            INSERT INTO student_degree_plans
            (user_id, primary_document_id, program_name,
             degree_level, degree_track, graduation_term)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                primary_document_id = VALUES(primary_document_id),
                program_name = VALUES(program_name),
                degree_level = VALUES(degree_level),
                degree_track = VALUES(degree_track),
                graduation_term = VALUES(graduation_term)
        `, [
            uid, documentId, program, level, track, graduation
        ]);

        res.json({ message: "Your personalized degree plan was saved." });
    }));

    // Add a course to the semester plan.
    router.post("/courses", asyncRoute(async (req, res) => {
        const uid = userId(req);
        const code = String(req.body.course_code || "")
            .trim().toUpperCase();
        const title = String(req.body.course_title || "").trim();
        const semester = String(req.body.semester || "").trim();
        const status = String(req.body.status || "Planned");
        const credits = req.body.credits === "" ||
            req.body.credits == null
            ? null : Number(req.body.credits);

        const sourceId = req.body.source_document_id
            ? Number(req.body.source_document_id)
            : null;

        if (!/^[A-Z]{2,8}\s*-?\s*\d{3,5}[A-Z]?$/.test(code) ||
            title.length > 150 ||
            !semester || semester.length > 40 ||
            !["Planned", "In Progress", "Completed"].includes(status) ||
            (credits !== null && (
                !Number.isFinite(credits) ||
                credits < 0 || credits > 12
            ))) {
            return res.status(400).json({
                error: "Please enter valid course information."
            });
        }

        if (sourceId !== null) {
            if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
                return res.status(400).json({
                    error: "Invalid source document."
                });
            }

            const [owned] = await db.execute(`
                SELECT document_id FROM handbook_documents
                WHERE document_id = ? AND user_id = ?
            `, [sourceId, uid]);

            if (!owned.length) {
                return res.status(404).json({
                    error: "Source handbook not found."
                });
            }
        }

        await db.execute(`
            INSERT INTO student_planned_courses
            (user_id, source_document_id, course_code,
             course_title, credits, semester, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [uid, sourceId, code, title, credits, semester, status]);

        res.status(201).json({ message: "Course added to your plan." });
    }));

    // Delete one course belonging to the logged-in student.
    router.delete("/courses/:id", asyncRoute(async (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ error: "Invalid course ID." });
        }

        const [result] = await db.execute(`
            DELETE FROM student_planned_courses
            WHERE id = ? AND user_id = ?
        `, [id, userId(req)]);

        if (!result.affectedRows) {
            return res.status(404).json({ error: "Course not found." });
        }

        res.json({ message: "Course removed." });
    }));

    return { router, initializePlannerTables };
}

module.exports = { createPlannerRouter };
